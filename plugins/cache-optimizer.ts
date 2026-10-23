/**
 * Cache Optimizer (OpenCode V2)
 *
 * Port of the cache-relevant capabilities of
 * https://github.com/jiangge/pi-cache-optimizer to the OpenCode V2 plugin API.
 * The original targets Pi; three of its features have no native V2 equivalent
 * and are reimplemented here:
 *
 *   1. Prompt/skill compression (append-only)
 *      OpenCode renders every available skill into the system prompt as an
 *      indented XML block (~4 lines per skill). This plugin rewrites each
 *      block to one line, keeping the id, the name and the full description
 *      verbatim, so triggering behaviour is unchanged while the stable prefix
 *      shrinks.
 *
 *      Ordering and growth are deterministic and cache-safe, following
 *      pi-cache-optimizer's prompt-sorting rules:
 *        - ids are ordered by exact UTF-16 code units (never localeCompare,
 *          whose result varies with the host locale)
 *        - the first sighting seals the block; afterwards it is append-only.
 *          When OpenCode loads skills dynamically ("New skills are available
 *          in addition to those previously listed:"), the already-sent lines
 *          are reused byte-for-byte and only new skills are appended, so the
 *          cacheable prefix is never rewritten.
 *        - a removed skill is logged and kept by default (prefix stability);
 *          `skillRemovalPolicy: "rerender"` drops it and pays the prefix reset.
 *        - compression only fires at >= skillCompressionMinCount visible
 *          skills, and never fires on a block it cannot parse.
 *
 *   2. Generic cache key + session-affinity headers
 *      V2 derives `prompt_cache_key` from the session id, but only for known
 *      providers and only when the provider option `setCacheKey` is true
 *      (default false). This plugin fills `prompt_cache_key` on any
 *      OpenAI-compatible `/chat/completions` payload where the field is
 *      absent, and adds session-affinity headers so proxies route a session
 *      to the same backend. It never overwrites a key the app already set.
 *      If a provider rejects the injected key with HTTP 400 the plugin
 *      disables injection for that provider for the rest of the process.
 *
 *   3. Prefix-stability insurance
 *      A cache hit requires a byte-identical stable prefix. This plugin keeps
 *      the tool set in a deterministic order and fingerprints the outgoing
 *      system prompt per session. When the prefix changes for a reason other
 *      than new user content it logs which system part changed, so a silent
 *      cache buster is visible in the logs.
 *      The tool set is independently fingerprinted as it leaves the process
 *      (in `http.request`, after every `context` hook), so a sibling plugin
 *      that adds or removes a tool later — opencode-dcp drops its `compress`
 *      tool for sub-agents and when compression is denied — is still reported.
 *
 * Install: drop into ~/.config/opencode/plugins/ (auto-discovered).
 * Config:  optional JSON at ~/.config/opencode/cache-optimizer.json, or the
 *          `options` object when the plugin is listed in opencode.json.
 * Env opt-outs (all default off):
 *   CACHE_OPTIMIZER_NO_PROMPT_REWRITE=1   disable skill compression
 *   CACHE_OPTIMIZER_NO_SKILL_COMPRESSION=1 same as above
 *   CACHE_OPTIMIZER_NO_TOOL_ORDER=1       keep native tool order
 *   CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY=1 do not inject prompt_cache_key
 *   CACHE_OPTIMIZER_NO_AFFINITY=1         do not add affinity headers
 *   CACHE_OPTIMIZER_NO_PREFIX_WARN=1      disable prefix-change logging
 *   CACHE_OPTIMIZER_CACHE_RETENTION=long  set prompt_cache_retention
 *   CACHE_OPTIMIZER_PROVIDERS_DENY=a,b    never touch these providers
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const TAG = "cache-optimizer";

interface Options {
	/** Rewrite the skill list in the system prompt to one line per skill. */
	compactSkillGuidance: boolean;
	/** Minimum visible skills before compressing; below this the XML form is kept. */
	skillCompressionMinCount: number;
	/**
	 * What to do when a skill disappears mid-session.
	 *  - "keep"     keep the already-emitted line (cache prefix stays intact)
	 *  - "rerender" drop it and re-render (prefix breaks; correctness first)
	 */
	skillRemovalPolicy: "keep" | "rerender";
	/** Rebuild the tool map in a stable, sorted order. */
	deterministicToolOrder: boolean;
	/** Log when the cacheable prefix changes mid-session. */
	warnOnPrefixChange: boolean;
	/** Inject `prompt_cache_key` into OpenAI-compatible payloads when absent. */
	promptCacheKey: boolean;
	/** Header names to carry the session affinity value, when absent. */
	affinityHeaders: string[];
	/** Value for `prompt_cache_retention` when set (e.g. "long"). */
	promptCacheRetention: string | null;
	/** If non-empty, only these providers are touched. */
	providersAllow: string[];
	/** These providers are never touched. */
	providersDeny: string[];
}

