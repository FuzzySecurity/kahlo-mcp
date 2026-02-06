import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../config.js";
import { ensureAdbDirOnPath } from "../backend/frida/adbPathEnv.js";
import { enumerateProcesses, type ProcessScope } from "../backend/frida/processes.js";
import { toolErr, toolOk } from "./result.js";

/**
 * List running processes on a device.
 */
export async function kahloProcessesList(args: {
  device_id: string;
  scope?: ProcessScope;
}): Promise<CallToolResult> {
  const tool = "kahlo_processes_list";
  const config = loadConfig();

  // Help frida-node locate adb when it is not globally on PATH.
  ensureAdbDirOnPath(config);

  try {
    const scope: ProcessScope = args.scope ?? "minimal";
    const processes = await enumerateProcesses(args.device_id, scope, 10_000);
    return toolOk({ processes });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return toolErr({
      code: "UNAVAILABLE",
      tool,
      message: msg,
      suggestion: "Verify device is ready using kahlo_devices_health and ensure frida-server is running on the device",
      retryable: true,
    });
  }
}

