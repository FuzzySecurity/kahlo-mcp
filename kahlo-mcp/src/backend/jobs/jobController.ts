import crypto from "node:crypto";
import type { TargetGating, TargetMode } from "../targets/targetManager.js";
import {
  TargetManagerError,
  createJobScript,
  unloadJobScript,
  getJobScriptExports,
  onJobScriptDestroyed,
} from "../targets/targetManager.js";
import { getJobScriptRuntimeSource } from "./jobScriptGenerator.js";
import { recordAgentMessage } from "../events/eventPipeline.js";
import { isoNow, KeyedLock } from "../../utils.js";

// ============================================================================
// Types and Constants
// ============================================================================

export type JobType = "oneshot" | "interactive" | "daemon";

/**
 * Module provenance for traceability - tracks where the job's code came from.
 */
export type ModuleProvenance =
  | { kind: "source" }
  | { kind: "draft_id"; draft_id: string }
  | { kind: "module_ref"; module_ref: string }
  | { kind: "bootstrap" };

export class JobControllerError extends Error {
  public readonly code: "NOT_IMPLEMENTED" | "INVALID_ARGUMENT" | "NOT_FOUND" | "UNAVAILABLE" | "INTERNAL";
  public readonly details?: Record<string, unknown>;

  public constructor(
    code: JobControllerError["code"],
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "JobControllerError";
    this.code = code;
    this.details = details;
  }
}

interface JobEntry {
  job_id: string;
  target_id: string;
  type: JobType;
  module_source: string;
  /** Provenance: where the module code came from (source/draft_id/module_ref/bootstrap) */
  module_provenance?: ModuleProvenance;
  ttl_timer?: NodeJS.Timeout;
  /**
   * Whether this is a bootstrap job (spawn+gating early hook installation).
   * Bootstrap jobs run while the process is suspended and persist after completion.
   */
  is_bootstrap?: boolean;
  /** Job state */
  state?: "queued" | "starting" | "running" | "completed" | "failed" | "cancelled";
  /** Last heartbeat timestamp for daemon jobs */
  last_heartbeat?: string;
  /** Final metrics snapshot captured when job completes/fails/cancels */
  metrics?: { events_emitted: number; hooks_installed: number; errors: number };
  /** Error details for failed jobs */
  error?: { message: string };
  /** Result for completed jobs */
  result?: unknown;
  /** Creation timestamp */
  created_at?: string;
  /** Last update timestamp */
  updated_at?: string;
}

const jobsById = new Map<string, JobEntry>();

/** Heartbeat timeout threshold for daemon jobs (in milliseconds). */
const DAEMON_HEARTBEAT_TIMEOUT_MS = 30_000;

/** How long terminal-state jobs are retained before pruning (1 hour). */
const JOB_HISTORY_RETENTION_MS = 60 * 60 * 1000;

/**
 * Lock for serializing job operations.
 *
 * Operations on the same job_id are serialized to prevent race conditions
 * (e.g., concurrent start and cancel, or double-start).
 */
const jobOpsLock = new KeyedLock();

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Generate a unique job ID.
 */
function newJobId(): string {
  return `job_${crypto.randomUUID()}`;
}

/**
 * Calculate job health based on type, state, and heartbeat.
 * - oneshot/interactive jobs: "unknown" (heartbeat not expected)
 * - daemon jobs in running state: "healthy" if heartbeat within threshold, "unhealthy" otherwise
 * - completed/failed/cancelled jobs: "unknown"
 */
function calculateJobHealth(
  type: string,
  state: string,
  heartbeat: string | null | undefined
): "healthy" | "unhealthy" | "unknown" {
  if (type !== "daemon") {
    return "unknown";
  }

  if (state !== "running") {
    return "unknown";
  }

  if (!heartbeat) {
    return "unhealthy";
  }

  const heartbeatTime = new Date(heartbeat).getTime();
  const now = Date.now();
  const elapsed = now - heartbeatTime;

  return elapsed <= DAEMON_HEARTBEAT_TIMEOUT_MS ? "healthy" : "unhealthy";
}

function wrapTargetError(err: unknown): never {
  if (err instanceof TargetManagerError) {
    throw new JobControllerError(err.code, err.message, err.details);
  }
  const msg = err instanceof Error ? err.message : String(err);
  throw new JobControllerError("INTERNAL", msg);
}

