import type { KahloConfig } from "../../config.js";
import { AdbError, adbExec } from "../adb/adb.js";
import { listDevicesViaAdb } from "./adbDevices.js";
import type { DeviceSummary } from "./types.js";

/**
 * Extended device metadata returned by `kahlo_devices_get`.
 */
export interface DeviceDetails extends DeviceSummary {
  /** Android version string (e.g., "14"). */
  android_version?: string;
}

/**
 * Fetch device details using ADB.
 *
 * This function:
 * - verifies the device is currently connected and in "device" state
 * - fetches additional metadata via `adb -s <serial> shell getprop ...`
 *
 * @throws Error if the device is not connected/usable.
 */
export function getDeviceDetailsViaAdb(config: KahloConfig, deviceId: string): DeviceDetails {
  const devices = listDevicesViaAdb(config);
  const summary = devices.find((d) => d.device_id === deviceId);
  if (!summary) {
    throw new AdbError("failed", `Device not found (or not authorized): ${deviceId}`, {
      device_id: deviceId,
    });
  }

  // Try to refine model and Android version. These may fail on some setups;
  // callers can decide whether to treat that as fatal.
  const timeoutMs = 5_000;

  const model =
    adbExec(config, ["shell", "getprop", "ro.product.model"], { serial: deviceId, timeoutMs }) ||
    summary.model;

  const androidVersion = adbExec(config, ["shell", "getprop", "ro.build.version.release"], {
    serial: deviceId,
    timeoutMs,
  });

  return {
    ...summary,
    model: model.trim().length ? model.trim() : summary.model,
    android_version: androidVersion.trim().length ? androidVersion.trim() : undefined,
  };
}

