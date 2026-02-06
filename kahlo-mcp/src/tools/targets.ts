import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../config.js";
import { ensureAdbDirOnPath } from "../backend/frida/adbPathEnv.js";
import { kahloJobsCancelAllForTarget } from "./jobs.js";
import {
  detachTarget,
  ensureTarget,
  getTargetStatus,
  TargetManagerError,
  type BootstrapModule,
  type TargetGating,
  type TargetMode,
} from "../backend/targets/targetManager.js";
import { toolErr, toolOk } from "./result.js";

/**
 * `kahlo_targets_ensure` - instrument a target process via attach or spawn.
 *
 * For spawn with gating="spawn", a bootstrap job is required to install early hooks
 * before the app runs.
 */
export async function kahloTargetsEnsure(args: {
  device_id: string;
  package: string;
  mode: TargetMode;
  gating: TargetGating;
  bootstrap?: BootstrapModule;
  bootstrap_params?: Record<string, unknown>;
  bootstrap_type?: "oneshot" | "daemon" | "interactive";
  child_bootstrap?: BootstrapModule;
  child_bootstrap_params?: Record<string, unknown>;
  child_bootstrap_type?: "oneshot" | "daemon" | "interactive";
}): Promise<CallToolResult> {
  const tool = "kahlo_targets_ensure";
  const config = loadConfig();

  // Help frida-node locate adb when it is not globally on PATH.
  ensureAdbDirOnPath(config);

  try {
    const { target_id } = await ensureTarget({
      device_id: args.device_id,
      package: args.package,
      mode: args.mode,
      gating: args.gating,
      bootstrap: args.bootstrap,
      bootstrap_params: args.bootstrap_params,
      bootstrap_type: args.bootstrap_type,
      child_bootstrap: args.child_bootstrap,
      child_bootstrap_params: args.child_bootstrap_params,
      child_bootstrap_type: args.child_bootstrap_type,
    });
    return toolOk({ target_id });
  } catch (err) {
    if (err instanceof TargetManagerError) {
      let suggestion: string;
      switch (err.code) {
        case "NOT_FOUND":
          suggestion = "Verify device_id using kahlo_devices_list";
          break;
        case "UNAVAILABLE":
          suggestion = "Check device connection with kahlo_devices_health";
          break;
        case "INVALID_ARGUMENT":
          suggestion =
            "Ensure mode is 'attach' or 'spawn', and gating is 'none', 'spawn', or 'child'. For spawn gating, a bootstrap module is required.";
          break;
        case "NOT_IMPLEMENTED":
          suggestion = "This feature is not yet supported. Use inline source for bootstrap instead of module_ref or draft_id.";
          break;
        default:
          suggestion = "Retry with kahlo_devices_health to verify device connectivity";
      }
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
    return toolErr({
      code: "INTERNAL",
      tool,
      message: msg,
      retryable: false,
      suggestion: "Check device connection with kahlo_devices_health and verify the package name exists on the device",
    });
  }
}

/**
 * `kahlo_targets_status`.
 */
export function kahloTargetsStatus(args: { target_id: string }): CallToolResult {
  const tool = "kahlo_targets_status";
  try {
    const target = getTargetStatus(args.target_id);
    return toolOk({ target });
  } catch (err) {
    if (err instanceof TargetManagerError) {
      let suggestion: string;
      switch (err.code) {
        case "NOT_FOUND":
          suggestion = "Target may have been detached. Use kahlo_targets_ensure to create a new target";
          break;
        case "UNAVAILABLE":
          suggestion = "The target may have crashed. Re-attach with kahlo_targets_ensure";
          break;
        default:
          suggestion = "Verify target exists by listing active targets or create a new one with kahlo_targets_ensure";
      }
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
    return toolErr({
      code: "INTERNAL",
      tool,
      message: msg,
      retryable: false,
      suggestion: "Target may have been detached. Use kahlo_targets_ensure to create a new target",
    });
  }
}

/**
 * `kahlo_targets_detach`.
 */
export async function kahloTargetsDetach(args: { target_id: string }): Promise<CallToolResult> {
  const tool = "kahlo_targets_detach";
  const config = loadConfig();

  // Help frida-node locate adb when it is not globally on PATH.
  ensureAdbDirOnPath(config);

  try {
    // Best-effort: cancel any jobs before detaching the session.
    await kahloJobsCancelAllForTarget({ target_id: args.target_id });
    const target = await detachTarget(args.target_id);
    return toolOk({ target_id: target.target_id, state: "detached" as const });
  } catch (err) {
    if (err instanceof TargetManagerError) {
      let suggestion: string;
      switch (err.code) {
        case "NOT_FOUND":
          suggestion = "Target may have already been detached or never existed. No action needed.";
          break;
        case "UNAVAILABLE":
          suggestion = "The target may have crashed. The process is likely already detached.";
          break;
        default:
          suggestion = "Target may have already been detached. Use kahlo_targets_ensure to create a new target if needed.";
      }
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
    return toolErr({
      code: "INTERNAL",
      tool,
      message: msg,
      retryable: false,
      suggestion: "Target may have already been detached. Use kahlo_targets_ensure to create a new target if needed.",
    });
  }
}