// ============================================================================
// Terminal Job Pruning
// ============================================================================

const TERMINAL_STATES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

/**
 * Remove terminal-state jobs that have exceeded the retention period.
 *
 * For each entry in `jobsById` whose state is completed/failed/cancelled and
 * whose `updated_at` timestamp is older than `JOB_HISTORY_RETENTION_MS`, the
 * entry is deleted from the map. This prevents unbounded growth of the in-memory
 * job history (issue 16.21).
 *
 * Called opportunistically at the start of {@link startJob} so there is no
 * background timer to manage.
 */
function pruneTerminalJobs(): void {
  const cutoff = Date.now() - JOB_HISTORY_RETENTION_MS;

  for (const [job_id, entry] of jobsById) {
    if (!TERMINAL_STATES.has(entry.state ?? "")) continue;

    const updatedMs = entry.updated_at ? new Date(entry.updated_at).getTime() : 0;
    if (updatedMs < cutoff) {
      // Clear any lingering TTL timer (defensive)
      if (entry.ttl_timer) {
        clearTimeout(entry.ttl_timer);
      }
      jobsById.delete(job_id);
    }
  }
}

// ============================================================================
// Job Metrics Persistence
// ============================================================================

/**
 * Update a job's final metrics from a completion/failure event.
 *
 * Called by the event pipeline when processing job.completed or job.failed events.
 * This captures the metrics snapshot at the moment of job termination so that
 * subsequent status queries can return metrics even after the script is unloaded.
 *
 * @param job_id - Job identifier
 * @param metrics - Final metrics snapshot from the job
 */
export function updateJobFinalMetrics(
  job_id: string,
  metrics: { events_emitted: number; hooks_installed: number; errors: number }
): void {
  const entry = jobsById.get(job_id);
  if (!entry) return;

  // Only update if we don't already have metrics (first completion event wins)
  if (!entry.metrics) {
    entry.metrics = metrics;
  }
}

// ============================================================================
// Job Source and Provenance
// ============================================================================

/**
 * Get the source code for a job.
 * Used by draft manager to create drafts from jobs.
 *
 * @param job_id - Job identifier
 * @returns The job's source code
 * @throws JobControllerError if not found
 */
export function getJobSource(job_id: string): string {
  const entry = jobsById.get(job_id);
  if (!entry) {
    throw new JobControllerError("NOT_FOUND", `Unknown job_id: ${job_id}`, { job_id });
  }
  return entry.module_source;
}

/**
 * Get the provenance for a job (where the module code came from).
 *
 * @param job_id - Job identifier
 * @returns The job's module provenance
 * @throws JobControllerError if not found
 */
export function getJobProvenance(job_id: string): ModuleProvenance | undefined {
  const entry = jobsById.get(job_id);
  if (!entry) {
    throw new JobControllerError("NOT_FOUND", `Unknown job_id: ${job_id}`, { job_id });
  }
  return entry.module_provenance;
}

// ============================================================================
// Job Lifecycle
// ============================================================================

/**
 * Start a job in an isolated Frida script.
 *
 * Each job runs in its own Frida script instance, providing full hook isolation.
 * When cancelled, the script is unloaded and Frida automatically cleans up all
 * hooks, timers, and state.
 *
 * @param args - Job configuration
 * @returns The job ID
 */