const DEFAULTS: Options = {
	compactSkillGuidance: true,
	skillCompressionMinCount: 4,
	skillRemovalPolicy: "keep",
	deterministicToolOrder: true,
	warnOnPrefixChange: true,
	promptCacheKey: true,
	affinityHeaders: ["x-session-id", "conversation_id"],
	promptCacheRetention: null,
	providersAllow: [],
	providersDeny: [],
};

function warn(message: string): void {
	try {
		console.warn(`[${TAG}] ${message}`);
	} catch {
		/* logging must never break a request */
	}
}

function info(message: string): void {
	try {
		console.info(`[${TAG}] ${message}`);
	} catch {
		/* logging must never break a request */
	}
}

const reported = new Set<string>();

/** Report a given failure only once, so a broken hook cannot spam the log. */
function warnOnce(label: string, error: unknown): void {
	const message = `${label}: ${messageOf(error)}`;
	if (reported.has(message)) return;
	reported.add(message);
	warn(message);
}

/** Wrap a hook body so a plugin fault can never fail the model request. */
function guarded<Input>(label: string, body: (input: Input) => void | Promise<void>): (input: Input) => Promise<void> {
	return async (input: Input) => {
		try {
			await body(input);
		} catch (error) {
			warnOnce(label, error);
		}
	};
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Directory of this plugin file, used to locate the optional config file. */
function pluginDir(): string {
	try {
		return path.dirname(fileURLToPath(import.meta.url));
	} catch {
		return process.cwd();
	}
}

function configPaths(): string[] {
	const here = pluginDir();
	return [path.join(here, "cache-optimizer.json"), path.join(here, "..", "cache-optimizer.json")];
}

function readConfigFile(): Partial<Options> {
	for (const candidate of configPaths()) {
		try {
			if (!fs.existsSync(candidate)) continue;
			const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Partial<Options>;
			}
		} catch (error) {
			warn(`ignoring invalid config ${candidate}: ${messageOf(error)}`);
		}
	}
	return {};
}

function envFlag(name: string): boolean {
	const value = process.env[name];
	return value === "1" || value === "true" || value === "yes";
}

