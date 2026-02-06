import * as frida from "frida";

/**
 * Process entry returned by `kahlo_processes_list`.
 */
export interface ProcessEntry {
  pid: number;
  name: string;
  /**
   * Optional process parameters (present when using broader scopes).
   * Shape depends on Frida; treat as opaque JSON.
   */
  parameters?: Record<string, unknown>;
}

export type ProcessScope = "minimal" | "metadata" | "full";

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * Enumerate running processes on a device via frida-node.
 *
 * @param deviceId - Frida device id (for Android USB, typically ADB serial).
 * @param scope - Frida process enumeration scope.
 * @param timeoutMs - Timeout for resolving the device.
 */
export async function enumerateProcesses(
  deviceId: string,
  scope: ProcessScope,
  timeoutMs: number
): Promise<ProcessEntry[]> {
  const device = await frida.getDevice(deviceId, { timeout: timeoutMs });
  const processes = await device.enumerateProcesses({ scope: scope as any });
  return processes.map((p: any) => ({
    pid: p.pid,
    name: p.name,
    parameters: asRecord(p.parameters),
  }));
}

