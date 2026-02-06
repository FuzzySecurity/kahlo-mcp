/**
 * Draft Manager - Host-side draft module store and persistence.
 *
 * Responsibilities:
 * - Create, read, update, and list draft modules
 * - Persist drafts to disk under data_dir/drafts/<draft_id>.json
 * - Track provenance (derived_from_job_id) for drafts created from jobs
 *
 * Drafts are mutable "work in progress" modules that agents can iterate on
 * before promoting to permanent versioned modules.
 *
 * @module draftManager
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, resolveDataDir } from "../../config.js";
import { isoNow, KeyedLock } from "../../utils.js";

/**
 * Draft record persisted to disk and kept in memory.
 */
export interface DraftRecord {
  draft_id: string;
  name?: string;
  source: string;
  manifest?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  derived_from_job_id?: string;
}

/**
 * Error thrown by draft manager operations.
 */
export class DraftManagerError extends Error {
  public readonly code: "NOT_FOUND" | "VALIDATION_ERROR" | "INTERNAL" | "ALREADY_EXISTS";
  public readonly details?: Record<string, unknown>;

  constructor(
    code: DraftManagerError["code"],
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "DraftManagerError";
    this.code = code;
    this.details = details;
  }
}

/**
 * In-memory index of all drafts.
 */
const draftsById = new Map<string, DraftRecord>();

/**
 * Whether the draft store has been initialized from disk.
 */
let initialized = false;

/**
 * Lock for serializing write operations (create, update, delete).
 * Uses a single key since all drafts share the same global state.
 */
const draftOpsLock = new KeyedLock();
const DRAFT_WRITE_LOCK_KEY = "draft_write";

/**
 * Generate a new draft ID.
 */
function createDraftId(): string {
  return `draft_${crypto.randomUUID()}`;
}

/**
 * Resolve the drafts directory path.
 */
function getDraftsDir(): string {
  const dataDir = resolveDataDir(loadConfig());
  return path.join(dataDir, "drafts");
}

/**
 * Get the file path for a draft.
 */
function getDraftPath(draft_id: string): string {
  return path.join(getDraftsDir(), `${draft_id}.json`);
}

/**
 * Ensure the drafts directory exists.
 */
function ensureDraftsDir(): void {
  const draftsDir = getDraftsDir();
  if (!fs.existsSync(draftsDir)) {
    fs.mkdirSync(draftsDir, { recursive: true });
  }
}

/**
 * Clean up orphaned temporary files from interrupted writes.
 * Called during initialization to remove .tmp files left behind by crashes.
 */
function cleanupOrphanedTmpFiles(draftsDir: string): void {
  try {
    const files = fs.readdirSync(draftsDir);
    for (const file of files) {
      if (file.endsWith(".tmp")) {
        const tmpPath = path.join(draftsDir, file);
        try {
          fs.unlinkSync(tmpPath);
          console.log(`[DraftManager] Cleaned orphaned temp file: ${file}`);
        } catch {
          // Ignore cleanup failures
        }
      }
    }
  } catch {
    // Ignore readdir failures
  }
}

/**
 * Initialize the draft store by loading existing drafts from disk.
 */
export function initializeDraftStore(): void {
  if (initialized) return;

  ensureDraftsDir();
  const draftsDir = getDraftsDir();

  // Clean up orphaned temp files from previous interrupted writes
  cleanupOrphanedTmpFiles(draftsDir);

  try {
    const files = fs.readdirSync(draftsDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filePath = path.join(draftsDir, file);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const draft = JSON.parse(content) as DraftRecord;
        if (draft.draft_id) {
          draftsById.set(draft.draft_id, draft);
        }
      } catch {
        // Skip invalid files
      }
    }
  } catch {
    // Directory might not exist yet, that's fine
  }

  initialized = true;
}

/**
 * Persist a draft to disk atomically.
 * Uses temp file + rename pattern to prevent corruption on crash.
 */
function persistDraft(draft: DraftRecord): void {
  ensureDraftsDir();
  const filePath = getDraftPath(draft.draft_id);
  const tmpPath = `${filePath}.tmp`;

  // Write to temp file first
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(draft, null, 2), "utf-8");
  } catch (err) {
    // Cleanup temp file if exists
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup failure
    }
    throw err;
  }

  // Atomic rename (on POSIX this is atomic within same filesystem)
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Cleanup temp file on rename failure
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup failure
    }
    throw err;
  }
}

