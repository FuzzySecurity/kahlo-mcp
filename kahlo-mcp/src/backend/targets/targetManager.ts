import crypto from "node:crypto";
import * as frida from "frida";
import { getOrchestratorAgentSource } from "../orchestrator/agentSource.js";
import { closeTargetEventPipeline, recordAgentMessage } from "../events/eventPipeline.js";
import { startBootstrapJob } from "../jobs/jobController.js";
import { KeyedLock } from "../../utils.js";
import { getDraft, DraftManagerError } from "../drafts/draftManager.js";
import { getModule, ModuleStoreError } from "../modules/moduleStore.js";

/**
 * Supported target lifecycle states (aligned with `tools/schemas.ts`).
 *
 * - pending: target creation in progress
 * - running: process is running with orchestrator ready
 * - dead: process crashed/exited unexpectedly
 * - detached: cleanly detached by caller
 */
export type TargetState = "pending" | "running" | "dead" | "detached";

/**
 * Supported orchestrator agent states (aligned with `tools/schemas.ts`).
 */
export type AgentState = "not_injected" | "ready" | "crashed" | "reinjecting";

export type TargetMode = "attach" | "spawn";
export type TargetGating = "none" | "spawn" | "child";

/**
 * Public target model returned by tools (aligned with `tools/schemas.ts`).
 */
export interface Target {
  target_id: string;
  device_id: string;
  package: string;
  pid?: number;
  mode: TargetMode;
  gating: TargetGating;
  state: TargetState;
  agent_state: AgentState;
  /** For child targets: the parent target that captured this child spawn */
  parent_target_id?: string;
  /** Diagnostic details when orchestrator injection fails (agent_state="crashed"). */
  agent_error?: {
    message: string;
    hint: string;
  };
  /** Diagnostic details from the last unexpected session detach (state="dead"). */
  last_detach?: {
    reason: string;
    crash: { summary: string; report: string } | null;
  };
  /** Diagnostic details when process resume fails after spawn (gating="none"). */
  resume_error?: {
    message: string;
  };
}

/**
 * Bootstrap module specification for spawn+gating workflows.
 */
export interface BootstrapModule {
  kind: "module_ref" | "draft_id" | "source";
  module_ref?: string;
  draft_id?: string;
  source?: string;
}

/**
 * Parameters for ensuring a target exists.
 */
export interface EnsureTargetArgs {
  device_id: string;
  package: string;
  mode: TargetMode;
  gating: TargetGating;
  /**
   * Bootstrap job for early instrumentation (required when gating="spawn").
   * The bootstrap runs while the app is suspended, then the app resumes with hooks in place.
   */
  bootstrap?: BootstrapModule;
  /**
   * Parameters passed to the bootstrap job's start() function.
   */
  bootstrap_params?: Record<string, unknown>;
  /**
   * Job type for bootstrap: 'oneshot' (default), 'daemon', or 'interactive'.
   */
  bootstrap_type?: "oneshot" | "daemon" | "interactive";
  /**
   * Bootstrap job for child processes (used when gating="child").
   * Each captured child process will run this bootstrap before resuming.
   */
  child_bootstrap?: BootstrapModule;
  /**
   * Parameters passed to child bootstrap job's start() function.
   */
  child_bootstrap_params?: Record<string, unknown>;
  /**
   * Job type for child bootstrap: 'oneshot' (default), 'daemon', or 'interactive'.
   */
  child_bootstrap_type?: "oneshot" | "daemon" | "interactive";
  /**
   * Timeout for resolving the Frida device.
   *
   * @defaultValue 10000
   */
  deviceTimeoutMs?: number;
  /**
   * Timeout for the attach operation.
   *
   * @defaultValue 15000
   */
  attachTimeoutMs?: number;
  /**
   * Timeout for the spawn operation (mode=spawn only).
   *
   * @defaultValue 30000
   */
  spawnTimeoutMs?: number;
}

/**
 * Error class used by the Target Manager to communicate machine-usable failures.
 */
export class TargetManagerError extends Error {
  public readonly code: "NOT_IMPLEMENTED" | "INVALID_ARGUMENT" | "NOT_FOUND" | "UNAVAILABLE" | "INTERNAL";
  public readonly details?: Record<string, unknown>;

  public constructor(
    code: TargetManagerError["code"],
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "TargetManagerError";
    this.code = code;
    this.details = details;
  }
}

interface TargetEntry {
  target: Target;
  session: frida.Session;
  /** Device reference (used internally for spawn flows) */
  device?: frida.Device;
  orchestrator?: {
    script: frida.Script;
  };
  /**
   * Per-job scripts for automatic hook cleanup.
   * Maps job_id -> frida.Script. When a job is cancelled, its script
   * is unloaded and Frida automatically cleans up all hooks.
   */
  jobScripts?: Map<string, frida.Script>;
  /** For gating="child": bootstrap to run on captured child processes */
  child_bootstrap?: BootstrapModule;
  child_bootstrap_params?: Record<string, unknown>;
  child_bootstrap_type?: "oneshot" | "daemon" | "interactive";
}

const targetsById = new Map<string, TargetEntry>();

/**
 * Lock for serializing target operations.
 *
 * Operations on the same target_id are serialized to prevent race conditions
 * (e.g., concurrent job script creation during detach, double-detach).
 *
 * For ensureTarget, we use device_id+package as the key since target_id
 * doesn't exist yet.
 */
const targetOpsLock = new KeyedLock();

// ============================================================================
// Spawn Gating Manager (per-device, ref-counted)
// ============================================================================

