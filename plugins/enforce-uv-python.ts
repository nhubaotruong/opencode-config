/**
 * Enforce-uv-python (OpenCode V2)
 *
 * Hooks the `shell` tool to force Python + pip through `uv`.
 *
 * Ported from ~/.omp/agent/extensions/enforce-uv-python.ts (pi extension) to
 * the OpenCode V2 plugin API.
 *
 * Rules:
 *   - blocks direct `python` / `python3` (allows `uv run`, `docker`/`podman` exec)
 *   - blocks any `--break-system-packages` flag
 *   - blocks bare `pip` / `pip3` (allows `uv pip`, venv pip, `uv run pip`,
 *     and pip invoked after `source <venv>/(bin|Scripts)/activate`)
 *
 * Install: drop into ~/.config/opencode/plugins/ (auto-discovered).
 */

// ---------- regex helpers ----------------------------------------------------
//
// All "standalone token" regexes use a preceding-class of [^A-Za-z0-9_\/-] so
// that compound identifiers like `mypython` or `script-python` do not match.
// They use a trailing-class of [\s"'$`] so we still match the last token of a
// command before any closing quote / substitution.

// Direct python / python3 invocation (not as part of a longer identifier).
const PYTHON_STANDALONE =
	/(?:^|[^A-Za-z0-9_/-])(?:python|python3)(?=[\s"'`;&|$)]|$)/;

// `uv run [flags...] python ...` — python is allowed when `uv` is the entrypoint.
// Allows both bare `--flag` and `--flag value` pairs between `run` and `python`
// (e.g. `--with httpx`, `-p 3.11`, `--no-cache`).
const PYTHON_UV_RUN =
	/\buv[\s]+run(?:[\s]+--?\S+(?:[\s]+[^\s-][^\s]*)?)*[\s]+(?:python|python3)(?=[\s"';|$)]|$)/;

// `docker|podman [compose] [flags...] (exec|run) ...` — python is allowed
// inside the container because the container owns its own environment.
const CONTAINER_EXEC =
	/(?:^|[^A-Za-z0-9_/-])(?:docker|podman)(?:-compose|[\s]+compose)?(?:[\s]+(?:-{1,2}\S+))*[\s]+(?:exec|run)(?=[\s"';|$)]|$)/;

// Direct pip / pip3 invocation.
const PIP_STANDALONE = /(?:^|[^A-Za-z0-9_/-])(?:pip|pip3)(?=[\s"';|$)]|$)/;

// `uv pip ...` — fully allowed (uv-managed).
const PIP_UV_PIP = /(?:^|[^A-Za-z0-9_/-])uv[\s]+pip(?=[\s"';|$)]|$)/;

// Allows both bare `--flag` and `--flag value` pairs between `run` and `pip`.
const PIP_UV_RUN =
	/\buv[\s]+run(?:[\s]+--?\S+(?:[\s]+[^\s-][^\s]*)?)*[\s]+pip(?=[\s"';|$)]|$)/;

// Pip invoked via a venv path, e.g. `.venv/bin/pip`, `venv/Scripts/pip.exe`,
// `myenv/bin/pip`. The path must contain a venv-ish segment before /bin/pip.
const PIP_VENV_PATH =
	/(?:^|[^A-Za-z0-9_/])(?:\.venv|venv|virtualenv|[A-Za-z0-9._-]*env)\/(?:bin|Scripts)\/pip(?:\.exe)?(?=[\s"';|$)]|$)/;

// `source <venv>/(bin|Scripts)/activate` — once a venv is activated in the
// same command, subsequent pip calls run inside that venv.
const VENV_ACTIVATE = /\bsource\s+[^\s;&|]+\/(?:bin|Scripts)\/activate\b/;

// `--break-system-packages` is never allowed.
const PIP_BREAK_PACKAGES = /--break-system-packages/;

// ---------- reason text ------------------------------------------------------

const PYTHON_REASON = `[enforce-uv-python] Direct \`python\` / \`python3\` invocation blocked.

Use \`uv\` instead. See:
  - ~/.config/opencode/skills/python-via-uv/SKILL.md       (run scripts/modules/one-liners)
  - ~/.config/opencode/skills/uv-script-workflow/SKILL.md  (create + maintain PEP 723 scripts)

Patterns:
  UV_CACHE_DIR=/tmp/uv-cache uv run path/to/script.py
  UV_CACHE_DIR=/tmp/uv-cache uv run -m package.module
  UV_CACHE_DIR=/tmp/uv-cache uv run python -c "..."
  UV_CACHE_DIR=/tmp/uv-cache uv run --with <pkg> python -c "..."

New standalone script? \`uv init --script foo.py\` then \`uv add --script foo.py <pkg>\`.
\`python\` is allowed inside \`uv run ...\` and inside \`docker exec\` / \`podman exec\` containers.`;

const PIP_BREAK_REASON = `[enforce-uv-python] \`--break-system-packages\` blocked.

This flag mutates the system Python environment. Use \`uv\` (or a venv) instead:

  uv pip install <pkg>
  uv pip install -r requirements.txt
  uv add --script <script.py> <pkg>     # for PEP 723 scripts
  uv add <pkg>                          # inside a uv project
  .venv/bin/pip install <pkg>           # inside an activated venv

See ~/.config/opencode/skills/python-via-uv/SKILL.md.`;

const PIP_REASON = `[enforce-uv-python] Direct \`pip\` invocation blocked.

Only \`uv pip\` and venv \`pip\` invocations are allowed. Examples:

  uv pip install <pkg>
  uv pip install -r requirements.txt
  uv run pip install <pkg>
  .venv/bin/pip install <pkg>
  source .venv/bin/activate && pip install <pkg>

For PEP 723 scripts: \`uv add --script <script.py> <pkg>\`.
For uv projects: \`uv add <pkg>\`.

See ~/.config/opencode/skills/python-via-uv/SKILL.md.`;

// ---------- plugin -----------------------------------------------------------

const EnforceUvPythonPlugin = {
	id: "enforce-uv-python",

	async setup(ctx: any) {
		await ctx.tool.hook("execute.before", (event: any) => {
			const tool = String(event?.tool ?? "").toLowerCase();
			if (tool !== "bash" && tool !== "shell") return;

			const cmd = event?.input?.command;
			if (typeof cmd !== "string" || cmd.length === 0) return;

			// 1. --break-system-packages is never allowed, regardless of context.
			if (PIP_BREAK_PACKAGES.test(cmd)) {
				throw new Error(PIP_BREAK_REASON);
			}

			// 2. Direct python / python3.
			if (PYTHON_STANDALONE.test(cmd)) {
				const allowedByUvRun = PYTHON_UV_RUN.test(cmd);
				const allowedByContainer = CONTAINER_EXEC.test(cmd);
				if (!allowedByUvRun && !allowedByContainer) {
					throw new Error(PYTHON_REASON);
				}
			}

			// 3. Direct pip / pip3.
			if (PIP_STANDALONE.test(cmd)) {
				const allowedByUvPip = PIP_UV_PIP.test(cmd);
				const allowedByUvRun = PIP_UV_RUN.test(cmd);
				const allowedByVenvPath = PIP_VENV_PATH.test(cmd);
				const allowedByActivate = VENV_ACTIVATE.test(cmd);
				if (
					!allowedByUvPip &&
					!allowedByUvRun &&
					!allowedByVenvPath &&
					!allowedByActivate
				) {
					throw new Error(PIP_REASON);
				}
			}
		});
	},
};

export default EnforceUvPythonPlugin;
export { EnforceUvPythonPlugin };