/**
 * Create a new draft from source code.
 *
 * @param args - Draft creation arguments
 * @returns The created draft record
 */
export async function createDraft(args: {
  name?: string;
  source: string;
  manifest?: Record<string, unknown>;
  derived_from_job_id?: string;
}): Promise<DraftRecord> {
  // Validate before acquiring lock
  if (typeof args.source !== "string" || args.source.trim().length === 0) {
    throw new DraftManagerError("VALIDATION_ERROR", "source must be a non-empty string");
  }

  return draftOpsLock.withLock(DRAFT_WRITE_LOCK_KEY, async () => {
    initializeDraftStore();

    const now = isoNow();
    const draft: DraftRecord = {
      draft_id: createDraftId(),
      name: args.name?.trim() || undefined,
      source: args.source,
      manifest: args.manifest,
      created_at: now,
      updated_at: now,
      derived_from_job_id: args.derived_from_job_id,
    };

    persistDraft(draft);
    draftsById.set(draft.draft_id, draft);

    return draft;
  });
}

/**
 * Get a draft by ID.
 *
 * @param draft_id - Draft identifier
 * @returns The draft record
 * @throws DraftManagerError if not found
 */
export function getDraft(draft_id: string): DraftRecord {
  initializeDraftStore();

  const draft = draftsById.get(draft_id);
  if (!draft) {
    throw new DraftManagerError("NOT_FOUND", `Unknown draft_id: ${draft_id}`, { draft_id });
  }
  // Return a shallow copy to prevent race conditions during promotion.
  // Concurrent updateDraft() calls won't affect the returned snapshot.
  return { ...draft };
}

/**
 * Update a draft's source code.
 *
 * @param args - Update arguments
 * @returns The updated draft record
 * @throws DraftManagerError if not found or validation fails
 */
export async function updateDraft(args: {
  draft_id: string;
  source: string;
}): Promise<DraftRecord> {
  // Validate before acquiring lock
  if (typeof args.source !== "string" || args.source.trim().length === 0) {
    throw new DraftManagerError("VALIDATION_ERROR", "source must be a non-empty string");
  }

  return draftOpsLock.withLock(DRAFT_WRITE_LOCK_KEY, async () => {
    initializeDraftStore();

    const draft = draftsById.get(args.draft_id);
    if (!draft) {
      throw new DraftManagerError("NOT_FOUND", `Unknown draft_id: ${args.draft_id}`, {
        draft_id: args.draft_id,
      });
    }

    draft.source = args.source;
    draft.updated_at = isoNow();

    persistDraft(draft);
    return draft;
  });
}

/**
 * List all drafts.
 *
 * @returns Array of draft records (without full source for efficiency)
 */
export function listDrafts(): Array<Omit<DraftRecord, "source"> & { source_length: number }> {
  initializeDraftStore();

  const results: Array<Omit<DraftRecord, "source"> & { source_length: number }> = [];
  for (const draft of draftsById.values()) {
    results.push({
      draft_id: draft.draft_id,
      name: draft.name,
      manifest: draft.manifest,
      created_at: draft.created_at,
      updated_at: draft.updated_at,
      derived_from_job_id: draft.derived_from_job_id,
      source_length: draft.source.length,
    });
  }

  // Sort by updated_at descending (most recent first)
  results.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return results;
}

/**
 * Delete a draft.
 *
 * @param draft_id - Draft identifier
 * @throws DraftManagerError if not found
 */
export async function deleteDraft(draft_id: string): Promise<void> {
  return draftOpsLock.withLock(DRAFT_WRITE_LOCK_KEY, async () => {
    initializeDraftStore();

    if (!draftsById.has(draft_id)) {
      throw new DraftManagerError("NOT_FOUND", `Unknown draft_id: ${draft_id}`, { draft_id });
    }

    // Remove from disk
    const filePath = getDraftPath(draft_id);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Best effort
    }

    // Remove from memory
    draftsById.delete(draft_id);
  });
}
