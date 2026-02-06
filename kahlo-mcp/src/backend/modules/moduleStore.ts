/**
 * Module Store - Host-side permanent versioned module store.
 *
 * Responsibilities:
 * - Store immutable, versioned modules (name@version)
 * - Manage module index (catalog of all modules)
 * - Track provenance (derived_from_draft_id, derived_from_job_id)
 * - Support version strategies (patch/minor/major/exact)
 *
 * Directory structure:
 *   data_dir/modules/index.json              - catalog
 *   data_dir/modules/<name>/<version>/manifest.json
 *   data_dir/modules/<name>/<version>/module.js
 *
 * @module moduleStore
 */

import fs from "node:fs";
import path from "node:path";
import { loadConfig, resolveDataDir } from "../../config.js";
import { isoNow, KeyedLock } from "../../utils.js";

/**
 * Version strategy for module promotion.
 */
export type VersionStrategy = "patch" | "minor" | "major";

/**
 * Module manifest stored with each version.
 */
export interface ModuleManifest {
  name: string;
  version: string;
  created_at: string;
  notes?: string;
  provenance: {
    derived_from_draft_id?: string;
    derived_from_job_id?: string;
  };
}

/**
 * Module index entry (one per module name).
 */
export interface ModuleIndexEntry {
  name: string;
  versions: string[];
  latest: string;
}

/**
 * Full module index.
 */
export interface ModuleIndex {
  modules: Record<string, ModuleIndexEntry>;
}

/**
 * Error thrown by module store operations.
 */
export class ModuleStoreError extends Error {
  public readonly code: "NOT_FOUND" | "VALIDATION_ERROR" | "INTERNAL" | "ALREADY_EXISTS";
  public readonly details?: Record<string, unknown>;

  constructor(
    code: ModuleStoreError["code"],
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ModuleStoreError";
    this.code = code;
    this.details = details;
  }
}

/**
 * In-memory module index.
 */
let moduleIndex: ModuleIndex = { modules: {} };
let initialized = false;

/**
 * Lock for serializing write operations (promote).
 * Uses a single key since all modules share the same index file.
 */
const moduleOpsLock = new KeyedLock();
const MODULE_WRITE_LOCK_KEY = "module_write";

/**
 * Resolve the modules directory path.
 */
function getModulesDir(): string {
  const dataDir = resolveDataDir(loadConfig());
  return path.join(dataDir, "modules");
}

/**
 * Get the index file path.
 */
function getIndexPath(): string {
  return path.join(getModulesDir(), "index.json");
}

/**
 * Ensure the modules directory exists.
 */
function ensureModulesDir(): void {
  const modulesDir = getModulesDir();
  if (!fs.existsSync(modulesDir)) {
    fs.mkdirSync(modulesDir, { recursive: true });
  }
}

/**
 * Initialize the module store by loading the index from disk.
 */
export function initializeModuleStore(): void {
  if (initialized) return;

  ensureModulesDir();
  const indexPath = getIndexPath();

  try {
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath, "utf-8");
      const loaded = JSON.parse(content);
      // Validate the loaded format - modules must be an object, not an array
      if (
        loaded &&
        typeof loaded === "object" &&
        loaded.modules &&
        typeof loaded.modules === "object" &&
        !Array.isArray(loaded.modules)
      ) {
        moduleIndex = loaded as ModuleIndex;
      } else {
        // Invalid format - rebuild from directory structure
        moduleIndex = rebuildIndexFromDisk();
      }
    } else {
      // No index file - rebuild from disk (picks up any existing modules)
      moduleIndex = rebuildIndexFromDisk();
    }
  } catch {
    // Corrupted - rebuild from disk
    moduleIndex = rebuildIndexFromDisk();
  }

  initialized = true;
}

/**
 * Rebuild the index by scanning the modules directory.
 *
 * Safety behaviour: if the directory scan fails or yields zero modules,
 * the existing index.json is NOT overwritten blindly.  Instead, the old
 * file is backed up to index.json.bak so the data remains recoverable.
 * A genuinely empty store (no module sub-directories on disk) is still
 * persisted as an empty index.
 */