interface SpawnGatingState {
  device: frida.Device;
  refCount: number;
  /** Map of parent target_id -> package prefix to match child spawns */
  parentTargets: Map<string, string>;
  /** Disconnect function for spawnAdded signal */
  spawnAddedDisconnect?: () => void;
  /** Disconnect function for childAdded signal (zygote forks) */
  childAddedDisconnect?: () => void;
}

const spawnGatingByDeviceId = new Map<string, SpawnGatingState>();

/**
 * Enable spawn gating on a device for a parent target.
 * Ref-counted: first caller enables, subsequent callers increment ref.
 */
async function enableSpawnGatingForTarget(
  device: frida.Device,
  parentTargetId: string,
  packagePrefix: string
): Promise<void> {
  const deviceId = device.id;
  let state = spawnGatingByDeviceId.get(deviceId);
  
  if (!state) {
    // First child-gating target on this device - enable spawn gating
    await device.enableSpawnGating();
    
    state = {
      device,
      refCount: 0,
      parentTargets: new Map(),
    };
    
    // Connect spawn listener (for process spawns)
    const onSpawnAdded = (spawn: frida.Spawn) => {
      handleSpawnAdded(deviceId, spawn).catch((err) => {
        console.error(`[kahlo] handleSpawnAdded failed for pid=${spawn.pid}: ${err}`);
        device.resume(spawn.pid).catch(() => {});
      });
    };
    device.spawnAdded.connect(onSpawnAdded);
    state.spawnAddedDisconnect = () => device.spawnAdded.disconnect(onSpawnAdded);
    
    // Connect child listener (for zygote forks - this is the main mechanism on Android)
    const onChildAdded = (child: frida.Child) => {
      handleChildAdded(deviceId, child).catch((err) => {
        console.error(`[kahlo] handleChildAdded failed for pid=${child.pid}: ${err}`);
        device.resume(child.pid).catch(() => {});
      });
    };
    device.childAdded.connect(onChildAdded);
    state.childAddedDisconnect = () => device.childAdded.disconnect(onChildAdded);
    
    spawnGatingByDeviceId.set(deviceId, state);
  }
  
  state.refCount++;
  state.parentTargets.set(parentTargetId, packagePrefix);
}

/**
 * Disable spawn gating for a parent target.
 * Ref-counted: last caller disables spawn gating on the device.
 */
async function disableSpawnGatingForTarget(
  deviceId: string,
  parentTargetId: string
): Promise<void> {
  const state = spawnGatingByDeviceId.get(deviceId);
  if (!state) return;
  
  state.parentTargets.delete(parentTargetId);
  state.refCount--;
  
  if (state.refCount <= 0) {
    // Last child-gating target - disable spawn gating
    if (state.spawnAddedDisconnect) {
      state.spawnAddedDisconnect();
    }
    if (state.childAddedDisconnect) {
      state.childAddedDisconnect();
    }
    try {
      await state.device.disableSpawnGating();
    } catch {
      // Best-effort - device may already be disconnected
    }
    spawnGatingByDeviceId.delete(deviceId);
  }
}

/**
 * Handle a spawn event from Frida's spawn gating.
 * Match against registered parent targets and adopt matching children.
 */
async function handleSpawnAdded(deviceId: string, spawn: frida.Spawn): Promise<void> {
  const state = spawnGatingByDeviceId.get(deviceId);
  if (!state) {
    // No child gating active - this shouldn't happen since we only connect the listener when state exists
    return;
  }
  
  // Find a parent target whose package matches this spawn
  let matchedParentId: string | null = null;
  let matchedParentEntry: TargetEntry | null = null;
  
  for (const [parentId, packagePrefix] of state.parentTargets) {
    if (spawn.identifier.startsWith(packagePrefix)) {
      const entry = targetsById.get(parentId);
      if (entry && entry.target.state === "running") {
        matchedParentId = parentId;
        matchedParentEntry = entry;
        break;
      }
    }
  }
  
  if (!matchedParentId || !matchedParentEntry) {
    // No matching parent - resume the spawn to avoid blocking unrelated processes
    try {
      await state.device.resume(spawn.pid);
    } catch {
      // ignore
    }
    return;
  }
  
  // Adopt this child spawn as a new target
  await adoptChildProcess(state.device, spawn.pid, spawn.identifier, matchedParentId, matchedParentEntry);
}

/**
 * Handle a child event from Frida's child gating (zygote forks).
 * This is the main mechanism for multi-process apps on Android.
 */
async function handleChildAdded(deviceId: string, child: frida.Child): Promise<void> {
  const state = spawnGatingByDeviceId.get(deviceId);
  if (!state) {
    return;
  }
  
  // Find a parent target whose package matches this child
  let matchedParentId: string | null = null;
  let matchedParentEntry: TargetEntry | null = null;
  
  for (const [parentId, packagePrefix] of state.parentTargets) {
    // Match by identifier prefix (same as spawn)
    if (child.identifier && child.identifier.startsWith(packagePrefix)) {
      const entry = targetsById.get(parentId);
      if (entry && entry.target.state === "running") {
        matchedParentId = parentId;
        matchedParentEntry = entry;
        break;
      }
    }
  }
  
  if (!matchedParentId || !matchedParentEntry) {
    // No matching parent - resume the child to avoid blocking unrelated processes
    try {
      await state.device.resume(child.pid);
    } catch {
      // ignore
    }
    return;
  }
  
  // Adopt this child as a new target
  await adoptChildProcess(state.device, child.pid, child.identifier || `child:${child.pid}`, matchedParentId, matchedParentEntry);
}

/**
 * Adopt a child process (from spawn or fork) as a new target.
 * Attaches, injects orchestrator, runs child bootstrap if provided, and resumes.
 */
