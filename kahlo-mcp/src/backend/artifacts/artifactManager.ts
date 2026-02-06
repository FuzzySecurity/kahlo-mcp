/**
 * Artifact Manager - Host-side artifact store and persistence.
 *
 * Responsibilities:
 * - Receive artifact messages from the orchestrator agent
 * - Validate envelope + attached byte payload (types/lengths)
 * - Compute SHA-256 over raw bytes
 * - Write raw bytes to disk under: data_dir/runs/<YYYY-MM-DD>/target_<target_id>/artifacts/<artifact_id>.bin
 * - Append an index record for discovery: artifacts.jsonl alongside events.jsonl
 * - Maintain in-memory index for fast lookups
 * - Enforce per-target disk budget
 *
 * @module artifactManager
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, resolveDataDir } from "../../config.js";
import { isoNow, yyyyMmDdUtc } from "../../utils.js";

/**
 * Maximum per-target disk budget for artifacts (default: 500 MB).
 * Artifacts exceeding this cumulative limit will be rejected.
 */
const DEFAULT_ARTIFACT_DISK_BUDGET_BYTES = 500 * 1024 * 1024;

/**
 * Maximum size for inline payload in kahlo_artifacts_get (32 KB).
 */
export const INLINE_MAX_BYTES = 32 * 1024;

/**
 * Allowed artifact types (must match agent-side validation).
 */
const ALLOWED_ARTIFACT_TYPES = new Set([
  "file_dump",
  "memory_dump",
  "trace",
  "pcap_like",
  "custom",
]);

/**
 * Artifact record persisted to artifacts.jsonl and kept in memory.
 */
export interface ArtifactRecord {
  artifact_id: string;
  target_id: string;
  job_id: string;
  ts: string;
  type: string;
  size_bytes: number;
  stored_size_bytes: number;
  sha256: string;
  mime: string;
  name?: string;
  metadata?: Record<string, unknown>;
  storage_ref: string;
}

/**
 * Result of storing an artifact.
 */
export interface StoreArtifactResult {
  ok: boolean;
  artifact?: ArtifactRecord;
  error?: string;
}

/**
 * Per-target state tracking.
 */
interface TargetArtifactState {
  target_id: string;
  artifacts: Map<string, ArtifactRecord>;
  totalBytes: number;
  artifactsDir: string;
  indexPath: string;
  writer: fs.WriteStream;
  /** True if the write stream encountered an error. */
  streamErrored: boolean;
}

/**
 * In-memory index of all targets and their artifacts.
 */
const targetStates = new Map<string, TargetArtifactState>();

/**
 * Global index for fast artifact_id -> record lookup.
 */
const artifactIndex = new Map<string, ArtifactRecord>();

/**
 * Resolve the configured data directory to an absolute path.
 */
function resolveDataDirAbs(): string {
  return resolveDataDir(loadConfig());
}

/**
 * Clean up orphaned temporary files (.tmp) in an artifacts directory.
 * Called on startup to remove artifacts from interrupted writes.
 *
 * @param artifactsDir - Path to the artifacts directory
 */
function cleanupOrphanedTmpFiles(artifactsDir: string): void {
  try {
    fs.accessSync(artifactsDir, fs.constants.F_OK);
  } catch {
    return;
  }

  try {
    const files = fs.readdirSync(artifactsDir);
    for (const file of files) {
      if (file.endsWith(".tmp")) {
        const tmpPath = path.join(artifactsDir, file);
        try {
          fs.unlinkSync(tmpPath);
          console.log(`[ArtifactManager] Cleaned orphaned temp file: ${file}`);
        } catch {
          // Ignore cleanup failures - file may be locked or already deleted
        }
      }
    }
  } catch {
    // Ignore readdir failures - directory may not exist yet
  }
}

/**
 * Sanitize a filename hint - remove path separators and traversal attempts.
 * Returns undefined if the name is invalid or empty after sanitization.
 */
