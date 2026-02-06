/**
 * Event Pipeline - Host-side event streaming and persistence.
 *
 * Responsibilities:
 * - Receive structured telemetry from Frida job scripts
 * - Buffer events in memory using ring buffers (per-target and per-job)
 * - Persist events to JSONL files for audit/replay
 * - Support cursor-based polling for efficient event retrieval
 * - Route artifact messages to the artifact manager
 *
 * Architecture:
 * - Each target has a dedicated event stream (ring buffer + JSONL writer)
 * - Each job within a target has its own sub-stream for job-scoped queries
 * - Ring buffers provide backpressure; when full, oldest events are dropped
 * - Dropped events are tracked and reported in subsequent fetches
 *
 * @module eventPipeline
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, resolveDataDir } from "../../config.js";
import {
  storeArtifact,
  closeTargetArtifactStore,
  type StoreArtifactResult,
} from "../artifacts/artifactManager.js";
import { updateJobFinalMetrics } from "../jobs/jobController.js";
import { isoNow, isRecord, asRecord, yyyyMmDdUtc } from "../../utils.js";

// Re-export artifact manager functions for tool implementations
export {
  getArtifact,
  listArtifactsByTarget,
  listArtifactsByJob,
  listAllArtifacts,
  readArtifactPayload,
  getTargetArtifactStats,
  INLINE_MAX_BYTES,
  type ArtifactRecord,
} from "../artifacts/artifactManager.js";

/** Log level for events (maps to standard severity). */
export type EventLevel = "debug" | "info" | "warn" | "error";

/**
 * A structured telemetry event emitted by a job.
 *
 * Events are the primary mechanism for jobs to communicate what they observe
 * during instrumentation (function calls, values, errors, etc.).
 */
export interface KahloEvent {
  /** Unique identifier for this event. */
  event_id: string;
  /** ISO-8601 timestamp when the event was generated (in-process time). */
  ts: string;
  /** Target ID that produced this event. */
  target_id: string;
  /** Process ID of the instrumented target. */
  pid?: number;
  /** Job ID that produced this event. */
  job_id: string;
  /** Event kind/type (e.g., "log", "function_call", "job.started"). */
  kind: string;
  /** Severity level. */
  level: EventLevel;
  /** Optional correlation ID for tracing related events. */
  correlation_id?: string;
  /** Event-specific payload data. */
  payload: Record<string, unknown>;
  /** Present if events were dropped due to ring buffer overflow. */
  dropped?: { count: number };
}

/**
 * Result of fetching events via cursor-based pagination.
 */
export interface KahloEventsFetchResult {
  /** Events matching the query. */
  events: KahloEvent[];
  /** The cursor that was provided in the request (echo). */
  cursor?: string;
  /** Cursor to use for the next fetch to get subsequent events. */
  next_cursor?: string;
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Coerce an unknown value to a valid EventLevel, defaulting to "info".
 *
 * @param v - Value to coerce
 * @returns Valid EventLevel
 */
function toLevel(v: unknown): EventLevel {
  return v === "debug" || v === "info" || v === "warn" || v === "error" ? v : "info";
}

/**
 * Get the byte length of binary data, if determinable.
 *
 * @param data - Binary data (ArrayBuffer, TypedArray, or array-like)
 * @returns Byte length, or null if not determinable
 */
function byteLength(data: unknown): number | null {
  if (data === null || data === undefined) return null;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  const maybeLen = (data as any)?.length;
  return typeof maybeLen === "number" && Number.isFinite(maybeLen) ? maybeLen : null;
}

/**
 * Resolve the configured data directory to an absolute path.
 */
function resolveDataDirAbs(): string {
  return resolveDataDir(loadConfig());
}

// ============================================================================
// Cursor Management
// ============================================================================

/** Scope for event fetch cursors: either target-wide or job-specific. */
type EventsFetchScope = "target" | "job";

/** Parsed cursor structure. */
interface ParsedCursor {
  /** Cursor scope. */
  scope: EventsFetchScope;
  /** Target ID or Job ID depending on scope. */
  id: string;
  /** Sequence number (events after this seq will be returned). */
  seq: number;
  /** Original raw cursor string. */
  raw: string;
}

/**
 * Create an opaque cursor string for pagination.
 *
 * Cursor format (v1):
 * - `v1:t:<target_id>:<seq>` for target-scoped streams
 * - `v1:j:<job_id>:<seq>` for job-scoped streams
 *
 * @param scope - Whether the cursor is for a target or job stream
 * @param id - Target ID or Job ID
 * @param seq - Sequence number (events after this will be returned on next fetch)
 * @returns Opaque cursor string
 */
function makeCursor(scope: EventsFetchScope, id: string, seq: number): string {
  const tag = scope === "target" ? "t" : "j";
  return `v1:${tag}:${id}:${Math.max(0, seq | 0)}`;
}

/**
 * Parse an opaque cursor string back into its components.
 *
 * @param raw - Cursor string from a previous fetch
 * @returns Parsed cursor, or null if invalid
 */
function parseCursor(raw: string): ParsedCursor | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const parts = raw.split(":");
  if (parts.length !== 4) return null;
  if (parts[0] !== "v1") return null;
  const tag = parts[1];
  const id = parts[2];
  const seqNum = Number(parts[3]);
  if (!Number.isFinite(seqNum)) return null;
  const seq = Math.max(0, Math.floor(seqNum));
  if (typeof id !== "string" || id.length === 0) return null;
  if (tag === "t") return { scope: "target", id, seq, raw };
  if (tag === "j") return { scope: "job", id, seq, raw };
  return null;
}

