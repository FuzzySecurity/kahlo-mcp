import { spawnSync } from "node:child_process";
import fs from "node:fs";
import type { KahloConfig } from "../../config.js";

/**
 * A structured error representing a failure to invoke `adb`.
 */
export class AdbError extends Error {
  public readonly kind: "missing" | "failed" | "timeout";
  public readonly details: Record<string, unknown>;

  public constructor(kind: "missing" | "failed" | "timeout", message: string, details: Record<string, unknown>) {
    super(message);
    this.name = "AdbError";
    this.kind = kind;
    this.details = details;
  }
}

/**
 * Resolve an `adb` executable to use.
 *
 * Preference order:
 * - `adb` from PATH (so operators can manage their environment normally)
 * - `config.adbPath` (for environments where PATH is not configured)
 *
 * @param config - Runtime configuration (may include `adbPath`).
 * @returns Resolved executable name/path to use for `spawnSync`.
 * @throws AdbError if no working `adb` can be found.
 */
export function resolveAdbExecutable(config: KahloConfig): string {
  // 1) Prefer PATH.
  const pathProbe = spawnSync("adb", ["version"], { encoding: "utf-8" });
  if (!pathProbe.error && pathProbe.status === 0) {
    return "adb";
  }

  // 2) Fallback to config.adbPath.
  const candidate = config.adbPath;
  if (!candidate) {
    throw new AdbError(
      "missing",
      "ADB not found on PATH and no config.adbPath was provided.",
      {
        pathProbeError: pathProbe.error ? String(pathProbe.error) : undefined,
        pathProbeStatus: pathProbe.status,
        pathProbeStdout: pathProbe.stdout,
        pathProbeStderr: pathProbe.stderr,
      }
    );
  }

  if (!fs.existsSync(candidate)) {
    throw new AdbError("missing", "config.adbPath does not exist.", { adbPath: candidate });
  }

  const cfgProbe = spawnSync(candidate, ["version"], { encoding: "utf-8" });
  if (cfgProbe.error || cfgProbe.status !== 0) {
    throw new AdbError("failed", "Failed to execute adb from config.adbPath.", {
      adbPath: candidate,
      error: cfgProbe.error ? String(cfgProbe.error) : undefined,
      status: cfgProbe.status,
      stdout: cfgProbe.stdout,
      stderr: cfgProbe.stderr,
    });
  }

  return candidate;
}

/**
 * Run an `adb` command and return stdout.
 *
 * @param config - Runtime configuration (adb resolution).
 * @param args - Arguments passed to `adb`.
 * @returns stdout (trimmed).
 * @throws AdbError if `adb` cannot be resolved or the command fails.
 */
export interface AdbExecOptions {
  /** ADB device serial; if provided, `-s <serial>` is prepended to args. */
  serial?: string;
  /** Optional timeout in milliseconds for the adb process. */
  timeoutMs?: number;
}

export function adbExec(config: KahloConfig, args: string[], options?: AdbExecOptions): string {
  const adb = resolveAdbExecutable(config);
  const fullArgs = options?.serial ? ["-s", options.serial, ...args] : args;
  const res = spawnSync(adb, fullArgs, {
    encoding: "utf-8",
    timeout: options?.timeoutMs,
  });
  if (res.error || res.status !== 0) {
    // Detect timeout: Node.js sets error.code to ETIMEDOUT when process times out
    const isTimeout =
      res.error &&
      ((res.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ||
        res.error.message?.includes("ETIMEDOUT") ||
        res.error.message?.includes("timed out"));
    if (isTimeout) {
      throw new AdbError("timeout", `adb command timed out after ${options?.timeoutMs ?? "unknown"}ms`, {
        adb,
        args: fullArgs,
        timeoutMs: options?.timeoutMs,
        error: String(res.error),
      });
    }
    throw new AdbError("failed", `adb ${fullArgs.join(" ")} failed`, {
      adb,
      args: fullArgs,
      timeoutMs: options?.timeoutMs,
      error: res.error ? String(res.error) : undefined,
      status: res.status,
      stdout: res.stdout,
      stderr: res.stderr,
    });
  }
  return String(res.stdout ?? "").trim();
}

