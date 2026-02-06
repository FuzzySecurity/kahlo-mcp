/**
 * Tool handlers may be stubbed while backends are being implemented.
 *
 * We still register the full tool inventory + schemas so MCP clients (and AI
 * models) can discover the interface, while implementations evolve.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toolErr } from "./result.js";

/**
 * Create a standard "not implemented yet" tool response.
 *
 * @param toolName - MCP tool name, used to make the stub message explicit.
 * @returns A CallToolResult with `isError=true`.
 */
export function toolNotImplemented(toolName: string): CallToolResult {
  return toolErr({
    code: "NOT_IMPLEMENTED",
    tool: toolName,
    message: `Not implemented yet: ${toolName}.`,
    retryable: false,
    details: {
      hint: "This tool is registered with a stable schema, but the backend handler is not wired up yet.",
    },
  });
}

