import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isRecord } from "./utils.js";

/** Module-level config cache to avoid redundant fs.readFileSync calls. */
let cachedConfig: KahloConfig | null = null;

export type KahloTransport = "stdio";

export interface KahloConfig {
  /**
   * MCP transport mode.
   *
   * Currently only `stdio` is supported.
   */
  transport: KahloTransport;

  /** Logging verbosity for the host process. */
  logLevel: "debug" | "info" | "warn" | "error";

  /**
   * Base directory for on-disk storage (runs/modules/drafts/snapshots).
   */
  dataDir: string;

  /**
   * Optional absolute path to the `adb` binary (e.g., `C:\\Android\\platform-tools\\adb.exe`).
   *
   * If omitted, the server will attempt to use `adb` from PATH.
   */
  adbPath?: string;
}

/**
 * Get the kahlo-mcp project root directory by resolving from this file's location.
 * Works regardless of the process's current working directory.
 */
function getProjectRootDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = path.dirname(thisFile);
  // This file is kahlo-mcp/dist/config.js, so project root is one level up
  return path.resolve(thisDir, "..");
}

/**
 * Load kahlo MCP runtime configuration from `config.json`.
 *
 * Precedence:
 * - `KAHLO_CONFIG_PATH` env var (absolute path)
 * - `<projectRoot>/config.json` (project root detected via import.meta.url)
 *
 * @throws If the config file is missing or malformed.
 */
export function loadConfig(): KahloConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const projectRoot = getProjectRootDir();
  const configPath = process.env.KAHLO_CONFIG_PATH
    ? path.resolve(process.env.KAHLO_CONFIG_PATH)
    : path.join(projectRoot, "config.json");

  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`Invalid config: expected JSON object at ${configPath}`);
  }

  const transport = parsed.transport;
  const logLevel = parsed.logLevel;
  const dataDir = parsed.dataDir;
  const adbPath = parsed.adbPath;

  if (transport !== "stdio") {
    throw new Error(
      `Invalid config.transport: expected \"stdio\" at ${configPath}`
    );
  }
  if (logLevel !== "debug" && logLevel !== "info" && logLevel !== "warn" && logLevel !== "error") {
    throw new Error(
      `Invalid config.logLevel: expected debug|info|warn|error at ${configPath}`
    );
  }
  if (typeof dataDir !== "string" || dataDir.trim().length === 0) {
    throw new Error(`Invalid config.dataDir: expected non-empty string at ${configPath}`);
  }
  if (adbPath !== undefined) {
    if (typeof adbPath !== "string" || adbPath.trim().length === 0) {
      throw new Error(`Invalid config.adbPath: expected non-empty string at ${configPath}`);
    }
  }

  cachedConfig = {
    transport,
    logLevel,
    dataDir,
    adbPath: adbPath?.trim(),
  };

  return cachedConfig;
}

/**
 * Clear the cached config and re-read from disk on the next `loadConfig()` call.
 *
 * Call this if `config.json` (or `KAHLO_CONFIG_PATH`) has been modified at runtime
 * and the process needs to pick up the changes.
 */
export function reloadConfig(): KahloConfig {
  cachedConfig = null;
  return loadConfig();
}

/**
 * Resolve the configured data directory to an absolute path.
 *
 * - If `config.dataDir` is absolute, it is returned as-is.
 * - If it is relative, it is resolved relative to the project root (the directory
 *   containing `config.json`).
 */
export function resolveDataDir(config: KahloConfig): string {
  const projectRoot = getProjectRootDir();
  return path.isAbsolute(config.dataDir) ? config.dataDir : path.resolve(projectRoot, config.dataDir);
}