// ============================================================================
// Ring Buffer Implementation
// ============================================================================

/** Event with its sequence number for ordering. */
interface SequencedEvent {
  /** Monotonically increasing sequence number within the stream. */
  seq: number;
  /** The event payload. */
  ev: KahloEvent;
}

/**
 * Fixed-capacity ring buffer for event storage.
 *
 * Provides O(1) push and automatic eviction of oldest items when full.
 * Used to bound memory usage while retaining recent events for polling.
 *
 * @typeParam T - Type of items stored in the buffer
 */
class RingBuffer<T> {
  private readonly capacity: number;
  private readonly buf: Array<T | undefined>;
  private start = 0;
  private len = 0;

  /**
   * Create a new ring buffer with the specified capacity.
   *
   * @param capacity - Maximum number of items to retain
   */
  public constructor(capacity: number) {
    this.capacity = Math.max(1, capacity | 0);
    this.buf = new Array(this.capacity);
  }

  /**
   * Add an item to the buffer.
   *
   * If the buffer is full, the oldest item is evicted.
   *
   * @param item - Item to add
   * @returns Object indicating how many items were dropped (0 or 1)
   */
  public push(item: T): { dropped: number } {
    if (this.len < this.capacity) {
      this.buf[(this.start + this.len) % this.capacity] = item;
      this.len++;
      return { dropped: 0 };
    }

    // Overwrite oldest.
    this.buf[this.start] = item;
    this.start = (this.start + 1) % this.capacity;
    return { dropped: 1 };
  }

  /**
   * Get all items in the buffer, ordered oldest to newest.
   *
   * @returns Array of items in insertion order
   */
  public values(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.len; i++) {
      const idx = (this.start + i) % this.capacity;
      const v = this.buf[idx];
      if (v !== undefined) out.push(v);
    }
    return out;
  }
}

// ============================================================================
// Target State Management
// ============================================================================

/**
 * Per-stream state for event buffering.
 *
 * Each stream (target-level or job-level) maintains its own sequence counter,
 * ring buffer, and dropped event tracker.
 */
interface StreamState {
  /** Monotonically increasing sequence number for this stream. */
  seq: number;
  /** Number of events dropped since last fetch (due to buffer overflow). */
  pendingDropped: number;
  /** Ring buffer holding recent events. */
  ring: RingBuffer<SequencedEvent>;
}

/**
 * Per-target state for event management.
 *
 * Each target has:
 * - A target-level stream (all events for the target)
 * - Per-job sub-streams (events scoped to individual jobs)
 * - A JSONL writer for persistence
 */
interface TargetState {
  /** Target identifier. */
  target_id: string;
  /** Process ID of the target (updated as events arrive). */
  pid?: number;
  /** Target-level event stream. */
  byTarget: StreamState;
  /** Job-level event streams, keyed by job_id. */
  byJob: Map<string, StreamState>;
  /** JSONL file writer for persistence. */
  writer: fs.WriteStream;
  /** Path to the events.jsonl file. */
  logPath: string;
  /** True if the write stream encountered an error. */
  streamErrored: boolean;
  /** Count of backpressure events (write() returned false). */
  backpressureCount: number;
  /** Count of events dropped due to stream error. */
  droppedDueToError: number;
}