function envList(name: string): string[] {
	const value = process.env[name];
	if (!value) return [];
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function resolveOptions(pluginOptions: unknown): Options {
	const fromFile = readConfigFile();
	const fromConfig =
		pluginOptions && typeof pluginOptions === "object" && !Array.isArray(pluginOptions)
			? (pluginOptions as Partial<Options>)
			: {};
	const options: Options = { ...DEFAULTS, ...fromFile, ...fromConfig };

	if (envFlag("CACHE_OPTIMIZER_NO_PROMPT_REWRITE") || envFlag("CACHE_OPTIMIZER_NO_SKILL_COMPRESSION")) {
		options.compactSkillGuidance = false;
	}
	if (envFlag("CACHE_OPTIMIZER_NO_TOOL_ORDER")) options.deterministicToolOrder = false;
	if (envFlag("CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY")) options.promptCacheKey = false;
	if (envFlag("CACHE_OPTIMIZER_NO_AFFINITY")) options.affinityHeaders = [];
	if (envFlag("CACHE_OPTIMIZER_NO_PREFIX_WARN")) options.warnOnPrefixChange = false;

	const retention = process.env.CACHE_OPTIMIZER_CACHE_RETENTION;
	if (retention) options.promptCacheRetention = retention;

	const deny = envList("CACHE_OPTIMIZER_PROVIDERS_DENY");
	if (deny.length > 0) options.providersDeny = deny;

	if (!Array.isArray(options.affinityHeaders)) options.affinityHeaders = [];
	if (!Array.isArray(options.providersAllow)) options.providersAllow = [];
	if (!Array.isArray(options.providersDeny)) options.providersDeny = [];
	if (!Number.isFinite(options.skillCompressionMinCount) || options.skillCompressionMinCount < 1) {
		options.skillCompressionMinCount = DEFAULTS.skillCompressionMinCount;
	}
	if (options.skillRemovalPolicy !== "rerender") options.skillRemovalPolicy = "keep";

	return options;
}

// --- fingerprinting ---------------------------------------------------------

function fnv1a(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Cheap, stable digest. Not cryptographic; only used for change detection. */
function fingerprint(input: string): string {
	return fnv1a(input) + fnv1a(`a${input}`) + fnv1a(`b${input}`) + fnv1a(`c${input}`);
}

function shortID(id: string): string {
	return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

// --- 1. prompt / skill compression ------------------------------------------

/**
 * Minimum visible skills before compression is worth it. Mirrors the source
 * project (pi-cache-optimizer): below this the verbose XML block is small
 * enough that the extra index line is not worth losing per-skill hints.
 */
export const SKILL_COMPRESSION_MIN_COUNT = 4;

const SKILL_BLOCK_VERBOSE =
	/<skill>\s*<id>([\s\S]*?)<\/id>\s*<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>\s*<\/skill>/g;
const SKILL_BLOCK_COMPACT = /<skill\s+id="([^"]*)"\s+name="([^"]*)">([\s\S]*?)<\/skill>/g;

/**
 * Exact UTF-16 code-unit ordering. Mirrors pi-cache-optimizer's
 * `compareToolOrderEntries`: localeCompare is deliberately avoided because its
 * result can vary with the host locale, which would make the emitted prefix
 * machine-dependent instead of byte-identical.
 */
function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

interface SkillEntry {
	id: string;
	name: string;
	description: string;
}

interface SkillSection {
	before: string;
	after: string;
	entries: SkillEntry[];
}

/** Parse an `<available_skills>` block in either the verbose or compact form. */
function parseSkillSection(text: string): SkillSection | undefined {
	const verbose = text.includes("<skill>");
	const pattern = verbose ? SKILL_BLOCK_VERBOSE : SKILL_BLOCK_COMPACT;
	const first = verbose ? text.indexOf("<skill>") : text.search(/<skill\s+id=/);
	if (first === -1) return undefined;

	const entries: SkillEntry[] = [];
	pattern.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		const id = (match[1] ?? match[2] ?? "").trim();
		const name = (match[2] ?? "").trim();
		const description = (match[3] ?? "").replace(/\s+/g, " ").trim();
		if (!name) continue;
		entries.push({ id: id || name, name, description });
	}
	if (entries.length === 0) return undefined;

	const close = text.indexOf("</available_skills>");
	return {
		before: text.slice(0, first).replace(/[ \t]*$/, ""),
		after: close === -1 ? "" : `\n${text.slice(close)}`,
		entries,
	};
}

function renderSkillLine(entry: SkillEntry): string {
	return `  <skill id="${entry.id}" name="${entry.name}">${entry.description}</skill>`;
}

/**
 * Collapse each `<skill>…</skill>` block to one line:
 *   <skill id="X" name="Y">full description</skill>
 * The id, name and description are preserved verbatim; only the envelope
 * whitespace is removed. Pure and order-preserving.
 */
function compactSkillGuidance(text: string): string {
	if (!text.includes("<skill>")) return text;
	return text.replace(SKILL_BLOCK_VERBOSE, (_match, id: string, name: string, description: string) => {
		return `<skill id="${id.trim()}" name="${name.trim()}">${description.replace(/\s+/g, " ").trim()}</skill>`;
	});
}

/**
 * Per-session skill index. Once sealed the block is append-only: bytes already
 * sent to the provider are reused verbatim and only newly discovered skills are
 * appended. That is what keeps the cacheable prefix intact when OpenCode loads
 * skills dynamically (the "New skills are available in addition to those
 * previously listed:" delta).
 */
interface SkillIndex {
	before: string;
	after: string;
	order: string[];
	lines: Map<string, string>;
	removed: Set<string>;
}

const skillIndices = new Map<string, SkillIndex>();

function skillIndexText(index: SkillIndex, liveAfter?: string): string {
	return index.before + index.order.map((id) => index.lines.get(id) ?? "").join("\n") + tailFor(index, liveAfter);
}

const CLOSE_TAG = "</available_skills>";

/**
 * The tail is split at the closing tag. The sealed part up to and including the
 * tag is reused verbatim (this is what re-emits the wrapper when OpenCode sends
 * the `New skills are available…` delta form without it), while anything the
 * incoming text carries *after* the tag is adopted live. That keeps the emitted
 * prefix byte-stable without masking a sibling plugin's suffix — opencode-dcp
 * appends its prompt to the last system part, and a frozen tail would pin it.
 */
function tailFor(index: SkillIndex, liveAfter?: string): string {
	if (liveAfter === undefined) return index.after;
	const liveClose = liveAfter.indexOf(CLOSE_TAG);
	if (liveClose === -1) return index.after;
	const frozenClose = index.after.indexOf(CLOSE_TAG);
	if (frozenClose === -1) return liveAfter;
	const structural = index.after.slice(0, frozenClose + CLOSE_TAG.length);
	return structural + liveAfter.slice(liveClose + CLOSE_TAG.length);
}

function sealedSkillIndex(section: SkillSection): SkillIndex {
	const index: SkillIndex = {
		before: section.before,
		after: section.after,
		order: [],
		lines: new Map(),
		removed: new Set(),
	};
	for (const entry of [...section.entries].sort((a, b) => compareText(a.id, b.id))) {
		index.order.push(entry.id);
		index.lines.set(entry.id, renderSkillLine(entry));
	}
	return index;
}

/**
 * Rewrite the skill section of the outgoing system prompt.
 *
 * First sight: entries are sorted by exact code-unit id and sealed.
 * Later sights: known ids keep their previously emitted line, new ids are
 * appended in sorted order, and the earlier bytes never change. Removals are
 * logged and, by default, ignored so the prefix stays byte-identical;
 * `skillRemovalPolicy: "rerender"` opts out and pays the prefix reset.
 */
function applySkillIndex(sessionID: string, text: string, options: Options): string {
	const section = parseSkillSection(text);
	if (!section) return text;

	const index = skillIndices.get(sessionID);
	if (!index) {
		if (section.entries.length < options.skillCompressionMinCount) return text;
		const sealed = sealedSkillIndex(section);
		skillIndices.set(sessionID, sealed);
		return skillIndexText(sealed);
	}

	const incoming = new Set(section.entries.map((entry) => entry.id));
	for (const id of index.order) {
		if (incoming.has(id) || index.removed.has(id)) continue;
		index.removed.add(id);
		info(`session ${shortID(sessionID)}: skill ${id} disappeared → keeping the emitted line for prefix stability`);
	}

	if (options.skillRemovalPolicy === "rerender" && index.removed.size > 0) {
		const rebuilt = sealedSkillIndex(section);
		skillIndices.set(sessionID, rebuilt);
		warn(`session ${shortID(sessionID)}: skill list re-rendered after a removal (cache prefix reset)`);
		return skillIndexText(rebuilt, section.after);
	}

	let appended = 0;
	for (const entry of [...section.entries].sort((a, b) => compareText(a.id, b.id))) {
		if (index.lines.has(entry.id)) continue;
		index.order.push(entry.id);
		index.lines.set(entry.id, renderSkillLine(entry));
		appended++;
	}
	if (appended > 0) {
		info(`session ${shortID(sessionID)}: appended ${appended} skill(s) → existing prefix unchanged`);
	}
	return skillIndexText(index, section.after);
}

// --- 3. prefix stability ----------------------------------------------------

interface PrefixRecord {
	hash: string;
	toolsHash: string;
	systemHash: string;
	partHashes: string[];
	partLens: number[];
}

const prefixState = new Map<string, PrefixRecord>();

function systemTexts(system: unknown): string[] {
	if (!Array.isArray(system)) return [];
	return system.map((part) => {
		const text = part && typeof part === "object" ? (part as { text?: unknown }).text : undefined;
		return typeof text === "string" ? text : "";
	});
}

function partHashesOf(texts: string[]): string[] {
	return texts.map((text, index) => `${index}:${fingerprint(text)}`);
}

function checkPrefix(sessionID: string, system: unknown, tools: Record<string, unknown> | undefined): void {
	const texts = systemTexts(system);
	const systemHash = fingerprint(texts.join("\u0000"));
	const toolNames = Object.keys(tools ?? {}).sort();
	const toolsHash = fingerprint(toolNames.join(","));
	const hash = fingerprint(`${systemHash}|${toolsHash}`);
	const record: PrefixRecord = {
		hash,
		toolsHash,
		systemHash,
		partHashes: partHashesOf(texts),
		partLens: texts.map((text) => text.length),
	};

	const previous = prefixState.get(sessionID);
	prefixState.set(sessionID, record);
	if (!previous || previous.hash === hash) return;

	if (previous.toolsHash !== toolsHash) {
		info(`session ${shortID(sessionID)}: tool set changed → cache prefix reset`);
		return;
	}
	if (previous.systemHash === systemHash) return;

	const count = Math.max(previous.partHashes.length, record.partHashes.length);
	for (let index = 0; index < count; index++) {
		if (previous.partHashes[index] !== record.partHashes[index]) {
			const before = previous.partLens[index] ?? 0;
			const after = record.partLens[index] ?? 0;
			info(
				`session ${shortID(sessionID)}: system part #${index} changed (${before} → ${after} chars) → cache prefix after it will miss`,
			);
			return;
		}
	}
	info(`session ${shortID(sessionID)}: system prompt changed → cache prefix reset`);
}

function stableToolOrder(tools: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!tools) return tools;
	const keys = Object.keys(tools);
	const sorted = [...keys].sort(compareText);
	if (keys.join("\u0000") === sorted.join("\u0000")) return tools;
	const rebuilt: Record<string, unknown> = {};
	for (const key of sorted) rebuilt[key] = tools[key];
	return rebuilt;
}

/**
 * Tool names as the provider will see them, read from the serialized request
 * body. OpenAI nests the name under `function.name`, Anthropic and several
 * gateways put `name` at the top level, and Gemini uses `functionDeclarations`.
 * An unrecognised shape yields `undefined` so the check is skipped rather than
 * reporting a false change.
 */
function toolsFromBody(body: any): string[] | undefined {
	const tools = body?.tools ?? body?.functions;
	if (!Array.isArray(tools) || tools.length === 0) return undefined;
	const names: string[] = [];
	const add = (value: unknown) => {
		if (typeof value === "string" && value) names.push(value);
	};
	for (const entry of tools) {
		if (!entry || typeof entry !== "object") continue;
		add(entry.function?.name);
		add(entry.name);
		if (Array.isArray(entry.functionDeclarations)) {
			for (const declaration of entry.functionDeclarations) add(declaration?.name);
		}
	}
	return names.length > 0 ? [...names].sort(compareText) : undefined;
}

const toolPrefixState = new Map<string, string>();

/**
 * Fingerprint the *outgoing* tool set from the serialized request body, in
 * `http.request`. The `context` hook runs before sibling hooks (plugin order),
 * so a plugin that adds or removes a tool afterwards is invisible there —
 * opencode-dcp deletes its `compress` tool for sub-agents and when compression
 * is denied. `http.request` runs after every `context` hook, so this sees the
 * final set. It keeps its own per-session record, so the pre-hook and post-hook
 * sources never double-report the same change.
 */
function checkToolPrefix(sessionID: string, names: string[] | undefined): void {
	if (!names) return;
	const hash = fingerprint(names.join(","));
	const previous = toolPrefixState.get(sessionID);
	toolPrefixState.set(sessionID, hash);
	if (previous !== undefined && previous !== hash) {
		info(`session ${shortID(sessionID)}: outgoing tool set changed → cache prefix reset`);
	}
}

// --- 2. generic cache key + session affinity --------------------------------

const injectedProviders = new Set<string>();
const disabledProviders = new Set<string>();

function providerAllowed(providerID: string, options: Options): boolean {
	if (options.providersDeny.includes(providerID)) return false;
	if (options.providersAllow.length > 0 && !options.providersAllow.includes(providerID)) return false;
	return true;
}

function isOpenAIChatCompletions(url: string): boolean {
	try {
		const pathname = new URL(url).pathname;
		if (!pathname.endsWith("/chat/completions") && pathname !== "/chat/completions") return false;
		if (pathname.includes("/responses")) return false;
		return true;
	} catch {
		return false;
	}
}

/**
 * Stable per-session value. Mirrors the native derivation: the 64 hex digits
 * after `ses_`, otherwise the raw id. Prefixed so it never collides with the
 * native key format on the same provider.
 */
function sessionKey(sessionID: unknown): string {
	const id = typeof sessionID === "string" ? sessionID : "";
	const match = /^ses_([0-9a-f]{64})$/.exec(id);
	if (match) return `oc-${match[1].slice(0, 48)}`;
	return `oc-${fingerprint(id)}`;
}

async function onHttpRequest(event: any, options: Options): Promise<void> {
	const request: Request | undefined = event?.request;
	if (!request || typeof request.url !== "string") return;

	const providerID = String(event?.model?.providerID ?? "");
	if (!providerAllowed(providerID, options)) return;
	if (disabledProviders.has(providerID)) return;

	const isChat = isOpenAIChatCompletions(request.url);
	const wantsFingerprint = options.warnOnPrefixChange && typeof event?.sessionID === "string";
	if (!isChat && !wantsFingerprint) return;

	const contentType = request.headers.get("content-type") ?? "";
	if (!contentType.includes("application/json")) return;

	let body: any;
	try {
		body = JSON.parse(await request.clone().text());
	} catch {
		return;
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) return;

	// The request body is the ground truth of what the provider receives, and
	// this hook runs after every `context` hook, so it is where the outgoing
	// tool set is fingerprinted.
	if (wantsFingerprint) checkToolPrefix(event.sessionID, toolsFromBody(body));

	if (!isChat) return;

	let changed = false;

	if (options.promptCacheKey && body.prompt_cache_key === undefined) {
		body.prompt_cache_key = sessionKey(event?.sessionID);
		changed = true;
		injectedProviders.add(providerID);
	}
	if (options.promptCacheRetention && body.prompt_cache_retention === undefined) {
		body.prompt_cache_retention = options.promptCacheRetention;
		changed = true;
	}

	const headers = new Headers(request.headers);
	for (const name of options.affinityHeaders) {
		if (headers.has(name)) continue;
		headers.set(name, sessionKey(event?.sessionID));
		changed = true;
	}

	if (!changed) return;

	const init: RequestInit = { method: request.method, headers, signal: request.signal };
	if (request.method !== "GET" && request.method !== "HEAD") {
		(init as RequestInit & { body?: string }).body = JSON.stringify(body);
	}

	try {
		event.request = new Request(request.url, init);
	} catch (error) {
		warn(`could not replace request for ${providerID}: ${messageOf(error)}`);
	}
}

function onHttpResponse(event: any): void {
	const providerID = String(event?.model?.providerID ?? "");
	if (event?.response?.status === 400 && injectedProviders.has(providerID)) {
		disabledProviders.add(providerID);
		warn(`provider ${providerID} rejected the injected prompt cache key (HTTP 400); disabled for this process`);
	}
}

// --- wiring -----------------------------------------------------------------

async function register(registrations: any[], register: () => Promise<any>, label: string): Promise<void> {
	try {
		registrations.push(await register());
	} catch (error) {
		warn(`hook ${label} unavailable: ${messageOf(error)}`);
	}
}

const CacheOptimizerPlugin = {
	id: "cache-optimizer",

	async setup(ctx: any) {
		const options = resolveOptions(ctx?.options);
		const registrations: any[] = [];

		await register(registrations, () =>
			ctx.session.hook(
				"context",
				guarded("context", (event: any) => {
					const system = Array.isArray(event.system) ? event.system : undefined;
					if (system && options.compactSkillGuidance) {
						const sessionID = typeof event.sessionID === "string" ? event.sessionID : "";
						for (const part of system) {
							if (!part || typeof part.text !== "string") continue;
							if (!part.text.includes("<skill>")) continue;
							part.text = applySkillIndex(sessionID, part.text, options);
						}
					}
					if (options.deterministicToolOrder && event.tools) {
						const ordered = stableToolOrder(event.tools);
						if (ordered !== event.tools) event.tools = ordered;
					}
					if (options.warnOnPrefixChange && typeof event.sessionID === "string") {
						checkPrefix(event.sessionID, system, event.tools);
					}
				}),
			), "context");

		await register(registrations, () =>
			ctx.session.hook("http.request", guarded("http.request", (event: any) => onHttpRequest(event, options))), "http.request");
		await register(registrations, () =>
			ctx.session.hook("http.response", guarded("http.response", (event: any) => onHttpResponse(event))), "http.response");

		info(
			`enabled: skills=${options.compactSkillGuidance} toolOrder=${options.deterministicToolOrder} ` +
				`cacheKey=${options.promptCacheKey} retention=${options.promptCacheRetention ?? "-"} ` +
				`affinity=${options.affinityHeaders.join("+") || "off"}`,
		);

		return async () => {
			for (const registration of registrations) {
				try {
					await registration?.dispose?.();
				} catch {
					/* best effort */
				}
			}
			prefixState.clear();
			toolPrefixState.clear();
			skillIndices.clear();
		};
	},
};

export default CacheOptimizerPlugin;
export { CacheOptimizerPlugin, applySkillIndex, compactSkillGuidance, parseSkillSection };
