import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { adbExec, AdbError } from "../backend/adb/adb.js";
import { loadConfig } from "../config.js";
import { toolErr, toolOk } from "./result.js";

/**
 * Execute an ADB command using the configured ADB path.
 *
 * @param args.device_id - Optional device serial (uses -s flag)
 * @param args.command - ADB command arguments (e.g., ["shell", "pm", "list", "packages"])
 * @param args.timeout_ms - Optional timeout in milliseconds (default: 30000)
 */
export function kahloAdbCommand(args: {
  device_id?: string;
  command: string[];
  timeout_ms?: number;
}): CallToolResult {
  const tool = "kahlo_adb_command";

  if (!Array.isArray(args.command) || args.command.length === 0) {
    return toolErr({
      code: "INVALID_ARGUMENT",
      tool,
      message: "command must be a non-empty array of strings",
      retryable: false,
      suggestion: "Provide command as an array, e.g., [\"shell\", \"pm\", \"list\", \"packages\"]",
    });
  }

  try {
    const config = loadConfig();
    const stdout = adbExec(config, args.command, {
      serial: args.device_id,
      timeoutMs: args.timeout_ms ?? 30000,
    });

    return toolOk({
      stdout,
      command: args.command.join(" "),
      device_id: args.device_id,
    });
  } catch (err) {
    if (err instanceof AdbError) {
      const code =
        err.kind === "missing"
          ? "UNAVAILABLE"
          : err.kind === "timeout"
            ? "TIMEOUT"
            : "INTERNAL";
      const retryable = err.kind === "missing" || err.kind === "timeout";
      const suggestion =
        err.kind === "missing"
          ? "Ensure ADB is installed and config.adbPath is correct"
          : err.kind === "timeout"
            ? "Consider increasing timeout_ms or check if device is responsive"
            : "Check command syntax and device connection";
      return toolErr({
        code,
        tool,
        message: err.message,
        retryable,
        details: err.details,
        suggestion,
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return toolErr({ code: "INTERNAL", tool, message: msg, retryable: false });
  }
}
