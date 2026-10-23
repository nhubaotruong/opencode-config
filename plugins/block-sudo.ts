/**
 * Block Sudo Plugin (OpenCode V2)
 *
 * Blocks any shell command that invokes `sudo`. Use as a safety guard for
 * agents that should never need elevated privileges. If a command truly
 * requires root, run it manually outside the agent.
 *
 * Ported from ~/.omp/agent/extensions/block-sudo.ts (pi extension) to the
 * OpenCode V2 plugin API.
 *
 * Install: drop into ~/.config/opencode/plugins/ (auto-discovered).
 *
 * Notes:
 * - Comments and content inside single/double-quoted regions are stripped
 *   before matching so `echo "use sudo" # note` is not a false positive.
 *   Quoting state is tracked best-effort.
 * - Heredocs and complex interpolation are not fully parsed; sudo inside
 *   them is still blocked (fail-closed).
 */

const SUDO_PATTERN = /(?:^|[\s;&|])sudo\b/m;

/** Strip `#` comments and content inside single/double-quoted regions. */
function stripComments(command: string): string {
	return command
		.split("\n")
		.map((line) => {
			let inSingle = false;
			let inDouble = false;
			let result = "";
			for (let i = 0; i < line.length; i++) {
				const c = line[i];
				if (c === "\\") {
					i++;
					continue;
				}
				if (!inDouble && c === "'") {
					inSingle = !inSingle;
					result += " ";
					continue;
				}
				if (!inSingle && c === '"') {
					inDouble = !inDouble;
					result += " ";
					continue;
				}
				if (c === "#" && !inSingle && !inDouble) {
					break;
				}
				if (inSingle || inDouble) {
					continue;
				}
				result += c;
			}
			return result;
		})
		.join("\n");
}

const BlockSudoPlugin = {
	id: "block-sudo",

	async setup(ctx: any) {
		await ctx.tool.hook("execute.before", (event: any) => {
			const tool = String(event?.tool ?? "").toLowerCase();
			if (tool !== "bash" && tool !== "shell") return;

			const command = event?.input?.command;
			if (typeof command !== "string" || !command) return;

			if (SUDO_PATTERN.test(stripComments(command))) {
				throw new Error(
					"sudo is blocked by the block-sudo extension. " +
						"Run the command yourself if elevated privileges are required.",
				);
			}
		});
	},
};

export default BlockSudoPlugin;
export { BlockSudoPlugin };
