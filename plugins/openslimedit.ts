/**
 * OpenSlimEdit (OpenCode V2 port)
 *
 * Port of https://github.com/ASidorenkoCode/openslimedit from the OpenCode V1
 * plugin API to the OpenCode V2 plugin API. Behaviour is preserved exactly.
 *
 * The original ships three token-saving optimizations:
 *
 *   1. Slim tool descriptions   (V1 `tool.definition`   -> V2 `ctx.tool.transform`)
 *   2. Compact read output      (V1 `tool.execute.after` -> V2 `ctx.tool.hook("execute.after")`)
 *   3. Line-range `oldString`   (V1 `tool.execute.before` -> V2 `ctx.tool.hook("execute.before")`)
 *
 * Install: drop into ~/.config/opencode/plugins/ (auto-discovered).
 * Remove the file to disable.
 *
 * --- V1 -> V2 mapping notes -------------------------------------------------
 *
 * 1. Tool descriptions. V1 mutated `output.description` in the `tool.definition`
 *    hook. V2 exposes a replayable, synchronous editor via `ctx.tool.transform`.
 *    `editor.update(id, fn)` uses the EFFECTIVE tool name; unknown ids are
 *    ignored, so listing V1 and V2 names side by side is safe.
 *
 *    Built-in V2 tool names (verified against the v2.0.29 binary):
 *      read, edit, write, patch, glob, grep, shell, webfetch, websearch,
 *      question, skill, subagent
 *    V1-only names kept for fidelity: apply_patch, bash, list, fetch.
 *    (V2 has no `list` tool, so that entry is a no-op.)
 *
 * 2. Compact read output. V1 stripped `<path>` / `<type>file</type>` /
 *    `(End of file - total N lines)` out of a tagged read result. V2's read
 *    tool emits a different plain-text shape (no tags):
 *      `Read file <path>, lines <a>-<b>` then `<n>: <line>` rows, or
 *      `Read directory <path>, entries <a>-<b>` then one path per row.
 *    So the portable part of the optimization is path relativization: an
 *    absolute path in the header becomes relative to the working directory.
 *    Directory listings are skipped, exactly as V1 skipped them. The three V1
 *    string removals have no V2 counterpart: no type marker and no end-of-file
 *    footer exist in V2.
 *
 *    Result shape. In V2 a successful tool call carries
 *    `result.content` as `string | Array<{type:"text",text} | {type:"file",...}>`.
 *    Built-in tools deliver an ARRAY of text parts (e.g. one
 *    `{type:"text", text:"Read file ..."}` part); images/PDFs add a `file` part.
 *    The hook therefore maps over every `text` part and rewrites the whole
 *    result. Non-text parts are passed through untouched.
 *
 * 3. Line-range `oldString`. V1 read `args.filePath` and expanded a bare line
 *    range such as "55-64" into the real text before the edit ran. V2 renamed
 *    the edit input field `filePath` -> `path`; both are accepted here.
 *
 * 4. Edit success message. V1 collapsed `Edit applied successfully.` to `OK`.
 *    V2's edit tool reports `Edited <path> (<n> replacement(s))`; the same
 *    collapse to `OK` is applied on a successful edit.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const LINE_RANGE_RE = /^(\d+)(?:\s*-\s*(\d+))?$/;

/** Tool id -> short description. Keeps the exact strings from V1. */
const SLIM: Record<string, string> = {
	read: "Read file content.",
	edit: "Edit file. oldString can be line range '55-64'.",
	patch: "Apply a patch to files.",
	apply_patch: "Apply a patch to files.",
	write: "Write file.",
	shell: "Run shell command.",
	bash: "Run shell command.",
	glob: "Find files.",
	grep: "Search in files.",
	list: "List directory.",
	webfetch: "Fetch URL.",
	fetch: "Fetch URL.",
};

function resolvePath(directory: string, filePath: string): string {
	return path.isAbsolute(filePath)
		? path.normalize(filePath)
		: path.resolve(directory, filePath);
}

