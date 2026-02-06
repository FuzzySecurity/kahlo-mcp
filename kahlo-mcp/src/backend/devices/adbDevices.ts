import type { KahloConfig } from "../../config.js";
import { adbExec } from "../adb/adb.js";
import type { DeviceSummary } from "./types.js";

/**
 * Parse a single `adb devices -l` line into a DeviceSummary, if applicable.
 *
 * Example lines:
 * - "emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1"
 * - "R58M123ABC            device usb:1-1 product:... model:SM_G991B device:o1s transport_id:2"
 * - "192.168.0.10:5555     device product:... model:Pixel_7 device:panther transport_id:3"
 * - "XYZ                   unauthorized"
 *
 * We only include devices whose state is exactly "device" (i.e., usable).
 */
function parseAdbDevicesLine(line: string): DeviceSummary | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("List of devices attached")) {
    return null;
  }

  // First token is serial, second token is state (device/offline/unauthorized/etc.)
  const tokens = trimmed.split(/\s+/g);
  if (tokens.length < 2) return null;

  const serial = tokens[0];
  const state = tokens[1];
  if (state !== "device") return null;

  // Parse key:value attributes after the first two tokens.
  const kv = new Map<string, string>();
  for (const t of tokens.slice(2)) {
    const idx = t.indexOf(":");
    if (idx <= 0) continue;
    const k = t.slice(0, idx);
    const v = t.slice(idx + 1);
    if (k && v) kv.set(k, v);
  }

  const model = kv.get("model") ?? "<unknown>";
  const transport: DeviceSummary["transport"] = serial.includes(":") ? "TCP" : "USB";

  return {
    device_id: serial,
    model,
    transport,
  };
}

/**
 * Enumerate connected Android devices using ADB.
 *
 * @param config - Runtime configuration (used to locate ADB).
 * @returns Array of connected devices in "device" state.
 */
export function listDevicesViaAdb(config: KahloConfig): DeviceSummary[] {
  const out = adbExec(config, ["devices", "-l"]);
  const devices: DeviceSummary[] = [];
  for (const line of out.split(/\r?\n/g)) {
    const d = parseAdbDevicesLine(line);
    if (d) devices.push(d);
  }
  return devices;
}