/** In-memory registry of all target states. */
const targets = new Map<string, TargetState>();

/**
 * Get or create target state for a given target.
 *
 * On first access, creates the target directory and opens the JSONL writer.
 *
 * @param target_id - Target identifier
 * @param pid - Optional process ID to associate
 * @returns Target state
 */
function ensureTargetState(target_id: string, pid?: number): TargetState {
  const existing = targets.get(target_id);
  if (existing) {
    existing.pid = pid ?? existing.pid;
    return existing;
  }

  const ts = isoNow();
  const dateDir = yyyyMmDdUtc(ts);
  const dataDir = resolveDataDirAbs();
  const targetDir = path.join(dataDir, "runs", dateDir, `target_${target_id}`);
  fs.mkdirSync(targetDir, { recursive: true });
  const logPath = path.join(targetDir, "events.jsonl");
  const writer = fs.createWriteStream(logPath, { flags: "a" });

  const state: TargetState = {
    target_id,
    pid,
    byTarget: { seq: 0, pendingDropped: 0, ring: new RingBuffer<SequencedEvent>(5000) },
    byJob: new Map(),
    writer,
    logPath,
    streamErrored: false,
    backpressureCount: 0,
    droppedDueToError: 0,
  };

  // Handle stream errors to prevent process crash
  writer.on("error", (err) => {
    console.error(`[EventPipeline] WriteStream error for target ${target_id}:`, err.message);
    state.streamErrored = true;
  });

  targets.set(target_id, state);
  return state;
}

/**
 * Get or create the stream state for a specific job within a target.
 *
 * @param state - Target state
 * @param job_id - Job identifier
 * @returns Job stream state
 */
function streamForJob(state: TargetState, job_id: string): StreamState {
  const existing = state.byJob.get(job_id);
  if (existing) return existing;
  const s: StreamState = { seq: 0, pendingDropped: 0, ring: new RingBuffer<SequencedEvent>(2000) };
  state.byJob.set(job_id, s);
  return s;
}

/**
 * Attach a dropped event marker to an event if there are pending drops.
 *
 * Resets the pending drop counter after attaching.
 *
 * @param stream - Stream state
 * @param ev - Event to potentially annotate
 * @returns Event with dropped marker if applicable
 */
function attachDroppedMarker(stream: StreamState, ev: KahloEvent): KahloEvent {
  if (stream.pendingDropped <= 0) return ev;
  const out: KahloEvent = { ...ev, dropped: { count: stream.pendingDropped } };
  stream.pendingDropped = 0;
  return out;
}

/**
 * Push an event into a stream, handling sequencing and overflow.
 *
 * @param stream - Stream state
 * @param ev - Event to push
 * @returns Sequenced event entry
 */
function pushStream(stream: StreamState, ev: KahloEvent): SequencedEvent {
  stream.seq++;
  const withDropped = attachDroppedMarker(stream, ev);
  const entry: SequencedEvent = { seq: stream.seq, ev: withDropped };
  const res = stream.ring.push(entry);
  if (res.dropped > 0) {
    stream.pendingDropped += res.dropped;
  }
  return entry;
}

/**
 * Persist an event to the target's JSONL file.
 *
 * Handles stream errors gracefully by skipping writes to errored streams.
 * Tracks backpressure events for monitoring but does not block.
 *
 * @param state - Target state
 * @param ev - Event to persist
 */