function sanitizeName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  // Remove path separators and traversal patterns
  const sanitized = name
    .replace(/\.\./g, "")
    .replace(/[/\\:*?"<>|]/g, "_")
    .trim();
  return sanitized.length > 0 && sanitized.length <= 255 ? sanitized : undefined;
}

/**
 * Derive file extension from MIME type or name hint.
 */
function deriveExtension(mime?: string, name?: string): string {
  // Try to get extension from name first
  if (name) {
    const ext = path.extname(name);
    if (ext && ext.length > 1 && ext.length <= 10) {
      return ext;
    }
  }
  // Fall back to MIME type mapping
  if (mime) {
    const mimeMap: Record<string, string> = {
      "application/octet-stream": ".bin",
      "application/json": ".json",
      "text/plain": ".txt",
      "image/png": ".png",
      "image/jpeg": ".jpg",
    };
    if (mimeMap[mime]) return mimeMap[mime];
  }
  return ".bin";
}

/**
 * Compute SHA-256 hash of a buffer.
 */
function computeSha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Convert various byte array types to a Node.js Buffer.
 */
function toBuffer(data: unknown): Buffer | null {
  if (data === null || data === undefined) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  // Handle array-like objects (Frida sometimes sends these)
  if (Array.isArray(data)) {
    return Buffer.from(data);
  }
  return null;
}

/**
 * Ensure target artifact state exists, creating directories and writer as needed.
 * Also cleans up any orphaned temporary files from previous interrupted writes.
 */
function ensureTargetState(target_id: string, ts?: string): TargetArtifactState {
  const existing = targetStates.get(target_id);
  if (existing) return existing;

  const timestamp = ts ?? isoNow();
  const dateDir = yyyyMmDdUtc(timestamp);
  const dataDir = resolveDataDirAbs();
  const targetDir = path.join(dataDir, "runs", dateDir, `target_${target_id}`);
  const artifactsDir = path.join(targetDir, "artifacts");

  // Create directories (sync to prevent double-init TOCTOU race)
  fs.mkdirSync(artifactsDir, { recursive: true });

  // Clean up any orphaned temp files from previous interrupted writes
  cleanupOrphanedTmpFiles(artifactsDir);

  const indexPath = path.join(targetDir, "artifacts.jsonl");
  const writer = fs.createWriteStream(indexPath, { flags: "a" });

  const state: TargetArtifactState = {
    target_id,
    artifacts: new Map(),
    totalBytes: 0,
    artifactsDir,
    indexPath,
    writer,
    streamErrored: false,
  };

  // Handle stream errors to prevent process crash
  writer.on("error", (err) => {
    console.error(`[ArtifactManager] WriteStream error for target ${target_id}:`, err.message);
    state.streamErrored = true;
  });

  targetStates.set(target_id, state);
  return state;
}

/**
 * Store an artifact to disk and update indices.
 *
 * Uses synchronous I/O to maintain single-tick atomicity and prevent TOCTOU
 * races (budget checks, duplicate ID checks, and ensureTargetState init all
 * execute within a single event loop tick). Read-only operations
 * (readArtifactPayload) remain async since they have no atomicity requirements.
 *
 * @param args - Artifact storage arguments
 * @returns Result indicating success or failure with details
 */
export function storeArtifact(args: {
  target_id: string;
  artifact_id: string;
  job_id: string;
  ts: string;
  type: string;
  size_bytes: number;
  mime?: string;
  name?: string;
  metadata?: Record<string, unknown>;
  data: unknown;
}): StoreArtifactResult {
  const {
    target_id,
    artifact_id,
    job_id,
    ts,
    type,
    size_bytes,
    mime,
    name,
    metadata,
    data,
  } = args;

  // Validate artifact type
  if (!ALLOWED_ARTIFACT_TYPES.has(type)) {
    return {
      ok: false,
      error: `Invalid artifact type: ${type}. Allowed: ${[...ALLOWED_ARTIFACT_TYPES].join(", ")}`,
    };
  }

  // Convert data to buffer
  const buffer = toBuffer(data);
  if (buffer === null && size_bytes > 0) {
    return {
      ok: false,
      error: "Missing or invalid binary payload",
    };
  }

  // Validate size matches
  const actualSize = buffer?.byteLength ?? 0;
  if (actualSize !== size_bytes) {
    return {
      ok: false,
      error: `Size mismatch: expected ${size_bytes} bytes, got ${actualSize} bytes`,
    };
  }

  // Get or create target state
  const state = ensureTargetState(target_id, ts);

  // Check disk budget
  if (state.totalBytes + actualSize > DEFAULT_ARTIFACT_DISK_BUDGET_BYTES) {
    return {
      ok: false,
      error: `Disk budget exceeded for target ${target_id}: ${state.totalBytes} + ${actualSize} > ${DEFAULT_ARTIFACT_DISK_BUDGET_BYTES} bytes`,
    };
  }

  // Check for duplicate artifact_id
  if (state.artifacts.has(artifact_id) || artifactIndex.has(artifact_id)) {
    return {
      ok: false,
      error: `Duplicate artifact_id: ${artifact_id}`,
    };
  }

  // Compute SHA-256
  const sha256 = buffer ? computeSha256(buffer) : crypto.createHash("sha256").update("").digest("hex");

  // Determine filename and path
  const sanitizedName = sanitizeName(name);
  const extension = deriveExtension(mime, sanitizedName);
  const filename = `${artifact_id}${extension}`;
  const filePath = path.join(state.artifactsDir, filename);
  const tmpPath = `${filePath}.tmp`;

  // ===== ATOMIC WRITE PATTERN =====
  // Step 1: Write blob to temp file
  // Step 2: Write index record to artifacts.jsonl
  // Step 3: Rename .tmp to final .bin
  // If crash occurs at any step, orphaned .tmp files are cleaned on startup

  // Step 1: Write blob to temp file (sync to stay in same event loop tick)
  try {
    if (buffer && buffer.byteLength > 0) {
      fs.writeFileSync(tmpPath, buffer);
    } else {
      // Write empty file for zero-byte artifacts
      fs.writeFileSync(tmpPath, Buffer.alloc(0));
    }
  } catch (err) {
    // Cleanup temp file if exists
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup failure
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Failed to write artifact to disk: ${errMsg}`,
    };
  }

  // Create artifact record
  const record: ArtifactRecord = {
    artifact_id,
    target_id,
    job_id,
    ts,
    type,
    size_bytes: actualSize,
    stored_size_bytes: actualSize,
    sha256,
    mime: mime ?? "application/octet-stream",
    name: sanitizedName,
    metadata,
    storage_ref: filePath,
  };

  // Step 2: Update in-memory indices and append to index file
  state.artifacts.set(artifact_id, record);
  state.totalBytes += actualSize;
  artifactIndex.set(artifact_id, record);

  // Write to index file (skip if stream has errored)
  if (!state.streamErrored) {
    try {
      const ok = state.writer.write(`${JSON.stringify(record)}\n`);
      if (!ok) {
        // Backpressure - log but continue (index record is in-memory)
      }
    } catch (err) {
      // Index write failed - rollback in-memory state and clean up temp file
      state.artifacts.delete(artifact_id);
      state.totalBytes -= actualSize;
      artifactIndex.delete(artifact_id);
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup failure
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `Failed to write artifact index: ${errMsg}`,
      };
    }
  }

  // Step 3: Atomic rename (on POSIX this is atomic within same filesystem)
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (renameErr) {
    const errMsg = renameErr instanceof Error ? renameErr.message : String(renameErr);
    console.error(
      `[ArtifactManager] Failed to finalize ${artifact_id}: ${errMsg}`
    );

    // Check if the .tmp file still exists so we can use it as a fallback
    let tmpFileExists = false;
    try {
      fs.accessSync(tmpPath, fs.constants.F_OK);
      tmpFileExists = true;
    } catch {
      // .tmp file is gone too - nothing to salvage
    }

    if (tmpFileExists) {
      // Fallback: update storage_ref to point at the .tmp path so the data
      // is still reachable. The record remains in indices with the adjusted path.
      record.storage_ref = tmpPath;
      // Re-set in maps so callers see the corrected storage_ref
      state.artifacts.set(artifact_id, record);
      artifactIndex.set(artifact_id, record);
      return {
        ok: true,
        artifact: record,
        error: `Rename failed, artifact stored at tmp path: ${errMsg}`,
      };
    }

    // Both rename and tmp file are gone - full rollback of in-memory state
    state.artifacts.delete(artifact_id);
    state.totalBytes -= actualSize;
    artifactIndex.delete(artifact_id);
    return {
      ok: false,
      error: `Failed to finalize artifact and tmp file lost: ${errMsg}`,
    };
  }

  return { ok: true, artifact: record };
}

/**
 * Get an artifact record by ID.
 */
export function getArtifact(artifact_id: string): ArtifactRecord | undefined {
  return artifactIndex.get(artifact_id);
}

/**
 * List artifacts for a target (across all jobs).
 */
export function listArtifactsByTarget(target_id: string): ArtifactRecord[] {
  const state = targetStates.get(target_id);
  if (!state) return [];
  return Array.from(state.artifacts.values());
}

/**
 * List artifacts for a specific job.
 */
export function listArtifactsByJob(job_id: string): ArtifactRecord[] {
  const results: ArtifactRecord[] = [];
  for (const record of artifactIndex.values()) {
    if (record.job_id === job_id) {
      results.push(record);
    }
  }
  return results;
}

/**
 * List all artifacts across all targets.
 */
export function listAllArtifacts(): ArtifactRecord[] {
  return Array.from(artifactIndex.values());
}

/**
 * Read artifact payload from disk.
 * Returns the raw bytes as a Buffer, or null if not found.
 */
export async function readArtifactPayload(artifact_id: string): Promise<Buffer | null> {
  const record = artifactIndex.get(artifact_id);
  if (!record) return null;

  try {
    return await fs.promises.readFile(record.storage_ref);
  } catch {
    return null;
  }
}

/**
 * Close the artifact writer for a target.
 * Called when a target is detached. Handles errored streams gracefully.
 */
export function closeTargetArtifactStore(target_id: string): void {
  const state = targetStates.get(target_id);
  if (!state) return;

  try {
    // Only attempt to end stream if it hasn't errored
    if (!state.streamErrored) {
      state.writer.end();
    }
  } catch {
    // Ignore close errors - stream may already be in error state
  }

  // Note: We don't remove from targetStates or artifactIndex
  // so artifacts remain queryable after detach
}

/**
 * Get artifact storage statistics for a target.
 */
export function getTargetArtifactStats(target_id: string): {
  artifact_count: number;
  total_bytes: number;
  budget_bytes: number;
  budget_remaining: number;
} | null {
  const state = targetStates.get(target_id);
  if (!state) return null;

  return {
    artifact_count: state.artifacts.size,
    total_bytes: state.totalBytes,
    budget_bytes: DEFAULT_ARTIFACT_DISK_BUDGET_BYTES,
    budget_remaining: DEFAULT_ARTIFACT_DISK_BUDGET_BYTES - state.totalBytes,
  };
}
