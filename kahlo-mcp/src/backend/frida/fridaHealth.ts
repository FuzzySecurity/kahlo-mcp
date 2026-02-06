import * as frida from "frida";

/**
 * Result of checking Frida connectivity to a device.
 */
export interface FridaDeviceHealth {
  /** Whether a Frida Device object could be resolved for the given id. */
  found: boolean;
  /** Whether frida-server appears reachable/responsive (based on an RPC call). */
  frida_server_reachable: boolean;
  /** The Frida device id (when resolved). */
  id?: string;
  /** The Frida device name (when resolved). */
  name?: string;
  /** The Frida device type (when resolved). */
  type?: string;
  /** Optional error info when a probe fails. */
  error?: { name?: string; message: string };
}

/**
 * Check whether Frida can reach a device and whether frida-server is responsive.
 *
 * We treat "responsive" as "basic RPC call succeeded" (enumerating processes),
 * which implies a functioning frida-server connection for that device.
 *
 * @param deviceId - Frida device identifier (for Android USB, typically ADB serial).
 * @param timeoutMs - Timeout for resolving the device id.
 */
export async function checkFridaDeviceHealth(
  deviceId: string,
  timeoutMs: number
): Promise<FridaDeviceHealth> {
  try {
    const device = await frida.getDevice(deviceId, { timeout: timeoutMs });

    // Probe liveness by issuing a lightweight RPC to the device.
    // If frida-server is not running/reachable, this should throw.
    await device.enumerateProcesses();

    return {
      found: true,
      frida_server_reachable: true,
      id: device.id,
      name: device.name,
      type: String(device.type),
    };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    const name = e.name || undefined;
    const message = e.message || String(err);

    // Best-effort: if we failed while resolving the device id, treat as not found.
    // Frida errors vary across platforms; we keep this heuristic conservative.
    const lower = message.toLowerCase();
    const notFound =
      lower.includes("not found") ||
      lower.includes("unable to find") ||
      lower.includes("device not found");

    return {
      found: !notFound ? true : false,
      frida_server_reachable: false,
      error: { name, message },
    };
  }
}