async function adoptChildProcess(
  device: frida.Device,
  pid: number,
  identifier: string,
  parentTargetId: string,
  parentEntry: TargetEntry
): Promise<void> {
  let session: frida.Session;
  try {
    session = await device.attach(pid);
  } catch (err) {
    // Failed to attach - resume the spawn to avoid blocking
    console.error(`[kahlo] Failed to attach to child spawn ${identifier} (pid=${pid}):`, err);
    try {
      await device.resume(pid);
    } catch {
      // ignore
    }
    return;
  }
  
  const child_target_id = newTargetId();
  
  const childTarget: Target = {
    target_id: child_target_id,
    device_id: device.id,
    package: identifier,
    pid,
    mode: "spawn",
    gating: "child",
    state: "running",
    agent_state: "not_injected",
    parent_target_id: parentTargetId,
  };
  
  wireSessionDetachHandler(session, child_target_id);
  
  const childEntry: TargetEntry = {
    target: childTarget,
    session,
    device,
  };
  targetsById.set(child_target_id, childEntry);
  
  // Inject orchestrator
  try {
    await injectOrchestrator(childEntry, session, child_target_id);
  } catch (err) {
    console.error(`[kahlo] Failed to inject orchestrator into child ${identifier}:`, err);
    childTarget.state = "dead";
    try {
      await device.resume(pid);
    } catch {
      // ignore
    }
    return;
  }
  
  // Run child bootstrap if parent provided one
  const childBootstrap = parentEntry.child_bootstrap;
  if (childBootstrap) {
    try {
      const bootstrapSource = resolveBootstrapSource(childBootstrap);
      if (bootstrapSource) {
        const childBootstrapType = parentEntry.child_bootstrap_type ?? "oneshot";
        await startBootstrapJob({
          target_id: child_target_id,
          type: childBootstrapType,
          module_source: bootstrapSource,
          params: parentEntry.child_bootstrap_params,
        });
      }
    } catch (err) {
      console.error(`[kahlo] Child bootstrap failed for ${identifier}:`, err);
      // Continue anyway - partial hooks may still be useful
    }
  }
  
  // Resume the child
  try {
    await device.resume(pid);
  } catch (err) {
    console.error(`[kahlo] Failed to resume child ${identifier}:`, err);
    childTarget.state = "dead";
    return;
  }
  
  // Emit target.child_spawned event on the parent
  emitChildSpawnedEvent(parentTargetId, parentEntry, child_target_id, pid, identifier);
}

/**
 * Emit a target.child_spawned event on the parent target.
 */
function emitChildSpawnedEvent(
  parentTargetId: string,
  parentEntry: TargetEntry,
  childTargetId: string,
  childPid: number,
  childIdentifier: string
): void {
  // Use the parent's orchestrator to emit the event
  const exports = parentEntry.orchestrator?.script?.exports as any;
  if (!exports || typeof exports.emitHostEvent !== "function") {
    // Fallback: record directly to event pipeline (fire-and-forget, no artifact data)
    try {
      recordAgentMessage({
        target_id: parentTargetId,
        pid: parentEntry.target.pid,
        message: {
          type: "send",
          payload: {
            kahlo: {
              type: "event",
              ts: new Date().toISOString(),
              job_id: "host",
              kind: "target.child_spawned",
              level: "info",
              payload: {
                child_target_id: childTargetId,
                child_pid: childPid,
                child_identifier: childIdentifier,
              },
            },
          },
        },
      });
    } catch { /* fire-and-forget event */ }
    return;
  }
  
  // Preferred: emit via orchestrator so it gets proper job context
  exports.emitHostEvent({
    kind: "target.child_spawned",
    level: "info",
    payload: {
      child_target_id: childTargetId,
      child_pid: childPid,
      child_identifier: childIdentifier,
    },
  }).catch(() => {
    // Fallback if RPC fails (fire-and-forget event)
    try {
      recordAgentMessage({
        target_id: parentTargetId,
        pid: parentEntry.target.pid,
        message: {
          type: "send",
          payload: {
            kahlo: {
              type: "event",
              ts: new Date().toISOString(),
              job_id: "host",
              kind: "target.child_spawned",
              level: "info",
              payload: {
                child_target_id: childTargetId,
                child_pid: childPid,
                child_identifier: childIdentifier,
              },
            },
          },
        },
      });
    } catch { /* fire-and-forget event */ }
  });
}

function newTargetId(): string {
  // Prefix makes it readable in logs and avoids confusion with job ids later.
  return `tgt_${crypto.randomUUID()}`;
}

function normalizePackageName(pkg: string): string {
  return pkg.trim();
}

function pickPidFromProcesses(
  processes: Array<{ pid: number; name: string }>,
  packageName: string
): { pid: number; name: string } | null {
  // 1) Exact match (most common for main process).
  const exact = processes.find((p) => p.name === packageName);
  if (exact) return exact;

  // 2) Prefer non-suffixed match if multiple processes exist.
  const prefixed = processes.filter((p) => p.name.startsWith(`${packageName}:`));
  if (prefixed.length === 1) return prefixed[0];

  // 3) Last resort: any process whose name contains the package (some OEMs/tools).
  const contains = processes.filter((p) => p.name.includes(packageName));
  if (contains.length === 1) return contains[0];

  return null;
}

/**
 * Find an existing attached target for a (device_id, package, mode, gating) tuple.
 *
 * This gives `kahlo_targets_ensure` idempotent behavior in the common case.
 */
function findExistingTarget(args: EnsureTargetArgs): TargetEntry | undefined {
  for (const entry of targetsById.values()) {
    const t = entry.target;
    const isAlive = t.state === "running" && !entry.session.isDetached();
    if (
      t.device_id === args.device_id &&
      t.package === args.package &&
      t.mode === args.mode &&
      t.gating === args.gating &&
      isAlive
    ) {
      return entry;
    }
  }
  return undefined;
}