function persist(state: TargetState, ev: KahloEvent): void {
  // Skip writes if stream has errored
  if (state.streamErrored) {
    state.droppedDueToError++;
    return;
  }

  const ok = state.writer.write(`${JSON.stringify(ev)}\n`);
  if (!ok) {
    // Track backpressure but don't block - events are in ring buffer
    // and persistence is best-effort
    state.backpressureCount++;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Close the event pipeline for a target.
 *
 * Flushes and closes the JSONL writer, removes the target from the registry,
 * and closes the associated artifact store. Handles errored streams gracefully.
 *
 * @param target_id - Target identifier
 */
export function closeTargetEventPipeline(target_id: string): void {
  const state = targets.get(target_id);
  if (!state) return;

  // Log metrics if there were issues during the session
  if (state.backpressureCount > 0 || state.droppedDueToError > 0) {
    console.log(
      `[EventPipeline] Closing target ${target_id}: backpressure_events=${state.backpressureCount}, dropped_due_to_error=${state.droppedDueToError}`
    );
  }

  try {
    // Only attempt to end stream if it hasn't errored
    if (!state.streamErrored) {
      state.writer.end();
    }
  } catch {
    // ignore - stream may already be in error state
  } finally {
    targets.delete(target_id);
  }
  // Also close the artifact store for this target
  closeTargetArtifactStore(target_id);
}

/**
 * Get the path to the events JSONL file for a target.
 *
 * @param target_id - Target identifier
 * @returns Path to events.jsonl, or undefined if target not registered
 */
export function getTargetEventsLogPath(target_id: string): string | undefined {
  return targets.get(target_id)?.logPath;
}

/**
 * Handle a Frida message coming from a job script.
 *
 * Parses structured messages with the kahlo envelope format:
 * `{ type: 'send', payload: { kahlo: { type: 'event' | 'artifact', ... } } }`
 *
 * For event messages: Creates a KahloEvent and pushes to both target and job streams.
 * For artifact messages: Validates the envelope, stores the artifact, and emits a status event.
 *
 * @param args - Message arguments
 * @param args.target_id - Target that produced the message
 * @param args.pid - Process ID of the target
 * @param args.message - Raw Frida message object
 * @param args.data - Binary data attached to the message (for artifacts)
 */
export function recordAgentMessage(args: {
  target_id: string;
  pid?: number;
  message: unknown;
  data?: unknown;
}): void {
  const msg = asRecord(args.message);
  if (msg.type !== "send") return;
  const payload = msg.payload;
  const env = isRecord(payload) ? asRecord(payload).kahlo : undefined;
  if (!isRecord(env)) return;

  const state = ensureTargetState(args.target_id, args.pid);

  if (env.type === "event") {
    const ts = typeof env.ts === "string" ? env.ts : isoNow();
    const job_id = typeof env.job_id === "string" ? env.job_id : "<unknown>";
    const kind = typeof env.kind === "string" ? env.kind : "event";
    const level = toLevel(env.level);
    const correlation_id = typeof env.correlation_id === "string" ? env.correlation_id : undefined;
    const eventPayload = isRecord(env.payload) ? (env.payload as Record<string, unknown>) : {};

    const base: KahloEvent = {
      event_id: crypto.randomUUID(),
      ts,
      target_id: args.target_id,
      pid: state.pid,
      job_id,
      kind,
      level,
      correlation_id,
      payload: eventPayload,
    };

    const writtenTarget = pushStream(state.byTarget, base);
    pushStream(streamForJob(state, job_id), writtenTarget.ev);
    persist(state, writtenTarget.ev);

    // Capture final metrics for job completion/failure events
    if (kind === "job.completed" || kind === "job.failed") {
      if (
        eventPayload &&
        typeof eventPayload === "object" &&
        eventPayload.metrics &&
        typeof eventPayload.metrics === "object" &&
        typeof (eventPayload.metrics as Record<string, unknown>).events_emitted === "number" &&
        typeof (eventPayload.metrics as Record<string, unknown>).hooks_installed === "number" &&
        typeof (eventPayload.metrics as Record<string, unknown>).errors === "number"
      ) {
        updateJobFinalMetrics(job_id, eventPayload.metrics as {
          events_emitted: number;
          hooks_installed: number;
          errors: number;
        });
      }
    }
    return;
  }

  if (env.type === "artifact") {
    const ts = typeof env.ts === "string" ? env.ts : isoNow();
    const artifact = isRecord(env.artifact) ? asRecord(env.artifact) : null;

    const artifact_id = artifact && typeof artifact.artifact_id === "string" ? artifact.artifact_id : null;
    const job_id_raw =
      artifact && typeof artifact.job_id === "string" && artifact.job_id.trim().length > 0 ? artifact.job_id : null;
    const job_id = job_id_raw ?? "<unknown>";
    const artifactType = artifact && typeof artifact.type === "string" ? artifact.type : null;
    const mime = artifact && typeof artifact.mime === "string" ? artifact.mime : null;
    const name = artifact && typeof artifact.name === "string" ? artifact.name : null;
    const metadata = artifact && isRecord(artifact.metadata) ? (artifact.metadata as Record<string, unknown>) : null;
    const size_bytes = artifact && typeof artifact.size_bytes === "number" && Number.isFinite(artifact.size_bytes)
      ? Math.max(0, Math.floor(artifact.size_bytes))
      : null;

    const allowedTypes = new Set(["file_dump", "memory_dump", "trace", "pcap_like", "custom"]);
    const dataLen = byteLength(args.data);
    const isValidType = artifactType !== null && allowedTypes.has(artifactType);
    const hasBytes = dataLen !== null;
    const sizeMatches = size_bytes !== null && dataLen !== null ? size_bytes === dataLen : false;

    const envelopeOk =
      artifact_id !== null &&
      job_id_raw !== null &&
      isValidType &&
      size_bytes !== null &&
      (size_bytes === 0 ? true : hasBytes) &&
      (size_bytes === 0 ? true : sizeMatches);

    // Attempt to store the artifact if envelope validation passed
    let storeResult: StoreArtifactResult | null = null;
    if (envelopeOk && artifact_id && artifactType && size_bytes !== null) {
      storeResult = storeArtifact({
        target_id: args.target_id,
        artifact_id,
        job_id,
        ts,
        type: artifactType,
        size_bytes,
        mime: mime ?? undefined,
        name: name ?? undefined,
        metadata: metadata ?? undefined,
        data: args.data,
      });
    }

    const storedOk = storeResult?.ok ?? false;
    const ok = envelopeOk && storedOk;

    const kind = ok ? "artifact.stored" : envelopeOk ? "artifact.store_failed" : "artifact.invalid";
    const level: EventLevel = ok ? "info" : "error";

    const payload: Record<string, unknown> = {
      artifact_id,
      job_id,
      type: artifactType,
      size_bytes,
      actual_size_bytes: dataLen,
      mime,
      name,
      metadata,
    };

    // Add storage information to payload
    if (storeResult?.ok && storeResult.artifact) {
      payload.sha256 = storeResult.artifact.sha256;
      payload.storage_ref = storeResult.artifact.storage_ref;
      payload.stored_size_bytes = storeResult.artifact.stored_size_bytes;
    } else if (storeResult && !storeResult.ok) {
      payload.store_error = storeResult.error;
    }

    const base: KahloEvent = {
      event_id: crypto.randomUUID(),
      ts,
      target_id: args.target_id,
      pid: state.pid,
      job_id,
      kind,
      level,
      payload,
    };

    const writtenTarget = pushStream(state.byTarget, base);
    pushStream(streamForJob(state, job_id), writtenTarget.ev);
    persist(state, writtenTarget.ev);
  }
}

/**
 * Handle a Frida event message (no binary data).
 *
 * Convenience wrapper around recordAgentMessage for event-only messages.
 *
 * @param args - Message arguments
 * @param args.target_id - Target that produced the message
 * @param args.pid - Process ID of the target
 * @param args.message - Raw Frida message object
 */
export function recordAgentEventMessage(args: {
  target_id: string;
  pid?: number;
  message: unknown;
}): void {
  recordAgentMessage({ ...args, data: undefined });
}

// ============================================================================
// Event Filtering
// ============================================================================

/**
 * Check if an event matches the provided filters.
 *
 * @param ev - Event to check
 * @param filters - Optional filters to apply
 * @returns true if event matches all filters
 */
function matchesFilters(
  ev: KahloEvent,
  filters?: { kind?: string; level?: EventLevel }
): boolean {
  if (!filters) return true;
  if (filters.kind !== undefined && ev.kind !== filters.kind) return false;
  if (filters.level !== undefined && ev.level !== filters.level) return false;
  return true;
}

/**
 * Extract and validate filter options from an unknown input.
 *
 * @param filters - Raw filter input
 * @returns Validated filter object, or undefined if no valid filters
 */
function extractFilters(filters: unknown): { kind?: string; level?: EventLevel } | undefined {
  if (!isRecord(filters)) return undefined;
  const kind = typeof filters.kind === "string" ? filters.kind : undefined;
  const level = toLevel(filters.level);
  const hasLevel = typeof filters.level === "string";
  return kind !== undefined || hasLevel ? { kind, level: hasLevel ? level : undefined } : undefined;
}

/**
 * Get all registered target states.
 *
 * @returns Array of all target states
 */
function listAllTargetStates(): TargetState[] {
  return Array.from(targets.values());
}

/**
 * Find the appropriate stream for a fetch request.
 *
 * @param args - Scope arguments (exactly one of target_id or job_id should be set)
 * @returns Stream info, or null if not found
 */
function getStreamForScope(args: { target_id?: string; job_id?: string }):
  | { scope: EventsFetchScope; id: string; stream: StreamState; state?: TargetState }
  | null {
  if (args.target_id) {
    const state = targets.get(args.target_id);
    if (!state) return null;
    return { scope: "target", id: args.target_id, stream: state.byTarget, state };
  }
  if (args.job_id) {
    for (const st of listAllTargetStates()) {
      const s = st.byJob.get(args.job_id);
      if (s) return { scope: "job", id: args.job_id, stream: s, state: st };
    }
    // Allow polling before the first event: no stream exists yet.
    return null;
  }
  return null;
}

/**
 * Fetch events from the in-memory ring buffers using cursor-based pagination.
 *
 * This is the primary "live" path for event retrieval. Events are also persisted
 * to JSONL files for audit/replay, but this function reads from the in-memory
 * ring buffers for performance.
 *
 * Cursors are scoped to either a target stream or a job stream. Each fetch
 * returns a `next_cursor` that can be used to poll for subsequent events.
 *
 * If events were dropped due to ring buffer overflow between fetches, the
 * first returned event will have a `dropped` field indicating how many
 * events were missed.
 *
 * @param args - Fetch arguments
 * @param args.target_id - Fetch all events for this target (mutually exclusive with job_id)
 * @param args.job_id - Fetch events for this specific job (mutually exclusive with target_id)
 * @param args.cursor - Cursor from previous fetch (omit for first fetch)
 * @param args.limit - Maximum events to return (default: 200, max: 5000)
 * @param args.filters - Optional filters (e.g., `{ kind: 'log', level: 'error' }`)
 * @returns Events and next cursor for pagination
 */
export function fetchEvents(args: {
  target_id?: string;
  job_id?: string;
  cursor?: string;
  limit?: number;
  filters?: unknown;
}): KahloEventsFetchResult {
  const limit = Math.max(1, Math.min(5000, (args.limit ?? 200) | 0));

  const scopeProvided = (args.target_id ? 1 : 0) + (args.job_id ? 1 : 0);
  if (scopeProvided !== 1) {
    // Tool layer should validate this; keep backend defensive.
    return {
      events: [],
      cursor: args.cursor,
      next_cursor: args.cursor,
    };
  }

  const streamInfo = getStreamForScope({ target_id: args.target_id, job_id: args.job_id });
  if (!streamInfo) {
    const scope: EventsFetchScope = args.target_id ? "target" : "job";
    const id = args.target_id ?? args.job_id ?? "<unknown>";
    const next_cursor = makeCursor(scope, id, 0);
    return { events: [], cursor: args.cursor, next_cursor };
  }

  const parsed = args.cursor ? parseCursor(args.cursor) : null;
  if (parsed) {
    // Cursor must match requested scope/id.
    if (parsed.scope !== streamInfo.scope || parsed.id !== streamInfo.id) {
      // Treat as empty but advance to a sane cursor for this stream.
      const next_cursor = makeCursor(streamInfo.scope, streamInfo.id, streamInfo.stream.seq);
      return { events: [], cursor: args.cursor, next_cursor };
    }
  }

  const sinceSeq = parsed ? parsed.seq : 0;
  const filters = extractFilters(args.filters);

  const items = streamInfo.stream.ring.values(); // ordered oldest->newest
  if (items.length === 0) {
    const next_cursor = makeCursor(streamInfo.scope, streamInfo.id, sinceSeq);
    return { events: [], cursor: args.cursor, next_cursor };
  }

  const minSeq = items[0].seq;
  const maxSeq = items[items.length - 1].seq;

  // Select events newer than sinceSeq.
  const out: KahloEvent[] = [];
  let lastSeqReturned = sinceSeq;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.seq <= sinceSeq) continue;
    if (!matchesFilters(it.ev, filters)) continue;
    out.push(it.ev);
    lastSeqReturned = it.seq;
    if (out.length >= limit) break;
  }

  // If the caller's cursor is behind our oldest retained event, they missed events.
  const missed = sinceSeq < minSeq - 1 ? (minSeq - 1 - sinceSeq) : 0;
  if (missed > 0 && out.length > 0) {
    const first = out[0];
    const prev = first.dropped?.count ?? 0;
    out[0] = { ...first, dropped: { count: prev + missed } };
  }

  const next_cursor = makeCursor(streamInfo.scope, streamInfo.id, lastSeqReturned);
  return { events: out, cursor: args.cursor, next_cursor };
}

