import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isRecord } from "./utils.js";

/**
 * Minimal subset of `package.json` metadata that we treat as authoritative at runtime.
 */
export interface KahloPackageMeta {
  /** Package name (from `package.json`). */
  name: string;
  /** Package version (from `package.json`). */
  version: string;
}

/**
 * Get the kahlo-mcp project root directory by resolving from this file's location.
 * Works regardless of the process's current working directory.
 */
function getProjectRootDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = path.dirname(thisFile);
  // This file is kahlo-mcp/dist/meta.js at runtime, so project root is one level up
  return path.resolve(thisDir, "..");
}

/**
 * Load authoritative server metadata from `package.json`.
 *
 * We use this instead of hard-coded versions so the "about" tool (and the MCP
 * server info itself) always reflects the installed build.
 *
 * @throws If `package.json` is missing or malformed.
 */
export function loadPackageMeta(): KahloPackageMeta {
  const projectRoot = getProjectRootDir();
  const packageJsonPath = path.join(projectRoot, "package.json");

  const raw = fs.readFileSync(packageJsonPath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`Invalid package.json: expected JSON object at ${packageJsonPath}`);
  }

  const name = parsed.name;
  const version = parsed.version;

  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error(`Invalid package.json: expected non-empty string name at ${packageJsonPath}`);
  }
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error(`Invalid package.json: expected non-empty string version at ${packageJsonPath}`);
  }

  return { name, version };
}