/**
 * Relativize the path in a V2 read header, mirroring V1's `<path>` rewrite.
 * Only the first line is touched. Directory listings and paths that are already
 * relative are left alone (V1 skipped directories outright).
 */
function relativizeReadHeader(text: string, directory: string): string {
	if (!text.startsWith("Read file ")) return text;

	const nl = text.indexOf("\n");
	const header = nl === -1 ? text : text.slice(0, nl);
	const rest = nl === -1 ? "" : text.slice(nl);

	const match = header.match(/^Read file (.*), (lines \d+-\d+|0 lines)$/);
	if (!match) return text;

	const raw = match[1];
	if (!path.isAbsolute(raw)) return text;

	const rel = path.relative(directory, path.normalize(raw));
	return `Read file ${rel}, ${match[2]}${rest}`;
}

/** Collapse V2's verbose edit success line to "OK" (V1 behaviour). */
function collapseEditMessage(text: string): string {
	return text.startsWith("Edited ") ? "OK" : text;
}

/**
 * Apply `fn` to every text part of a tool result `content` payload.
 * Accepts both the plain-string form and the V2 array-of-parts form.
 * Returns the original value when nothing changed.
 */
function mapText(content: unknown, fn: (text: string) => string): unknown {
	if (typeof content === "string") return fn(content);

	if (Array.isArray(content)) {
		let changed = false;
		const next = content.map((part: any) => {
			if (part && part.type === "text" && typeof part.text === "string") {
				const text = fn(part.text);
				if (text !== part.text) {
					changed = true;
					return { ...part, text };
				}
			}
			return part;
		});
		return changed ? next : content;
	}

	return content;
}

/** Read a file as UTF-8, or return undefined when it cannot be read. */
function tryRead(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}
}

const OpenSlimeditPlugin = {
	id: "openslimedit",

	async setup(ctx: any) {
		const directory: string =
			ctx?.location?.directory ?? ctx?.directory ?? process.cwd();

		// --- 1. Slim tool descriptions -------------------------------------
		await ctx.tool.transform((editor: any) => {
			for (const id of Object.keys(SLIM)) {
				editor.update(id, (tool: any) => {
					tool.description = SLIM[id];
				});
			}
		});

		// --- 2. Compact read output, slim edit success ---------------------
		await ctx.tool.hook("execute.after", (event: any) => {
			if (event?.status !== "completed") return;

			let map: (text: string) => string;
			if (event.tool === "read") {
				map = (text) => relativizeReadHeader(text, directory);
			} else if (event.tool === "edit") {
				map = collapseEditMessage;
			} else {
				return;
			}

			const content = event?.result?.content;
			const next = mapText(content, map);
			if (next !== content) {
				event.result = { ...event.result, content: next };
			}
		});

		// --- 3. Expand a bare line range in edit.oldString ------------------
		await ctx.tool.hook("execute.before", (event: any) => {
			if (event?.tool !== "edit") return;

			const args: any = event.input;
			if (!args || !args.oldString) return;

			const rawPath = args.path ?? args.filePath; // V2 `path`, V1 `filePath`
			if (typeof rawPath !== "string" || !rawPath) return;

			const content = tryRead(resolvePath(directory, rawPath));
			if (content === undefined) return;

			// The range form is only a fallback: real text wins.
			if (content.includes(args.oldString)) return;

			const match = String(args.oldString).trim().match(LINE_RANGE_RE);
			if (!match) return;

			const lines = content.split("\n");
			const startLine = parseInt(match[1], 10);
			const endLine = match[2] ? parseInt(match[2], 10) : startLine;

			if (startLine >= 1 && endLine <= lines.length && startLine <= endLine) {
				args.oldString = lines.slice(startLine - 1, endLine).join("\n");
			}
		});
	},
};

export default OpenSlimeditPlugin;
export { OpenSlimeditPlugin };