export async function startJob(args: {
  target_id: string;
  type: JobType;
  module_source: string;
  module_provenance?: ModuleProvenance;
  params?: Record<string, unknown>;
  ttl?: number;
}): Promise<string> {
  // Validate module source
  if (typeof args.module_source !== "string" || args.module_source.trim().length === 0) {
    throw new JobControllerError("INVALID_ARGUMENT", "module_source must be a non-empty string");
  }

  // Opportunistically prune stale terminal jobs to bound memory (issue 16.21)
  pruneTerminalJobs();

  // Generate job ID upfront
  const job_id = newJobId();

  // Serialize operations on this job_id to prevent race conditions
  return jobOpsLock.withLock(job_id, async () => {
    const now = isoNow();

    // Get the job script runtime source
    let runtimeSource: string;
    try {
      runtimeSource = getJobScriptRuntimeSource();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new JobControllerError("INTERNAL", `Failed to load job script runtime: ${msg}`);
    }

    // Create and load the script
    let script: any;
    try {
      script = await createJobScript(args.target_id, job_id, runtimeSource);
    } catch (err) {
      if (err instanceof TargetManagerError) {
        throw new JobControllerError(err.code, err.message, err.details);
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new JobControllerError("UNAVAILABLE", msg);
    }

    // Create job entry BEFORE starting (so it's tracked even if start fails)
    const entry: JobEntry = {
      job_id,
      target_id: args.target_id,
      type: args.type,
      module_source: args.module_source,
      module_provenance: args.module_provenance ?? { kind: "source" },
      state: "queued",
      created_at: now,
      updated_at: now,
    };
    jobsById.set(job_id, entry);

    // Start the job via RPC
    try {
      const exports = script.exports as any;
      const startResult = await exports.startJob({
        job_id,
        job_type: args.type,
        module_source: args.module_source,
        params: args.params ?? {},
      });

      if (!startResult.ok) {
        entry.state = "failed";
        entry.error = { message: startResult.error || "Start failed" };
        entry.updated_at = isoNow();
        await unloadJobScript(args.target_id, job_id).catch(() => {});
        throw new JobControllerError("UNAVAILABLE", startResult.error || "Job start failed");
      }

      entry.state = startResult.state || "running";
      entry.updated_at = isoNow();
    } catch (err) {
      if (err instanceof JobControllerError) {
        throw err;
      }
      entry.state = "failed";
      entry.error = { message: err instanceof Error ? err.message : String(err) };
      entry.updated_at = isoNow();
      await unloadJobScript(args.target_id, job_id).catch(() => {});
      const msg = err instanceof Error ? err.message : String(err);
      throw new JobControllerError("UNAVAILABLE", msg);
    }

    // Set up TTL timer if specified
    if (args.ttl !== undefined) {
      entry.ttl_timer = setTimeout(() => {
        void cancelJob({ job_id }).catch(() => undefined);
      }, args.ttl * 1000);
    }

    return job_id;
  });
}

/**
 * Start a bootstrap job for early hook installation.
 *
 * Bootstrap jobs run while the process is suspended (during spawn+gating)
 * and their hooks persist even after the job's start() function returns.
 *
 * This function acquires a target-level lock to prevent concurrent bootstrap
 * jobs on the same target, in addition to the job-level lock.
 *
 * @param args - Bootstrap job configuration
 * @returns The job ID
 */
export async function startBootstrapJob(args: {
  target_id: string;
  type: JobType;
  module_source: string;
  params?: Record<string, unknown>;
}): Promise<string> {
  // Validate module source
  if (typeof args.module_source !== "string" || args.module_source.trim().length === 0) {
    throw new JobControllerError("INVALID_ARGUMENT", "module_source must be a non-empty string");
  }

  // Generate job ID upfront
  const job_id = newJobId();

  // Lock on target_id to prevent concurrent bootstrap jobs for the same target.
  // Note: No inner lock on job_id is needed because the job_id is freshly generated
  // and cannot be referenced by other code until this function returns.
  const bootstrapLockKey = `bootstrap:${args.target_id}`;
  return jobOpsLock.withLock(bootstrapLockKey, async () => {
    const now = isoNow();

    // Get the job script runtime source
    let runtimeSource: string;
    try {
      runtimeSource = getJobScriptRuntimeSource();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new JobControllerError("INTERNAL", `Failed to load job script runtime: ${msg}`);
    }

    // Create and load the script
    let script: any;
    try {
      script = await createJobScript(args.target_id, job_id, runtimeSource);
    } catch (err) {
      if (err instanceof TargetManagerError) {
        throw new JobControllerError(err.code, err.message, err.details);
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new JobControllerError("UNAVAILABLE", msg);
    }

    // Create job entry
    const entry: JobEntry = {
      job_id,
      target_id: args.target_id,
      type: args.type,
      module_source: args.module_source,
      module_provenance: { kind: "bootstrap" },
      is_bootstrap: true,
      state: "queued",
      created_at: now,
      updated_at: now,
    };
    jobsById.set(job_id, entry);

    // Start the job via RPC
    try {
      const exports = script.exports as any;
      const startResult = await exports.startJob({
        job_id,
        job_type: args.type,
        module_source: args.module_source,
        params: args.params ?? {},
      });

      if (!startResult.ok) {
        entry.state = "failed";
        entry.error = { message: startResult.error || "Start failed" };
        entry.updated_at = isoNow();
        await unloadJobScript(args.target_id, job_id).catch(() => {});
        throw new JobControllerError("UNAVAILABLE", startResult.error || "Bootstrap job start failed");
      }

      entry.state = startResult.state || "running";
      entry.updated_at = isoNow();
    } catch (err) {
      if (err instanceof JobControllerError) {
        throw err;
      }
      entry.state = "failed";
      entry.error = { message: err instanceof Error ? err.message : String(err) };
      entry.updated_at = isoNow();
      await unloadJobScript(args.target_id, job_id).catch(() => {});
      const msg = err instanceof Error ? err.message : String(err);
      throw new JobControllerError("UNAVAILABLE", msg);
    }

    return job_id;
  });
}

/**
 * Get job status.
 *
 * @param args - Job identifier
 * @returns Job status
 */
export async function jobStatus(args: { job_id: string }): Promise<Record<string, unknown>> {
  const entry = jobsById.get(args.job_id);
  if (!entry) {
    throw new JobControllerError("NOT_FOUND", `Unknown job_id: ${args.job_id}`, { job_id: args.job_id });
  }

  // For terminal states, return host-tracked state
  if (entry.state === "cancelled" || entry.state === "failed" || entry.state === "completed") {
    return {
      job_id: entry.job_id,
      target_id: entry.target_id,
      type: entry.type,
      state: entry.state,
      health: "unknown",
      heartbeat: entry.last_heartbeat || undefined,
      metrics: entry.metrics || undefined,
      result: entry.result || undefined,
      error: entry.error || undefined,
      created_at: entry.created_at,
      updated_at: entry.updated_at,
    };
  }

  // For running jobs, query the script for live status
  try {
    const exports = getJobScriptExports(entry.target_id, args.job_id);
    const status = await exports.getStatus();

    // Update host-tracked state from script
    entry.state = status.state || entry.state;
    entry.last_heartbeat = status.heartbeat || entry.last_heartbeat;
    entry.result = status.result;
    entry.error = status.error;
    entry.updated_at = isoNow();

    // Calculate health
    const health = calculateJobHealth(entry.type, entry.state || "unknown", entry.last_heartbeat);

    return {
      job_id: entry.job_id,
      target_id: entry.target_id,
      type: entry.type,
      state: entry.state,
      health,
      heartbeat: entry.last_heartbeat || undefined,
      metrics: status.metrics || undefined,
      result: entry.result || undefined,
      error: entry.error || undefined,
      created_at: entry.created_at,
      updated_at: entry.updated_at,
    };
  } catch (err) {
    // Script may have crashed - return host state
    if (entry.state === "running") {
      entry.state = "failed";
      entry.error = { message: "Script crashed or became unavailable" };
      entry.updated_at = isoNow();
    }

    return {
      job_id: entry.job_id,
      target_id: entry.target_id,
      type: entry.type,
      state: entry.state,
      health: "unknown",
      heartbeat: entry.last_heartbeat || undefined,
      result: entry.result || undefined,
      error: entry.error || undefined,
      created_at: entry.created_at,
      updated_at: entry.updated_at,
    };
  }
}

/**
 * List all jobs for a target.
 *
 * @param args - Target identifier
 * @returns Array of job records
 */
export async function listJobs(args: { target_id: string }): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = [];

  for (const entry of jobsById.values()) {
    if (entry.target_id !== args.target_id) continue;

    const health = calculateJobHealth(entry.type, entry.state || "unknown", entry.last_heartbeat);
    result.push({
      job_id: entry.job_id,
      target_id: entry.target_id,
      type: entry.type,
      state: entry.state || "unknown",
      health,
      heartbeat: entry.last_heartbeat || undefined,
      result: entry.result || undefined,
      error: entry.error || undefined,
      created_at: entry.created_at,
      updated_at: entry.updated_at,
      is_bootstrap: entry.is_bootstrap || undefined,
    });
  }

  return result;
}

/**
 * Cancel a job by unloading its script.
 *
 * When the script is unloaded, Frida automatically removes all:
 * - Interceptor.attach() hooks
 * - Interceptor.replace() replacements
 * - Java.use().implementation replacements
 * - Timers (setTimeout, setInterval)
 * - Any other script-local state
 *
 * This function is idempotent and handles edge cases gracefully:
 * - Already in terminal state (cancelled/failed/completed) → returns current state
 * - Target already detached → job is marked cancelled (best-effort unload)
 * - Script already destroyed → job is marked cancelled (warning logged)
 *
 * @param args - Job identifier
 * @returns Updated job state
 * @throws JobControllerError if job_id is unknown
 */
export async function cancelJob(args: { job_id: string }): Promise<Record<string, unknown>> {
  // Serialize operations on this job_id to prevent race conditions
  return jobOpsLock.withLock(args.job_id, async () => {
    const entry = jobsById.get(args.job_id);
    if (!entry) {
      throw new JobControllerError("NOT_FOUND", `Unknown job_id: ${args.job_id}`, { job_id: args.job_id });
    }

    // If already in a terminal state, return current state without re-cancelling
    if (entry.state === "cancelled" || entry.state === "failed" || entry.state === "completed") {
      return {
        job_id: entry.job_id,
        target_id: entry.target_id,
        type: entry.type,
        state: entry.state,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
      };
    }

    // Clear TTL timer
    if (entry.ttl_timer) {
      clearTimeout(entry.ttl_timer);
      entry.ttl_timer = undefined;
    }

    // Capture final metrics BEFORE unloading the script.
    // The RPC call might fail if the script is already crashed/unresponsive,
    // which is acceptable - we proceed with cancellation regardless.
    if (!entry.metrics) {
      try {
        const exports = getJobScriptExports(entry.target_id, args.job_id);
        if (exports && typeof exports.getStatus === "function") {
          const status = await exports.getStatus();
          if (status && status.metrics) {
            entry.metrics = status.metrics;
          }
        }
      } catch {
        // Script may already be unresponsive or destroyed - continue with cancellation
      }
    }

    // Mark as cancelled BEFORE unloading so the destroyed callback
    // sees we're already in a terminal state and doesn't set error
    entry.state = "cancelled";
    entry.updated_at = isoNow();

    // Unload the script - Frida handles all cleanup
    try {
      await unloadJobScript(entry.target_id, args.job_id);
    } catch (err) {
      // Best-effort unload - script may already be destroyed
      console.warn(`[kahlo] Failed to unload job script: ${err}`);
    }

    return {
      job_id: entry.job_id,
      target_id: entry.target_id,
      type: entry.type,
      state: entry.state,
      metrics: entry.metrics,
      created_at: entry.created_at,
      updated_at: entry.updated_at,
    };
  });
}

/**
 * Cancel all jobs for a target.
 *
 * @param args - Target identifier
 * @returns Number of cancelled jobs
 */
export async function cancelAllJobsForTarget(args: { target_id: string }): Promise<{ cancelled: number }> {
  let cancelled = 0;

  for (const [job_id, entry] of jobsById.entries()) {
    if (entry.target_id !== args.target_id) continue;

    // Skip already-terminal jobs
    if (entry.state === "cancelled" || entry.state === "failed" || entry.state === "completed") {
      continue;
    }

    try {
      await cancelJob({ job_id });
      cancelled++;
    } catch {
      // Best-effort - continue with other jobs
    }
  }

  return { cancelled };
}

// ============================================================================
// Script Destroyed Handler
// ============================================================================

// Register callback to handle job script destruction
onJobScriptDestroyed((target_id: string, job_id: string, reason: string) => {
  const entry = jobsById.get(job_id);
  if (!entry) {
    return;
  }

  // Update job state if not already terminal
  if (entry.state !== "completed" && entry.state !== "cancelled" && entry.state !== "failed") {
    entry.state = "failed";
    entry.error = { message: `Job script destroyed: ${reason}` };
    entry.updated_at = isoNow();

    // Emit a job.crashed event — wrap in Frida-style { type: "send", payload }
    // so recordAgentMessage's msg.type === "send" gate passes (issue 16.7)
    try {
      recordAgentMessage({
        target_id,
        pid: undefined,
        message: {
          type: "send",
          payload: {
            kahlo: {
              type: "event",
              ts: isoNow(),
              job_id,
              kind: "job.crashed",
              level: "error",
              payload: {
                job_id,
                target_id,
                reason,
              },
            },
          },
        },
      });
    } catch { /* fire-and-forget event in script-destroyed handler */ }
  }

  // Clear TTL timer
  if (entry.ttl_timer) {
    clearTimeout(entry.ttl_timer);
    entry.ttl_timer = undefined;
  }
});
