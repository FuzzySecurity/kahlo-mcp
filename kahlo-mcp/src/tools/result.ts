import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Machine-readable error codes for kahlo tool responses.
 *
 * Keep this list stable once clients depend on it.
 */
export type KahloToolErrorCode =
  | "NOT_IMPLEMENTED"
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "UNAVAILABLE"
  | "TIMEOUT"
  | "INTERNAL";

/**
 * Standard machine-readable error envelope for all kahlo tools.
 */
export interface KahloToolError {
  /** Stable error code for programmatic branching. */
  code: KahloToolErrorCode;
  /** Human-readable message (safe for operator display). */
  message: string;
  /** Tool name that produced the error (e.g., `kahlo_jobs_start`). */
  tool: string;
  /** Whether retrying the exact same request may succeed. */
  retryable?: boolean;
  /** Optional structured details (do not put massive payloads here). */
  details?: Record<string, unknown>;
  /** Actionable suggestion for the AI/operator on how to resolve this error. */
  suggestion?: string;
}

/**
 * Standard success envelope for all kahlo tools.
 *
 * Tools should return `structuredContent` matching this shape when they have an
 * `outputSchema` registered, so clients can avoid parsing `content[].text`.
 */
export interface KahloToolOk<T> extends Record<string, unknown> {
  ok: true;
  data: T;
}

/**
 * Standard error envelope for all kahlo tools.
 */
export interface KahloToolFail extends Record<string, unknown> {
  ok: false;
  error: KahloToolError;
}

/**
 * Build a successful MCP tool response with both:
 * - `structuredContent` (primary; validated when outputSchema is present)
 * - `content[].text` JSON (fallback for clients that only read text)
 *
 * @param data - Tool-specific success payload.
 */
export function toolOk<T extends Record<string, unknown>>(data: T): CallToolResult {
  const structuredContent: KahloToolOk<T> = { ok: true, data };
  return {
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
  };
}

/**
 * Build an error MCP tool response with both:
 * - `structuredContent` (primary; validated when outputSchema is present)
 * - `content[].text` JSON (fallback for clients that only read text)
 *
 * IMPORTANT: `isError=true` ensures MCP clients treat this as a tool failure.
 */
export function toolErr(error: KahloToolError): CallToolResult {
  const structuredContent: KahloToolFail = { ok: false, error };
  return {
    isError: true,
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
  };
}

/**
 * Common error code union shared by DraftManagerError and ModuleStoreError.
 *
 * Both backend error classes define the same `code` variants; this type lets
 * us write a single mapping function that accepts either.
 */
export type BackendErrorCode = "NOT_FOUND" | "VALIDATION_ERROR" | "INTERNAL" | "ALREADY_EXISTS";

/**
 * Map backend error codes (DraftManagerError / ModuleStoreError) to the
 * stable {@link KahloToolErrorCode} returned to MCP clients.
 *
 * @param code - The error code from a backend error class.
 * @returns The corresponding KahloToolErrorCode.
 */
export function mapBackendErrorCode(code: BackendErrorCode): KahloToolErrorCode {
  switch (code) {
    case "NOT_FOUND":
      return "NOT_FOUND";
    case "VALIDATION_ERROR":
    case "ALREADY_EXISTS":
      return "INVALID_ARGUMENT";
    case "INTERNAL":
    default:
      return "INTERNAL";
  }
}