function rebuildIndexFromDisk(): ModuleIndex {
  const index: ModuleIndex = { modules: {} };
  const modulesDir = getModulesDir();
  let scanFailed = false;
  /** Whether at least one candidate module directory exists on disk. */
  let moduleDirectoriesExist = false;

  try {
    const names = fs.readdirSync(modulesDir);
    for (const name of names) {
      if (name === "index.json" || name === "index.json.bak") continue;
      const nameDir = path.join(modulesDir, name);
      if (!fs.statSync(nameDir).isDirectory()) continue;

      // At least one directory that could contain modules was found.
      moduleDirectoriesExist = true;

      const versions: string[] = [];
      const versionDirs = fs.readdirSync(nameDir);
      for (const version of versionDirs) {
        const versionDir = path.join(nameDir, version);
        if (!fs.statSync(versionDir).isDirectory()) continue;
        // Skip malformed version directories (must be valid semver X.Y.Z)
        if (!parseVersion(version)) continue;
        const manifestPath = path.join(versionDir, "manifest.json");
        if (fs.existsSync(manifestPath)) {
          versions.push(version);
        }
      }

      if (versions.length > 0) {
        // Sort versions to find latest
        versions.sort((a, b) => {
          const pa = parseVersion(a);
          const pb = parseVersion(b);
          if (!pa || !pb) return 0;
          if (pa.major !== pb.major) return pa.major - pb.major;
          if (pa.minor !== pb.minor) return pa.minor - pb.minor;
          return pa.patch - pb.patch;
        });
        index.modules[name] = {
          name,
          versions,
          latest: versions[versions.length - 1],
        };
      }
    }
  } catch (err) {
    scanFailed = true;
    console.error(
      `[ModuleStore] Directory scan failed during index rebuild: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const indexPath = getIndexPath();
  const rebuiltModuleCount = Object.keys(index.modules).length;

  // Determine whether writing an empty index is safe or destructive.
  if (rebuiltModuleCount === 0) {
    if (scanFailed) {
      // Scan threw -- the empty result is unreliable.  Preserve any
      // existing index so it can be recovered manually.
      backupExistingIndex(indexPath, "scan failure produced zero modules");
      return index;
    }

    if (moduleDirectoriesExist) {
      // Directories exist but no valid modules were found.  This is
      // suspicious (possibly a permissions issue or corrupted manifests).
      // Back up the old index before overwriting.
      console.warn(
        "[ModuleStore] Index rebuild found module directories on disk but zero valid modules -- possible data corruption"
      );
      backupExistingIndex(indexPath, "module directories exist but none are valid");
    } else {
      // Genuinely empty store -- no module directories at all.
      console.log("[ModuleStore] Index rebuild: module store is empty (no module directories found)");
    }
  }

  // Persist the rebuilt index (either non-empty, or confirmed-empty store)
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");
  return index;
}

/**
 * Back up an existing index.json to index.json.bak before it would be
 * overwritten with an empty or potentially lossy rebuilt index.
 *
 * @param indexPath - Absolute path to the current index.json
 * @param reason   - Human-readable reason for the backup (logged)
 */
function backupExistingIndex(indexPath: string, reason: string): void {
  try {
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath, "utf-8");
      // Only back up if the existing file has meaningful content
      const parsed = JSON.parse(content) as ModuleIndex;
      if (parsed.modules && Object.keys(parsed.modules).length > 0) {
        const backupPath = `${indexPath}.bak`;
        fs.copyFileSync(indexPath, backupPath);
        console.warn(
          `[ModuleStore] Backed up existing index to ${backupPath} (reason: ${reason})`
        );
      }
    }
  } catch {
    // If we cannot read/parse the existing index, there is nothing
    // meaningful to back up -- silently continue.
  }
}

/**
 * Persist the module index to disk.
 */
function persistIndex(): void {
  ensureModulesDir();
  const indexPath = getIndexPath();
  fs.writeFileSync(indexPath, JSON.stringify(moduleIndex, null, 2), "utf-8");
}

/**
 * Parse a semantic version string into parts.
 */
function parseVersion(version: string): { major: number; minor: number; patch: number } | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

/**
 * Calculate the next version based on strategy.
 */
function calculateNextVersion(
  currentVersions: string[],
  strategy: VersionStrategy,
  exactVersion?: string
): string {
  // "exact" strategy is not yet exposed in the public schema (no exact_version
  // parameter). This guard is kept for future reactivation; cast to string to
  // suppress TS2367 while the literal is absent from VersionStrategy.
  if ((strategy as string) === "exact") {
    if (!exactVersion) {
      throw new ModuleStoreError("VALIDATION_ERROR", "exact version_strategy requires version to be specified");
    }
    return exactVersion;
  }

  if (currentVersions.length === 0) {
    // First version
    return "1.0.0";
  }

  // Find highest version
  let highest = { major: 0, minor: 0, patch: 0 };
  for (const v of currentVersions) {
    const parsed = parseVersion(v);
    if (parsed) {
      if (
        parsed.major > highest.major ||
        (parsed.major === highest.major && parsed.minor > highest.minor) ||
        (parsed.major === highest.major && parsed.minor === highest.minor && parsed.patch > highest.patch)
      ) {
        highest = parsed;
      }
    }
  }

  switch (strategy) {
    case "major":
      return `${highest.major + 1}.0.0`;
    case "minor":
      return `${highest.major}.${highest.minor + 1}.0`;
    case "patch":
    default:
      return `${highest.major}.${highest.minor}.${highest.patch + 1}`;
  }
}

/**
 * Validate module name (alphanumeric, dots, hyphens, underscores).
 */
function validateModuleName(name: string): void {
  if (!name || typeof name !== "string") {
    throw new ModuleStoreError("VALIDATION_ERROR", "Module name is required");
  }
  if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(name)) {
    throw new ModuleStoreError(
      "VALIDATION_ERROR",
      "Module name must start with a letter and contain only letters, numbers, dots, hyphens, and underscores",
      { name }
    );
  }
}

/**
 * Promote source code to a versioned module.
 */
export async function promoteToModule(args: {
  source: string;
  name: string;
  version_strategy: VersionStrategy;
  exact_version?: string;
  notes?: string;
  derived_from_draft_id?: string;
  derived_from_job_id?: string;
}): Promise<{ module_ref: string; version: string; manifest: ModuleManifest }> {
  // Validate inputs before acquiring lock
  validateModuleName(args.name);

  if (!args.source || typeof args.source !== "string" || args.source.trim().length === 0) {
    throw new ModuleStoreError("VALIDATION_ERROR", "source must be a non-empty string");
  }

  return moduleOpsLock.withLock(MODULE_WRITE_LOCK_KEY, async () => {
    initializeModuleStore();

    // Get or create module entry
    const entry = moduleIndex.modules[args.name] ?? {
      name: args.name,
      versions: [],
      latest: "",
    };

    // Calculate version
    const version = calculateNextVersion(entry.versions, args.version_strategy, args.exact_version);

    // Check if version already exists
    if (entry.versions.includes(version)) {
      throw new ModuleStoreError("ALREADY_EXISTS", `Version ${version} already exists for module ${args.name}`, {
        name: args.name,
        version,
      });
    }

    // Create module directory
    const moduleDir = path.join(getModulesDir(), args.name, version);
    fs.mkdirSync(moduleDir, { recursive: true });

    // Create manifest
    const manifest: ModuleManifest = {
      name: args.name,
      version,
      created_at: isoNow(),
      notes: args.notes,
      provenance: {
        derived_from_draft_id: args.derived_from_draft_id,
        derived_from_job_id: args.derived_from_job_id,
      },
    };

    // Write manifest
    fs.writeFileSync(path.join(moduleDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

    // Write module source
    fs.writeFileSync(path.join(moduleDir, "module.js"), args.source, "utf-8");

    // Update index
    entry.versions.push(version);
    entry.latest = version;
    moduleIndex.modules[args.name] = entry;
    persistIndex();

    const module_ref = `${args.name}@${version}`;
    return { module_ref, version, manifest };
  });
}

/**
 * List all modules in the store.
 */
export function listModules(): ModuleIndexEntry[] {
  initializeModuleStore();
  return Object.values(moduleIndex.modules);
}

/**
 * Get a specific module version.
 */
export function getModule(module_ref: string): { manifest: ModuleManifest; source: string } {
  initializeModuleStore();

  // Parse module_ref (name@version)
  const atIndex = module_ref.lastIndexOf("@");
  if (atIndex === -1) {
    throw new ModuleStoreError("VALIDATION_ERROR", "Invalid module_ref format. Expected 'name@version'", {
      module_ref,
    });
  }

  const name = module_ref.slice(0, atIndex);
  const version = module_ref.slice(atIndex + 1);

  const entry = moduleIndex.modules[name];
  if (!entry || !entry.versions.includes(version)) {
    throw new ModuleStoreError("NOT_FOUND", `Module not found: ${module_ref}`, { module_ref });
  }

  const moduleDir = path.join(getModulesDir(), name, version);
  const manifestPath = path.join(moduleDir, "manifest.json");
  const sourcePath = path.join(moduleDir, "module.js");

  if (!fs.existsSync(manifestPath) || !fs.existsSync(sourcePath)) {
    throw new ModuleStoreError("INTERNAL", `Module files missing for ${module_ref}`, { module_ref });
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ModuleManifest;
  const source = fs.readFileSync(sourcePath, "utf-8");

  return { manifest, source };
}
