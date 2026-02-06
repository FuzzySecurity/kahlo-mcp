/**
 * Load the in-process orchestrator agent source.
 *
 * Keeping the agent as a standalone `.js` file makes it easier to lint and edit
 * while still providing a string suitable for `session.createScript(source)`.
 */
import fs from "node:fs";

let cached: { source: string; mtimeMs: number } | null = null;

/**
 * Get the orchestrator agent source code as a string.
 *
 * @returns Agent JavaScript source.
 */
export function getOrchestratorAgentSource(): string {
  const url = new URL("./orchestratorAgent.js", import.meta.url);
  // Loaded from `dist/` where the build copies the agent verbatim.
  //
  // NOTE: We intentionally reload when the file changes so iterative
  // development does not require restarting the MCP server process.
  const stat = fs.statSync(url);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.source;

  const source = fs.readFileSync(url, "utf8");
  cached = { source, mtimeMs: stat.mtimeMs };
  return source;
}

