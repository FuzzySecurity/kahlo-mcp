import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../config.js";
import { AdbError } from "../backend/adb/adb.js";
import { listDevicesViaAdb } from "../backend/devices/adbDevices.js";
import { getDeviceDetailsViaAdb } from "../backend/devices/adbDeviceDetails.js";
import { ensureAdbDirOnPath } from "../backend/frida/adbPathEnv.js";
import { checkFridaDeviceHealth } from "../backend/frida/fridaHealth.js";
import { toolErr, toolOk } from "./result.js";

/**
 * List connected Android devices.
 *
 * This implementation uses ADB for deterministic USB device discovery. The ADB
 * executable is resolved by preferring PATH and falling back to `config.adbPath`.
 */
export function kahloDevicesList(): CallToolResult {
  const tool = "kahlo_devices_list";
  const config = loadConfig();

  try {
    const devices = listDevicesViaAdb(config);
    return toolOk({ devices });
  } catch (err) {
    if (err instanceof AdbError) {
      return toolErr({
        code: "UNAVAILABLE",
        tool,
        message: err.message,
        retryable: true,
        details: err.details,
        suggestion: "Ensure ADB server is running (adb start-server) and device is connected",
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return toolErr({
      code: "INTERNAL",
      tool,
      message: `Failed to list devices: ${msg}`,
      retryable: false,
    });
  }
}

/**
 * Get device details for a specific device_id.
 */
export function kahloDevicesGet(args: { device_id: string }): CallToolResult {
  const tool = "kahlo_devices_get";
  const config = loadConfig();

  try {
    const device = getDeviceDetailsViaAdb(config, args.device_id);
    return toolOk({ device });
  } catch (err) {
    if (err instanceof AdbError) {
      return toolErr({
        code: "UNAVAILABLE",
        tool,
        message: err.message,
        retryable: true,
        details: err.details,
        suggestion: "Check device is connected and authorized for USB debugging",
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    const isNotFound = msg.toLowerCase().includes("not found");
    return toolErr({
      code: isNotFound ? "NOT_FOUND" : "INTERNAL",
      tool,
      message: msg,
      retryable: false,
      suggestion: isNotFound ? "Verify device_id using kahlo_devices_list" : undefined,
    });
  }
}

/**
 * Check whether a device is ready for Frida instrumentation.
 *
 * This uses frida-node to verify that:
 * - the device id can be resolved by Frida
 * - frida-server is reachable (basic RPC probe succeeds)
 *
 * If `config.adbPath` is provided, we also prepend its directory to PATH so
 * Frida can locate `adb` when USB discovery/forwarding is needed.
 */
export async function kahloDevicesHealth(args: { device_id: string }): Promise<CallToolResult> {
  const tool = "kahlo_devices_health";
  const config = loadConfig();

  // Help frida-node locate adb when it is not globally on PATH.
  ensureAdbDirOnPath(config);

  try {
    const probe = await checkFridaDeviceHealth(args.device_id, 5_000);

    if (!probe.found) {
      return toolOk({
        health: {
          device_id: args.device_id,
          status: "unavailable",
          details: {
            frida_device_found: false,
            frida_server_reachable: false,
            error: probe.error,
          },
        },
      });
    }

    if (!probe.frida_server_reachable) {
      return toolOk({
        health: {
          device_id: args.device_id,
          status: "degraded",
          details: {
            frida_device_found: true,
            frida_server_reachable: false,
            frida_device: { id: probe.id, name: probe.name, type: probe.type },
            error: probe.error,
            hint:
              "Device is visible to Frida but frida-server is not responding. Ensure frida-server is running on the phone and reachable.",
          },
        },
      });
    }

    return toolOk({
      health: {
        device_id: args.device_id,
        status: "healthy",
        details: {
          frida_device_found: true,
          frida_server_reachable: true,
          frida_device: { id: probe.id, name: probe.name, type: probe.type },
        },
      },
    });
  } catch (err) {
    if (err instanceof AdbError) {
      return toolErr({
        code: "UNAVAILABLE",
        tool,
        message: err.message,
        retryable: true,
        details: err.details,
        suggestion: "Ensure ADB server is running (adb start-server) and device is connected",
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return toolErr({
      code: "INTERNAL",
      tool,
      message: `Failed to check device health: ${msg}`,
      retryable: false,
    });
  }
}

