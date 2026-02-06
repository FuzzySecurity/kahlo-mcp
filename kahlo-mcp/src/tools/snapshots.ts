import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TargetManagerError, getOrchestratorExports } from "../backend/targets/targetManager.js";
import { toolErr, toolOk } from "./result.js";

/**
 * Snapshot kind supported by `kahlo_snapshots_get`.
 *
 * NOTE: Keep this aligned with `zSnapshotKind` in `tools/schemas.ts`.
 */
export type SnapshotKind = "native.modules" | "process.info";

/**
 * Request an on-demand snapshot of the target runtime state.
 *
 * This tool is intentionally bounded and schema-first:
 * - a small enum of kinds
 * - structured output payloads
 * - timeouts to avoid wedging a session
 */
export async function kahloSnapshotsGet(args: {
  target_id: string;
  kind: SnapshotKind;
  options?: Record<string, unknown>;
}): Promise<CallToolResult> {
  const tool = "kahlo_snapshots_get";

  try {
    const exports = getOrchestratorExports(args.target_id);
    if (!exports || typeof exports.getSnapshot !== "function") {
      return toolErr({
        code: "UNAVAILABLE",
        tool,
        message: "Orchestrator agent does not expose getSnapshot(); update/reinject the agent.",
        retryable: true,
        details: { target_id: args.target_id },
        suggestion: "Re-attach to the target using kahlo_targets_ensure",
      });
    }

    const timeoutMs = 10_000;
    const snapshot = await Promise.race([
      exports.getSnapshot(args.kind, args.options ?? {}),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("snapshot timeout exceeded")), timeoutMs)
      ),
    ]);

    return toolOk({
      target_id: args.target_id,
      kind: args.kind,
      snapshot: snapshot ?? {},
    });
  } catch (err) {
    if (err instanceof TargetManagerError) {
      const suggestion =
        err.code === "NOT_FOUND"
          ? "Verify target_id with kahlo_targets_status"
          : err.code === "UNAVAILABLE"
            ? "Target may have crashed. Re-attach with kahlo_targets_ensure"
            : "Check target status with kahlo_targets_status";
      return toolErr({
        code: err.code,
        tool,
        message: err.message,
        retryable: err.code === "UNAVAILABLE",
        details: err.details,
        suggestion,
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes("timeout");
    return toolErr({
      code: isTimeout ? "UNAVAILABLE" : "INTERNAL",
      tool,
      message: msg,
      retryable: isTimeout,
      suggestion: isTimeout
        ? "Snapshot timed out. Target may be busy. Retry or check kahlo_targets_status"
        : "An unexpected error occurred. Check target status with kahlo_targets_status",
    });
  }
}