/**
 * Inject the orchestrator agent into a session and validate RPC connectivity.
 *
 * On success, populates entry.orchestrator and sets agent_state = "ready".
 * On failure, sets agent_state = "crashed" and attaches agent_error details.
 */
async function injectOrchestrator(
  entry: TargetEntry,
  session: frida.Session,
  target_id: string
): Promise<void> {
  try {
    const script = await session.createScript(getOrchestratorAgentSource());
    script.destroyed.connect(() => {
      const e = targetsById.get(target_id);
      if (!e) return;
      if (e.target.state === "running") {
        e.target.agent_state = "crashed";
      }
    });

    script.message.connect((message: any, data: any) => {
      try {
        recordAgentMessage({
          target_id,
          pid: entry.target.pid,
          message,
          data,
        });
      } catch {
        // Event recording or artifact storage failed - swallow to prevent
        // exception propagation in Frida signal callback
      }
    });

    await script.load();

    // Validate RPC plumbing.
    const pong = await Promise.race([
      (script.exports as any).ping(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("orchestrator ping timeout exceeded")), 5_000)
      ),
    ]);
    if (pong !== "pong") {
      throw new TargetManagerError("INTERNAL", `unexpected ping response: ${String(pong)}`, {
        expected: "pong",
        received: pong,
      });
    }

    entry.orchestrator = { script };
    entry.target.agent_state = "ready";
  } catch (err) {
    entry.target.agent_state = "crashed";
    entry.target.agent_error = {
      message: err instanceof Error ? err.message : String(err),
      hint: "Orchestrator injection failed; jobs are not available until this is resolved.",
    };
  }
}

/**
 * Wire up session detach handler to keep target state accurate.
 * Emits a structured `target.died` event when session detaches unexpectedly.
 */
function wireSessionDetachHandler(session: frida.Session, target_id: string): void {
  session.detached.connect((reason: any, crash: any) => {
    const entry = targetsById.get(target_id);
    if (!entry) return;

    // If we requested detach, we'll already mark it as detached.
    if (entry.target.state === "detached") return;

    entry.target.state = "dead";
    entry.target.agent_state = entry.target.agent_state === "ready" ? "crashed" : entry.target.agent_state;
    
    const detachInfo = {
      reason: String(reason),
      crash: crash ? { summary: crash.summary, report: crash.report } : null,
    };
    entry.target.last_detach = detachInfo;

    // Emit structured event for crash/death to aid triage — wrap in Frida-style
    // { type: "send", payload } so recordAgentMessage's gate passes (issue 16.7)
    try {
      recordAgentMessage({
        target_id,
        pid: entry.target.pid,
        message: {
          type: "send",
          payload: {
            kahlo: {
              type: "event",
              ts: new Date().toISOString(),
              job_id: "host",
              kind: "target.died",
              level: "error",
              payload: {
                target_id,
                pid: entry.target.pid,
                package: entry.target.package,
                mode: entry.target.mode,
                gating: entry.target.gating,
                reason: detachInfo.reason,
                crash_summary: detachInfo.crash?.summary || null,
              },
            },
          },
        },
      });
    } catch { /* fire-and-forget event in detach handler */ }
  });
}

/**
 * Ensure a target is instrumented.
 *
 * Modes:
 * - `mode=attach` attaches to a running process (requires the app to already be running).
 * - `mode=spawn` spawns the app via Frida and attaches before it runs (early instrumentation).
 *
 * Gating (spawn mode only):
 * - `gating="none"`: resume as early as practical after spawning.
 * - `gating="spawn"`: keep process suspended until orchestrator injection completes, then resume.
 * - `gating="child"`: also capture child processes spawned by this app.
 */
export async function ensureTarget(args: EnsureTargetArgs): Promise<{ target_id: string; target: Target }> {
  const packageName = normalizePackageName(args.package);
  if (packageName.length === 0) {
    throw new TargetManagerError("INVALID_ARGUMENT", "package must be a non-empty string");
  }

  // Validate gating constraints
  if (args.mode === "attach" && args.gating !== "none") {
    throw new TargetManagerError(
      "INVALID_ARGUMENT",
      "gating is only supported for spawn mode; for attach mode, use gating='none'",
      { requested_mode: args.mode, requested_gating: args.gating }
    );
  }

  // Validate bootstrap requirement for gating="spawn" or gating="child"
  if ((args.gating === "spawn" || args.gating === "child") && !args.bootstrap) {
    throw new TargetManagerError(
      "INVALID_ARGUMENT",
      `gating='${args.gating}' requires a bootstrap job to install early hooks. ` +
      "Provide bootstrap: {kind:'source', source:'...'} or {kind:'module_ref', module_ref:'...'}",
      { requested_gating: args.gating, hint: "Bootstrap is required to avoid suspended process timeout." }
    );
  }

  // Serialize operations for the same device+package to prevent race conditions
  // (e.g., concurrent ensureTarget calls for the same app)
  const lockKey = `ensure:${args.device_id}:${packageName}`;
  return targetOpsLock.withLock(lockKey, async () => {
    // Re-check for existing target inside the lock (another call may have created it)
    const existing = findExistingTarget({ ...args, package: packageName });
    if (existing) {
      return { target_id: existing.target.target_id, target: existing.target };
    }

    const deviceTimeoutMs = args.deviceTimeoutMs ?? 10_000;
    const attachTimeoutMs = args.attachTimeoutMs ?? 15_000;
    const spawnTimeoutMs = args.spawnTimeoutMs ?? 30_000;

    // Resolve device
    let device: frida.Device;
    try {
      device = await frida.getDevice(args.device_id, { timeout: deviceTimeoutMs });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new TargetManagerError("UNAVAILABLE", `Failed to resolve Frida device: ${msg}`, {
        device_id: args.device_id,
        timeout_ms: deviceTimeoutMs,
      });
    }

    // Branch: attach vs spawn
    if (args.mode === "attach") {
      return ensureTargetAttach(device, args, packageName, attachTimeoutMs);
    } else {
      return ensureTargetSpawn(device, args, packageName, spawnTimeoutMs, attachTimeoutMs);
    }
  });
}

