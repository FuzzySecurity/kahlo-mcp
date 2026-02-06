import path from "node:path";
import type { KahloConfig } from "../../config.js";

/**
 * Ensure the directory containing `adb` is present on PATH.
 *
 * Frida's USB backend may rely on ADB for discovery/forwarding. When operators
 * provide `config.adbPath`, we can make the environment more robust by adding
 * that directory to PATH for the current process.
 *
 * @param config - Runtime configuration (may include `adbPath`).
 */
export function ensureAdbDirOnPath(config: KahloConfig): void {
  if (!config.adbPath) return;

  const adbDir = path.dirname(config.adbPath);
  const sep = process.platform === "win32" ? ";" : ":";
  const current = process.env.PATH ?? "";
  const entries = current.split(sep).filter((e) => e.length > 0);

  // Case-insensitive compare on Windows.
  const alreadyPresent =
    process.platform === "win32"
      ? entries.some((e) => e.toLowerCase() === adbDir.toLowerCase())
      : entries.includes(adbDir);

  if (!alreadyPresent) {
    process.env.PATH = `${adbDir}${sep}${current}`;
  }
}

