/**
 * Summary information for a connected Android device.
 */
export interface DeviceSummary {
  /** Stable device identifier (ADB serial). */
  device_id: string;
  /** Human-friendly model name when available; otherwise "<unknown>". */
  model: string;
  /** Transport type inferred from the ADB serial. */
  transport: "USB" | "TCP";
}