/**
 * Attach to an already-running process.
 */
async function ensureTargetAttach(
  device: frida.Device,
  args: EnsureTargetArgs,
  packageName: string,
  attachTimeoutMs: number
): Promise<{ target_id: string; target: Target }> {
  // Enumerate processes to find the target pid
  let processes: Array<{ pid: number; name: string }>;
  try {
    processes = (await device.enumerateProcesses()).map((p: any) => ({ pid: p.pid, name: p.name }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TargetManagerError("UNAVAILABLE", `Failed to enumerate processes: ${msg}`, {
      device_id: args.device_id,
    });
  }

  const match = pickPidFromProcesses(processes, packageName);
  if (!match) {
    const candidates = processes
      .filter((p) => p.name === packageName || p.name.startsWith(`${packageName}:`) || p.name.includes(packageName))
      .slice(0, 20);

    throw new TargetManagerError("NOT_FOUND", `Process not found for package: ${packageName}`, {
      device_id: args.device_id,
      package: packageName,
      hint: "Start the app first (or use kahlo_processes_list to verify the process name).",
      candidates,
    });
  }

  // Attach to the process
  let session: frida.Session;
  try {
    session = await Promise.race([
      device.attach(match.pid),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("attach timeout exceeded")), attachTimeoutMs)
      ),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TargetManagerError("UNAVAILABLE", `Failed to attach to pid ${match.pid}: ${msg}`, {
      device_id: args.device_id,
      pid: match.pid,
      process_name: match.name,
      timeout_ms: attachTimeoutMs,
    });
  }

  const target_id = newTargetId();
  const target: Target = {
    target_id,
    device_id: args.device_id,
    package: packageName,
    pid: match.pid,
    mode: "attach",
    gating: "none",
    state: "running",
    agent_state: "not_injected",
  };

  wireSessionDetachHandler(session, target_id);

  const entry: TargetEntry = { target, session };
  targetsById.set(target_id, entry);

  // Inject orchestrator
  await injectOrchestrator(entry, session, target_id);

  // Fail fast if orchestrator injection was silently swallowed
  if (entry.target.agent_state === "crashed") {
    const agentErr = entry.target.agent_error;
    throw new TargetManagerError("UNAVAILABLE",
      `Orchestrator injection failed: ${agentErr?.message || "unknown error"}`,
      { agent_error: agentErr }
    );
  }

  return { target_id, target };
}

/**
 * Spawn a new process and attach before it runs.
 *
 * For spawn mode:
 * - The `package` parameter should be an Android package identifier (e.g., "com.example.app"),
 *   NOT a process display name. Frida uses this to launch the app via the Android runtime.
 * - The process starts suspended; we attach and inject the orchestrator, then resume.
 */
async function ensureTargetSpawn(
  device: frida.Device,
  args: EnsureTargetArgs,
  packageName: string,
  spawnTimeoutMs: number,
  attachTimeoutMs: number
): Promise<{ target_id: string; target: Target }> {
  // Pre-flight: resolve bootstrap source BEFORE spawning to avoid wasted spawn+kill
  // cycles and to provide synchronous NOT_FOUND errors for missing modules/drafts.
  const hasBootstrap = (args.gating === "spawn" || args.gating === "child") && args.bootstrap;
  let bootstrapSource: string | null = null;
  if (hasBootstrap) {
    bootstrapSource = resolveBootstrapSource(args.bootstrap!);
    if (!bootstrapSource) {
      throw new TargetManagerError("INVALID_ARGUMENT", "Invalid bootstrap module specification", {
        bootstrap: args.bootstrap,
      });
    }
  }

  // Spawn the app (process starts suspended)
  let pid: number;
  try {
    pid = await Promise.race([
      device.spawn(packageName),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("spawn timeout exceeded")), spawnTimeoutMs)
      ),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isNotFound = msg.toLowerCase().includes("unable to find") ||
                       msg.toLowerCase().includes("not found") ||
                       msg.toLowerCase().includes("failed to spawn");

    throw new TargetManagerError(
      isNotFound ? "NOT_FOUND" : "UNAVAILABLE",
      `Failed to spawn package: ${packageName}: ${msg}`,
      {
        device_id: args.device_id,
        package: packageName,
        timeout_ms: spawnTimeoutMs,
        hint: isNotFound
          ? "For spawn mode, use the Android package identifier (e.g., 'com.example.app'), " +
            "not the process display name. Verify the package is installed with 'adb shell pm list packages'."
          : "Check that the device is reachable and frida-server is running.",
      }
    );
  }

  // Attach to the spawned process
  let session: frida.Session;
  try {
    session = await Promise.race([
      device.attach(pid),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("attach timeout exceeded")), attachTimeoutMs)
      ),
    ]);
  } catch (err) {
    // Best-effort: kill the spawned process if attach fails
    try {
      await device.kill(pid);
    } catch {
      // ignore
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new TargetManagerError("UNAVAILABLE", `Failed to attach to spawned pid ${pid}: ${msg}`, {
      device_id: args.device_id,
      pid,
      package: packageName,
      timeout_ms: attachTimeoutMs,
    });
  }

  const target_id = newTargetId();

  const target: Target = {
    target_id,
    device_id: args.device_id,
    package: packageName,
    pid,
    mode: "spawn",
    gating: args.gating,
    state: "running", // Will be running after we complete the spawn flow
    agent_state: "not_injected",
  };

  wireSessionDetachHandler(session, target_id);

  // Store device reference and child bootstrap config (for gating="child")
  const entry: TargetEntry = {
    target,
    session,
    device,
    child_bootstrap: args.child_bootstrap,
    child_bootstrap_params: args.child_bootstrap_params,
    child_bootstrap_type: args.child_bootstrap_type,
  };
  targetsById.set(target_id, entry);

  // Inject orchestrator BEFORE resuming
  await injectOrchestrator(entry, session, target_id);

  // Fail fast if orchestrator injection was silently swallowed
  if (entry.target.agent_state === "crashed") {
    const agentErr = entry.target.agent_error;
    // Best-effort: kill the spawned process since it cannot be instrumented
    try {
      await device.kill(pid);
    } catch {
      // ignore
    }
    entry.target.state = "dead";
    throw new TargetManagerError("UNAVAILABLE",
      `Orchestrator injection failed: ${agentErr?.message || "unknown error"}`,
      { agent_error: agentErr }
    );
  }

  // For gating="spawn": run bootstrap job while suspended, THEN resume
  // For gating="none": resume immediately (may miss earliest init)
  if (hasBootstrap) {
    // bootstrapSource was resolved in the pre-flight check above

    // Track gating state before bootstrap
    let spawnGatingEnabled = false;

    // Run bootstrap job while process is suspended
    try {
      // Enable spawn gating FIRST for gating="child" to capture all children
      if (args.gating === "child") {
        await enableSpawnGatingForTarget(device, target_id, packageName);
        spawnGatingEnabled = true;
      }

      const bootstrapType = args.bootstrap_type ?? "oneshot";
      await startBootstrapJob({
        target_id,
        type: bootstrapType,
        module_source: bootstrapSource!, // guaranteed non-null by pre-flight check
        params: args.bootstrap_params,
      });

      // Bootstrap installed successfully - now resume
      await device.resume(pid);

    } catch (err) {
      // Clean up spawn gating if we enabled it
      if (spawnGatingEnabled) {
        try {
          await disableSpawnGatingForTarget(device.id, target_id);
        } catch {
          // Best-effort cleanup
        }
      }

      // Bootstrap failed - kill the process and report error
      try {
        await device.kill(pid);
      } catch {
        // ignore
      }
      entry.target.state = "dead";
      const msg = err instanceof Error ? err.message : String(err);
      throw new TargetManagerError("UNAVAILABLE", `Bootstrap job failed: ${msg}`, {
        target_id,
        pid,
        package: packageName,
      });
    }
  } else {
    // gating="none" - resume immediately
    try {
      await device.resume(pid);
    } catch (err) {
      entry.target.state = "dead";
      entry.target.resume_error = {
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { target_id, target };
}

/**
 * Resolve bootstrap module specification to source code.
 */
function resolveBootstrapSource(bootstrap: BootstrapModule): string | null {
  if (bootstrap.kind === "source" && bootstrap.source) {
    return bootstrap.source;
  }

  if (bootstrap.kind === "draft_id" && bootstrap.draft_id) {
    const draft_id = bootstrap.draft_id;
    let draft;
    try {
      draft = getDraft(draft_id);
    } catch (err) {
      if (err instanceof DraftManagerError) {
        if (err.code === "NOT_FOUND") {
          throw new TargetManagerError("NOT_FOUND", `Bootstrap draft not found: ${draft_id}`, {
            draft_id,
            hint: "Verify the draft exists using kahlo_modules_listDrafts",
          });
        }
        throw new TargetManagerError("INVALID_ARGUMENT", err.message, { draft_id });
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new TargetManagerError("INTERNAL", `Failed to resolve bootstrap draft: ${msg}`, { draft_id });
    }
    if (!draft.source || draft.source.trim().length === 0) {
      throw new TargetManagerError("INVALID_ARGUMENT", "Draft source is empty", { draft_id });
    }
    return draft.source;
  }

  if (bootstrap.kind === "module_ref" && bootstrap.module_ref) {
    const module_ref = bootstrap.module_ref;
    let result;
    try {
      result = getModule(module_ref);
    } catch (err) {
      if (err instanceof ModuleStoreError) {
        if (err.code === "NOT_FOUND") {
          throw new TargetManagerError("NOT_FOUND", `Bootstrap module not found: ${module_ref}`, {
            module_ref,
            hint: "Verify the module exists using kahlo_modules_list",
          });
        }
        if (err.code === "VALIDATION_ERROR") {
          throw new TargetManagerError("INVALID_ARGUMENT", err.message, { module_ref });
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new TargetManagerError("INTERNAL", `Failed to resolve bootstrap module: ${msg}`, { module_ref });
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new TargetManagerError("INTERNAL", `Failed to resolve bootstrap module: ${msg}`, { module_ref });
    }
    if (!result.source || result.source.trim().length === 0) {
      throw new TargetManagerError("INVALID_ARGUMENT", "Module source is empty", { module_ref });
    }
    return result.source;
  }

  return null;
}

/**
 * Get the current status for a target.
 *
 * @param targetId - Target identifier returned by `ensureTarget`.
 */
export function getTargetStatus(targetId: string): Target {
  const entry = targetsById.get(targetId);
  if (!entry) {
    throw new TargetManagerError("NOT_FOUND", `Unknown target_id: ${targetId}`, { target_id: targetId });
  }

  // Best-effort: keep state in sync with frida session.
  if (entry.target.state === "running" && entry.session.isDetached()) {
    entry.target.state = "dead";
    if (entry.target.agent_state === "ready") {
      entry.target.agent_state = "crashed";
    }
  }

  return entry.target;
}

export function getOrchestratorExports(targetId: string): any {
  const entry = targetsById.get(targetId);
  if (!entry) {
    throw new TargetManagerError("NOT_FOUND", `Unknown target_id: ${targetId}`, { target_id: targetId });
  }
  if (entry.target.state !== "running" || entry.session.isDetached()) {
    throw new TargetManagerError("UNAVAILABLE", `Target is not running: ${targetId}`, {
      target_id: targetId,
      state: entry.target.state,
    });
  }
  if (entry.target.agent_state !== "ready" || !entry.orchestrator?.script) {
    throw new TargetManagerError("UNAVAILABLE", `Orchestrator is not ready for target: ${targetId}`, {
      target_id: targetId,
      agent_state: entry.target.agent_state,
    });
  }

  return entry.orchestrator.script.exports as any;
}

// ============================================================================
// Per-Job Script Management
// ============================================================================

/**
 * Callback type for job script lifecycle events.
 */
export type JobScriptDestroyedCallback = (target_id: string, job_id: string, reason: string) => void;

/**
 * Registry for job script destroyed callbacks.
 * The job controller registers a callback to handle script crashes/unloads.
 */
let jobScriptDestroyedCallback: JobScriptDestroyedCallback | undefined;

/**
 * Register a callback for when job scripts are destroyed.
 * Used by jobController to handle script crashes and update job state.
 *
 * @param callback - Function called when a job script is destroyed
 */
export function onJobScriptDestroyed(callback: JobScriptDestroyedCallback): void {
  jobScriptDestroyedCallback = callback;
}

/**
 * Create and load a job script for a target.
 *
 * Each job runs in its own Frida script instance. When the script is unloaded
 * (via unloadJobScript), Frida automatically cleans up all hooks, timers, and
 * state installed by that script.
 *
 * @param target_id - Target to create the script for
 * @param job_id - Unique job identifier (used for tracking and cleanup)
 * @param source - JavaScript source for the job script
 * @returns The created and loaded Frida script
 * @throws TargetManagerError if target not found, not running, or script creation fails
 */
export async function createJobScript(
  target_id: string,
  job_id: string,
  source: string
): Promise<frida.Script> {
  // Serialize script operations per target to prevent race conditions
  // (e.g., creating a script while target is being detached)
  return targetOpsLock.withLock(target_id, async () => {
    const entry = targetsById.get(target_id);
    if (!entry) {
      throw new TargetManagerError("NOT_FOUND", `Unknown target_id: ${target_id}`, { target_id });
    }
    if (entry.target.state !== "running" || entry.session.isDetached()) {
      throw new TargetManagerError("UNAVAILABLE", `Target is not running: ${target_id}`, {
        target_id,
        state: entry.target.state,
      });
    }

    // Initialize jobScripts map if needed
    if (!entry.jobScripts) {
      entry.jobScripts = new Map();
    }

    // Check for duplicate job_id
    if (entry.jobScripts.has(job_id)) {
      throw new TargetManagerError("INVALID_ARGUMENT", `Job script already exists for job_id: ${job_id}`, {
        target_id,
        job_id,
      });
    }

    // Create the script
    let script: frida.Script;
    try {
      script = await entry.session.createScript(source);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new TargetManagerError("UNAVAILABLE", `Failed to create job script: ${msg}`, {
        target_id,
        job_id,
      });
    }

    // Wire destroyed handler
    script.destroyed.connect(() => {
      // Remove from tracking
      entry.jobScripts?.delete(job_id);

      // Notify job controller
      if (jobScriptDestroyedCallback) {
        jobScriptDestroyedCallback(target_id, job_id, "script_destroyed");
      }
    });

    // Wire message handler (reuse existing event pipeline)
    script.message.connect((message: any, data: any) => {
      try {
        recordAgentMessage({
          target_id,
          pid: entry.target.pid,
          message,
          data,
        });
      } catch {
        // Event recording or artifact storage failed - swallow to prevent
        // exception propagation in Frida signal callback
      }
    });

    // Load the script
    try {
      await script.load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new TargetManagerError("UNAVAILABLE", `Failed to load job script: ${msg}`, {
        target_id,
        job_id,
      });
    }

    // Track the script
    entry.jobScripts.set(job_id, script);

    return script;
  });
}

/**
 * Unload a job script, triggering Frida's automatic cleanup.
 *
 * This is the key operation for job cancellation. Frida automatically removes
 * all Interceptor hooks, Java method replacements, timers, and other state
 * when a script is unloaded.
 *
 * @param target_id - Target the job belongs to
 * @param job_id - Job identifier
 * @throws TargetManagerError if target or job script not found
 */
/**
 * Internal unload implementation (no lock - for use by other locked functions).
 *
 * This function is idempotent and handles edge cases gracefully:
 * - Target not found (already detached) → returns silently
 * - Script not found (already unloaded) → returns silently
 * - Script unload fails (already destroyed) → logs warning and continues
 */
async function unloadJobScriptInternal(target_id: string, job_id: string): Promise<void> {
  const entry = targetsById.get(target_id);
  if (!entry) {
    // Target not found - may have been detached already
    // This is expected during concurrent detach + cancel scenarios
    return;
  }

  const script = entry.jobScripts?.get(job_id);
  if (!script) {
    // Job script not found - could be already unloaded or never created
    // This is not an error for idempotent cancellation
    return;
  }

  try {
    await script.unload();
  } catch (err) {
    // Best-effort unload - script may already be destroyed
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[kahlo] Failed to unload job script ${job_id}: ${msg}`);
  }

  // Remove from tracking (destroyed handler also does this, but be explicit)
  entry.jobScripts?.delete(job_id);
}

export async function unloadJobScript(target_id: string, job_id: string): Promise<void> {
  // Serialize script operations per target to prevent race conditions
  return targetOpsLock.withLock(target_id, async () => {
    return unloadJobScriptInternal(target_id, job_id);
  });
}

/**
 * Get a job script by ID.
 *
 * @param target_id - Target the job belongs to
 * @param job_id - Job identifier
 * @returns The job script, or undefined if not found
 */
export function getJobScript(target_id: string, job_id: string): frida.Script | undefined {
  const entry = targetsById.get(target_id);
  if (!entry) {
    return undefined;
  }
  return entry.jobScripts?.get(job_id);
}

/**
 * Get the RPC exports for a job script.
 *
 * @param target_id - Target the job belongs to
 * @param job_id - Job identifier
 * @returns The script's RPC exports
 * @throws TargetManagerError if script not found
 */
export function getJobScriptExports(target_id: string, job_id: string): any {
  const script = getJobScript(target_id, job_id);
  if (!script) {
    throw new TargetManagerError("NOT_FOUND", `Job script not found for job_id: ${job_id}`, {
      target_id,
      job_id,
    });
  }
  return script.exports;
}

/**
 * Unload all job scripts for a target.
 * Called during target detachment.
 *
 * @param target_id - Target to clean up
 * @returns Number of scripts unloaded
 */
/**
 * Internal unloadAll implementation (no lock - for use by other locked functions like detachTarget).
 */
async function unloadAllJobScriptsInternal(target_id: string): Promise<number> {
  const entry = targetsById.get(target_id);
  if (!entry || !entry.jobScripts) {
    return 0;
  }

  const jobIds = Array.from(entry.jobScripts.keys());
  let unloaded = 0;

  for (const job_id of jobIds) {
    try {
      await unloadJobScriptInternal(target_id, job_id);
      unloaded++;
    } catch {
      // Best-effort - continue with other scripts
    }
  }

  return unloaded;
}

export async function unloadAllJobScripts(target_id: string): Promise<number> {
  // Serialize script operations per target to prevent race conditions
  return targetOpsLock.withLock(target_id, async () => {
    return unloadAllJobScriptsInternal(target_id);
  });
}

/**
 * Detach from a target process and mark it detached.
 *
 * @param targetId - Target identifier returned by `ensureTarget`.
 */
export async function detachTarget(targetId: string): Promise<Target> {
  // Child target IDs are collected under the parent lock, then detached
  // outside the lock scope so each child acquires its own targetOpsLock.
  // This prevents racing with concurrent child operations (issue 16.10).
  let childTargetIds: string[] = [];

  // Serialize operations on this target to prevent race conditions
  // (e.g., concurrent detach, or detach during job script creation)
  const result = await targetOpsLock.withLock(targetId, async () => {
    const entry = targetsById.get(targetId);
    if (!entry) {
      throw new TargetManagerError("NOT_FOUND", `Unknown target_id: ${targetId}`, { target_id: targetId });
    }

    // If already detached, return current state idempotently
    if (entry.target.state === "detached") {
      return entry.target;
    }

    // Mark first to avoid the detached handler treating this as "dead".
    entry.target.state = "detached";
    entry.target.agent_state = "not_injected";

    try {
      // Unload all job scripts first - triggers Frida's automatic hook cleanup
      // Use internal version since we already hold the lock
      if (entry.jobScripts && entry.jobScripts.size > 0) {
        await unloadAllJobScriptsInternal(targetId);
      }

      // Best-effort: unload orchestrator script
      if (entry.orchestrator?.script) {
        try {
          try {
            const exports = entry.orchestrator.script.exports as any;
            if (exports && typeof exports.cancelAllJobs === "function") {
              await exports.cancelAllJobs();
            }
          } catch {
            // ignore
          }
          await entry.orchestrator.script.unload();
        } catch {
          // ignore; detach below is the stronger cleanup boundary
        }
      }

      if (!entry.session.isDetached()) {
        await entry.session.detach();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new TargetManagerError("UNAVAILABLE", `Failed to detach session: ${msg}`, { target_id: targetId });
    }

    // Drop script handle after detaching.
    entry.orchestrator = undefined;
    closeTargetEventPipeline(targetId);

    // If this was a child-gating target, disable spawn gating (ref-counted)
    if (entry.target.gating === "child") {
      await disableSpawnGatingForTarget(entry.target.device_id, targetId);
    }

    // Collect child target IDs under the parent lock so we have a
    // consistent snapshot, but defer the actual detach work to after
    // the parent lock is released. This avoids modifying child state
    // or unloading child scripts without holding the child's own lock.
    for (const childEntry of targetsById.values()) {
      if (childEntry.target.parent_target_id === targetId &&
          childEntry.target.state === "running") {
        childTargetIds.push(childEntry.target.target_id);
      }
    }

    // Keep entry around for status queries/history; future work could prune.
    return entry.target;
  });

  // --- Outside the parent's targetOpsLock scope ---
  // Recursively detach children. Each call acquires the child's own
  // targetOpsLock (keyed by child target_id -- a different key from the
  // parent), so concurrent operations on the child are properly serialized.
  // detachTarget is idempotent, so a concurrent or duplicate detach is safe.
  for (const childId of childTargetIds) {
    try {
      await detachTarget(childId);
    } catch {
      // Best-effort: continue with other children even if one fails
    }
  }

  return result;
}

