# Kahlo Changelog

All notable changes to kahlo are documented here. Entries are organized by implementation phase and include key decisions plus verification/exit criteria.

---

## Phase 0: Repository and Runtime Skeleton

**Objective**: Establish project foundation to enable live testing.

- [X] Select runtime envelope: Node.js host harness with MCP server facade (per`design.md`)
- [X] Create minimal project structure (`data/`,`modules/`,`drafts/`,`snapshots/`,`runs/`)
- [X] Implement configuration stub:`data_dir`, device selection strategy, logging level
- [X] Implement boot path: single command starts MCP server and prints "ready"

---

## Phase 1: MCP Server Facade (Contract-First)

**Objective**: Define and implement the complete MCP tool surface with stable schemas.

### 1.1 Tool Surface

- [X] Define MCP tool inventory matching the design specification:
  - [X]`kahlo_mcp_about`
  - [X]`kahlo_devices_list`,`kahlo_devices_get`,`kahlo_devices_health`
  - [X]`kahlo_targets_ensure`,`kahlo_targets_status`,`kahlo_targets_detach`
  - [X]`kahlo_jobs_start`,`kahlo_jobs_status`,`kahlo_jobs_list`,`kahlo_jobs_cancel`
  - [X]`kahlo_snapshots_get`
  - [X]`kahlo_events_fetch`
  - [X]`kahlo_artifacts_list`,`kahlo_artifacts_get`
  - [X]`kahlo_modules_list`,`kahlo_modules_get`,`kahlo_modules_createDraft`,`kahlo_modules_updateDraft`,`kahlo_modules_promoteFromJob`,`kahlo_modules_promoteDraft`
- [X] Define request/response schemas for each tool
- [X] Add server introspection and health behavior:
  - [X]`kahlo_mcp_about` returns server version, data directory, and operational contract
  - [X] Consistent machine-readable error envelope across all tools

**Exit Criteria**: MCP server runs locally; all tools respond with valid schema. **PASSED**

---

## Phase 2: Device and Target Management (Frida Attach Baseline)

**Objective**: Implement real device enumeration and basic target attachment.

- [X] Implement Device Manager:
  - [X]`devices.list` enumerates connected devices via ADB with stable`device_id`
  - [X]`devices.get` returns device metadata (model, version, transport)
  - [X]`devices.health` verifies connectivity and`frida-server` status
  - [X]`processes.list` enumerates running processes via frida-node
- [X] Implement Target Manager (attach-first):
  - [X]`targets.ensure` attaches to running process, creates Target record
  - [X]`targets.status` reflects live session state accurately
  - [X]`targets.detach` detaches cleanly and updates state

**Exit Criteria**: With rooted device connected: `devices.list` → `targets.ensure` (attach) → `targets.status` → `targets.detach`. **PASSED**

---

## Phase 3: Orchestrator Injection and Job Lifecycle

**Objective**: Enable job execution within instrumented targets.

- [X] Implement in-process orchestrator:
  - [X] Minimal RPC surface with`ping()` and`listJobs()`
  - [X] Host injects orchestrator on target creation and tracks orchestrator status
- [X] Implement jobs (minimal vertical slice):
  - [X]`jobs.start` supports inline source for one-shot jobs
  - [X]`jobs.status`,`jobs.list`,`jobs.cancel` operate against in-process orchestrator
  - [X] Job cancellation performs best-effort cleanup (hooks/timers)

**Exit Criteria**: On real target, start trivial job, observe via `jobs.status`, cancel cleanly. **PASSED**

---

## Phase 4: Java Bridge Integration

**Objective**: Make Java bridge available to jobs without requiring imports.

- [X] Bundle Java bridge into the in-process orchestrator:
  - [X] Compile/bundle with`frida-java-bridge` (Frida 17+ bridges not bundled by default)
  - [X] Confirm orchestrator can access`Java.available` when attached to Java/ART process
- [X] Expose Java bridge to job modules via job context:
  - [X] Extend job context to include`ctx.Java`
  - [X] Update job templates: prefer`ctx.Java.perform(...)`
  - [X] Add structured error handling when Java unavailable

**Exit Criteria**: On Java app target, job can enumerate loaded classes using `ctx.Java` and stream results as events. **PASSED**

---

## Phase 5: Event Data Plane

**Objective**: Implement event buffering, cursor-based fetching, and persistence.

- [X] In-process runtime → host event emission:
  - [X] Runtime-side event API:`emit(job_id, kind, level, payload)` using Frida`send()`
  - [X] Expose event emission via job context (modules don't call`send()` directly)
- [X] Host event pipeline:
  - [X] Receive and normalize runtime messages into event envelope
  - [X] Implement bounded ring buffers per target/job with cursor semantics
  - [X] Implement dropped-event accounting with overflow markers
  - [X] Persist events to`data_dir/runs/<YYYY-MM-DD>/target_<target_id>/events.jsonl`
- [X] MCP tool`kahlo_events_fetch`:
  - [X] Support fetching by`target_id` or`job_id`
  - [X] Support cursor + limit pagination
  - [X] Support optional filters (kind/level)

**Exit Criteria**: Daemon job emits events continuously; `kahlo_events_fetch` paginates reliably; overflow produces markers; `events.jsonl` written to disk. **PASSED**

---

## Phase 6: On-Demand Snapshots

**Objective**: Enable point-in-time queries of target process state.

- [X] Snapshot providers (in-process runtime):
  - [X] Implement`getSnapshot(kind, options?)` RPC
  - [X] Initial snapshot kinds:
    - [X]`process.info` (pid, arch, runtime info)
    - [X]`native.modules` (loaded modules metadata, bounded)
- [X] Host wiring:
  - [X] Implement`kahlo_snapshots_get` calling orchestrator RPC
  - [X] Add timeouts/limits to prevent session wedging

**Exit Criteria**: `kahlo_snapshots_get` returns usable results for `process.info` and `native.modules`. **PASSED**

---

## Phase 7: Artifact Capture (Binary Payloads)

**Objective**: Provide durable storage for non-trivial outputs (dumps, traces, files).

### 7.1 Schema and Contract

- [X] Define artifact contract with byte-array transport via Frida binary message channel
- [X] Define message envelope:`artifact_id`,`job_id`,`type`,`mime?`,`name?`,`metadata?`,`size_bytes`
- [X] Define retrieval pattern: jobs emit event with`artifact_id`, clients call`kahlo_artifacts_get`
- [X] Update Artifact model with strongly-typed metadata:`size_bytes`,`stored_size_bytes`,`sha256`,`mime?`,`name?`
- [X] Update`kahlo_artifacts_get` output: default returns metadata +`storage_ref`; optional inline`payload_b64` for small artifacts

### 7.2 Artifact Transport (In-Process Runtime)

- [X] Runtime-side`emitArtifact(job_id, opts, bytes)` API via job context
- [X] Hard limits: max per-artifact payload size; emit error event on violation

### 7.3 Host Artifact Store

- [X] Artifact Manager receives messages, validates envelope and payload
- [X] Compute`sha256`, write raw bytes to`data_dir/runs/<date>/target_<id>/artifacts/<artifact_id>.bin`
- [X] Append index record to`artifacts.jsonl`
- [X] Safety: sanitize filenames, per-target disk budget, avoid buffering large payloads

### 7.4 MCP Tools

- [X]`kahlo_artifacts_list`: list by`target_id` or`job_id`, return metadata +`storage_ref`
- [X]`kahlo_artifacts_get`: return metadata; optionally inline`payload_b64` for small artifacts

**Exit Criteria**: Job dumps 4096-byte page; host persists `.bin` blob; `kahlo_artifacts_list` returns correct metadata; `kahlo_artifacts_get` returns inline base64 for small artifacts. **PASSED**

---

## Phase 8: Spawn, Gating, and Multi-Process Support

**Objective**: Enable spawn-first instrumentation and child process capture.

### 8.1 Spawn Targets Baseline

- [X] Implement spawn path in Target Manager:
  - [X] Resolve device, spawn app with`device.spawn()`, obtain pid
  - [X] Attach to spawned pid, inject orchestrator, validate RPC
  - [X] Populate Target record (`mode="spawn"`,`gating`,`pid`,`state`,`agent_state`)
- [X] Define spawn identifier expectations and failure hints

### 8.2 Gating Semantics

- [X]`gating="spawn"`: Requires bootstrap job; runs while suspended, auto-resumes with hooks in place
- [X]`gating="none"`: Resume immediately after orchestrator injection (documented: may miss earliest init)
- [X] Update target state transitions and detach/crash handling

### 8.3 Bootstrap Job for Early Instrumentation

**Rationale**: The orchestrator doesn't install hooks, jobs do. Requiring bootstrap at spawn time makes the flow atomic: spawn → inject → bootstrap → resume. This prevents foot-guns (forgotten resume, delayed resume causing timeout).

- [X] Add bootstrap parameters to`targets.ensure`:
  - [X]`bootstrap: { kind, ... }` required when`gating="spawn"`
  - [X]`bootstrap_params` optional parameters
  - [X] Validation: reject`gating="spawn"` without bootstrap
- [X] Update spawn flow to run bootstrap before resuming:
  - [X] Run bootstrap while process is suspended
  - [X] On success, call`device.resume(pid)`
  - [X] On failure, kill process and return error
- [X] Remove`targets.resume` tool (no longer needed)
- [X] Remove`"suspended"` target state (not exposed to callers)
- [X] Update documentation

**Verification**: Calculator app spawned with bootstrap, caught `com.android.calculator2.Calculator.onCreate` before app execution.

### 8.4 Child Gating / Multi-Process

- [X] Device-level spawn gating management (ref-counted)

- [~] Capture and adopt child spawns:

  - [X] Implementation complete (spawnAdded/childAdded handlers, adoptChildProcess, schemas, events)

  - **Known Limitation**: Android apps fork from`zygote64`, not the parent app. Frida's spawn gating doesn't capture zygote forks. Tested with Chrome and Play Store, children spawned but not captured. Alternative approaches: hook zygote directly, use`processes.list` polling.

### 8.5 Cleanup and Failure Handling

- [X]`targets.detach(parent)` disables spawn gating if ref-count reaches zero
- [X] Best-effort detach of child targets created under parent
- [X] Crash/death handling: mark target`dead`, emit`target.died` event

**Exit Criteria**:

- [X]`mode="spawn", gating="spawn"` + bootstrap: spawns, runs bootstrap, auto-resumes, returns`state="running"`.**PASSED**
- [X]`mode="spawn", gating="none"`: spawns/resumes reliably.**PASSED**

- [~]`gating="child"`: Implementation complete; Android limitation prevents verification on stock apps.

- [X]`targets.detach` leaves no stuck spawn gating or orphan sessions.**PASSED**

---

## Phase 9: Draft Iteration and Module Promotion

**Objective**: Enable workflow for saving, iterating, and graduating instrumentation code.

**Workflow**:

```
inline job → save to draft → iterate on draft → promote to module
     ↓              ↓                ↓                  ↓
 (explore)      (capture)        (refine)           (commit)
```

**Design Philosophy**:

- Inline jobs: throwaway experiments (low commitment, high velocity)
- Drafts: saved progress (mutable, named, safe to iterate)
- Modules: production-ready (immutable, versioned, permanent)

### 9.1 Draft Store

- [X] Draft persistence:`data_dir/drafts/<draft_id>.json`
- [X] Schema:`{ draft_id, name?, source, manifest?, created_at, updated_at, derived_from_job_id? }`
- [X]`kahlo_modules_createDraft`: create draft from raw source
- [X]`kahlo_modules_createDraftFromJob`: capture working job's source as draft (primary "save my work" action)

### 9.2 Draft Iteration

- [X]`kahlo_modules_updateDraft`: replace draft source
- [X]`kahlo_modules_getDraft`: retrieve draft source and metadata
- [X]`kahlo_modules_listDrafts`: list all drafts

### 9.3 Jobs from Drafts

- [X] Update`jobs.start` to accept`draft_id`
- [X] Track provenance:`module: { kind: 'draft_id', draft_id }`

**Verification**: Ran job with `draft_id`, received "Updated draft module v2!" event.

### 9.4 Draft Promotion

- [X]`kahlo_modules_promoteDraft`: freeze draft into versioned module
- [X] Version assignment via`version_strategy` (patch/minor/major/exact)
- [X] Write to`modules/<name>/<version>/` with`manifest.json`,`module.js`
- [X] Update`modules/index.json`
- [X] Record provenance:`derived_from_draft_id`,`derived_from_job_id`
- [X]`kahlo_modules_promoteFromJob`: direct job→module shortcut

**Verification**: Created `crypto.cipher-monitor@1.0.0` and `@1.0.1`, index correctly updated.

### 9.5 Module Store

- [X] Structure:`index.json`,`<name>/<version>/manifest.json`,`<name>/<version>/module.js`
- [X]`kahlo_modules_list`: returns available modules with versions
- [X]`kahlo_modules_get`: returns module manifest, source, and provenance
- [X] Update`jobs.start` to accept`module_ref`

**Exit Criteria**: Full workflow verified: inline job → draft → iterate → module → reuse. **PASSED**

---

## Phase 10: Hardening and UX for AI Operation

**Objective**: Improve reliability, observability, and operator experience for long AI-driven sessions.

### 10.1 Error Messages and Provenance

- [X] Structured error envelopes:`{ code, message, details?, suggestion? }`
- [X] Common codes:`NOT_FOUND`,`INVALID_ARGUMENT`,`UNAVAILABLE`,`TIMEOUT`,`INTERNAL`,`NOT_IMPLEMENTED`
- [X] Jobs record`module_provenance` for traceability
- [X] Promoted modules record derivation chain
- [X] Artifacts and events include`job_id` for correlation

**Implementation**: `KahloToolError` interface in `result.ts`, `ModuleProvenance` type in `jobController.ts`.

### 10.2 Job Heartbeat and Health Tracking

- [X] Daemon jobs call`ctx.heartbeat()` periodically
- [X] Orchestrator tracks`heartbeat` timestamp per job
- [X] Host calculates health based on 30s staleness threshold
- [X]`jobs.status` returns`health: "healthy" | "unhealthy" | "unknown"`
- [X]`jobs.list` includes`health` field

**Exit Criteria**: All tools use structured error envelopes; daemon jobs report heartbeats; provenance trails complete. **PASSED**

---

## Phase 11: Per-Job Script Isolation

**Objective**: Eliminate accumulated hooks when iterating on jobs by running each job in its own Frida Script.

**Problem**: Single orchestrator script with shared JavaScript context causes hooks to persist after job cancellation, leading to duplicate events and conflicting behavior during iteration.

**Solution**:

```
Before: Session → Single Orchestrator Script → Jobs (shared context, hooks persist)
After:  Session → Orchestrator Script (coordinator only)
               → Job Script A (isolated, unload = cleanup)
               → Job Script B (isolated, unload = cleanup)
```

### 11.1 Job Script Template

- [X] Create`jobScriptRuntime.js` and`jobScriptRuntime.entry.ts`
- [X] Runtime compiled with frida-compile to bundle Java bridge
- [X] Module source and params passed via RPC
- [X] Full`ctx` API:`job_id`,`emit()`,`log()`,`heartbeat()`,`emitArtifact()`, timers,`sleep()`,`Java`,`javaAvailable()`,`requireJava()`
- [X] Module loading: CommonJS`module.exports = { init?, start }`
- [X] RPC exports:`ping()`,`startJob()`,`getStatus()`

### 11.2 Host-Side Script Management

- [X] Add to `targetManager.ts`:

  - [X]`jobScripts: Map<string, frida.Script>` per TargetEntry
  - [X]`createJobScript()`,`unloadJobScript()`,`getJobScript()`,`getJobScriptExports()`
  - [X]`unloadAllJobScripts()`,`onJobScriptDestroyed()`
  - [X] Wire message handlers per job script
  - [X] Update`detachTarget()` to unload all job scripts
- [X] Add to `jobController.ts`:

  - [X]`startJobIsolated()`,`cancelJobIsolated()`,`jobStatusIsolated()`
  - [X] Track host-side state for isolated jobs
  - [X] Register script destroyed handler for crashed jobs

### 11.3–11.4 Isolated Job Path

- [X] Job isolation enabled by default (`KAHLO_JOB_ISOLATION=false` for legacy)
- [X] All job operations delegate to isolated path
- [X] Script lifecycle events wired

### 11.5 Bootstrap Job Handling

- [X] Bootstrap jobs use per-script pattern via`startBootstrapJobIsolated()`
- [X] Bootstrap runs while suspended, script persists (hooks stay active)
- [X] Mark with`is_bootstrap: true` in JobEntry
- [X] Cancellable like any other job
- [X] Child bootstrap follows same pattern

### 11.6 Legacy Code Removal

- [X] Simplified`orchestratorAgent.js`: removed job registry and context, kept`ping()` and`getSnapshot()`
- [X] Simplified`jobController.ts`: removed isolation toggle, all jobs now isolated
- [X] Cleaned up legacy comments and references

### 11.7 Documentation Updates

- [X] Updated`about.ts`: concepts, invariants, operational guidelines
- [X] Updated tool descriptions in`register.ts`: isolation behavior, automatic cleanup

**Exit Criteria**: Each job runs in own Frida Script; cancel unloads script with automatic hook cleanup; bootstrap jobs persist correctly. **PASSED**

---

## Phase 12: Code Quality-Concurrency and Deduplication

**Objective**: Address race conditions and reduce code duplication.

### 12.1 Shared Utilities Module

- [X] Created`src/utils.ts`:
  - [X]`isoNow()`,`isNonEmptyString()`,`asRecord()`,`isRecord()`,`yyyyMmDdUtc()`
- [X] Updated all backend modules to use shared utilities

**Note**: `jobScriptRuntime.js` and `orchestratorAgent.js` are Frida scripts compiled with `frida-compile`, they cannot import Node.js modules, so they maintain local implementations.

### 12.2 Concurrency Guards for Job Operations

- [X]`KeyedLock` utility class in`utils.ts`
- [X] Job operations locked in`jobController.ts`:`startJob()`,`startBootstrapJob()`,`cancelJob()`
- [X] Target operations locked in`targetManager.ts`:`ensureTarget()`,`detachTarget()`,`createJobScript()`,`unloadJobScript()`
- [X] Idempotency:`cancelJob()` and`detachTarget()` return current state if already terminal

### 12.3–12.4 Draft and Module Concurrency

- [X] Draft operations locked:`createDraft()`,`updateDraft()`,`deleteDraft()`
- [X] Module operations locked:`promoteToModule()`
- [X] Duplicate job start prevention via lock serialization

### 12.5 Graceful Concurrent Target Operations

- [X]`createJobScript()` re-validates target state after lock acquisition
- [X]`unloadJobScript()` idempotent if script already unloaded
- [X]`cancelJob()` returns current state if already terminal

**Verification**: Concurrent MCP calls tested: draft creation, job starts, module promotions, job cancels, target detach all behave correctly.

**Exit Criteria**: Single utility implementations; no duplicate helpers; concurrent operations don't corrupt state; operations idempotent where documented. **PASSED**

---

## Phase 13: Standard Library (stdlib)

**Objective**: Provide battle-tested utility functions automatically available to all jobs.

**Motivation**: AI agents repeatedly write the same helper code; inconsistent implementations cause bugs; common patterns should be optimized once.

**Design**: Exposed as `ctx.stdlib.*` namespace plus convenience functions directly on `ctx` (e.g., `ctx.getJavaStackTrace()`).

### 13.1 Core Architecture

- [X] Created`jobScriptStdlib.js` with all stdlib functions
- [X] Bundled into job runtime via`jobScriptRuntime.entry.ts`
- [X] Exposed via ctx object (hybrid: common functions direct, grouped under`ctx.stdlib.*`)

### 13.2 Stack Trace Utilities

- [X]`ctx.getJavaStackTrace(options?)` returns stack as frame objects
- [X]`ctx.getJavaStackTraceString()` returns formatted string
- [X]`ctx.stdlib.stack.getException(throwable)` converts Throwable to trace string

### 13.3 Object Inspection Utilities

- [X]`ctx.inspectObject()` alias for`ctx.stdlib.inspect.toJson()`
- [X]`ctx.stdlib.inspect.className()`,`simpleClassName()`,`fields()`,`methods()`
- [X]`ctx.stdlib.inspect.getField()`,`toJson()`,`isInstance()`,`superclassChain()`,`interfaces()`

### 13.4 Class Discovery Utilities

- [X]`ctx.stdlib.classes.find(pattern, options?)` find loaded classes by pattern
- [X]`ctx.stdlib.classes.isLoaded()`,`load()`,`enumerate()`,`instances()`,`getClassLoader()`

### 13.5 Byte Array Utilities

- [X]`ctx.stdlib.bytes.toHex()`,`fromHex()`,`toBase64()`,`fromBase64()`
- [X]`ctx.stdlib.bytes.fromJavaBytes()`,`toJavaBytes()`,`equals()`,`concat()`,`slice()`

### 13.6 String Utilities

- [X]`ctx.stdlib.strings.fromJava()`,`toJava()`,`truncate()`
- [X]`ctx.stdlib.strings.toUtf8()`,`fromUtf8()`,`matches()`,`safeToString()`

### 13.7 Intent Utilities (Android)

- [X]`ctx.stdlib.intent.parse()`,`getExtras()`,`create()`
- [X]`ctx.stdlib.intent.getComponent()`,`isExplicit()`,`flagsToStrings()`

### 13.8 Hooking Helpers

- [X]`ctx.stdlib.hook.method()`,`methodWithSignature()`,`allOverloads()`
- [X]`ctx.stdlib.hook.constructor()`,`native()`,`onClassLoad()`,`replace()`

### 13.9 Safe Execution Utilities

- [X]`ctx.stdlib.safe.call()`,`java()`,`tryUse()`
- [X]`ctx.stdlib.safe.invoke()`,`get()`,`timeout()`

### 13.10 Timing Utilities

- [X]`ctx.stdlib.time.now()`,`nowMs()`,`hrNow()`,`format()`
- [X]`ctx.stdlib.time.stopwatch()`,`sleep()`,`measure()`,`debounce()`,`throttle()`

### 13.11 Documentation and Testing

- [X] JSDoc comments for all functions
- [X] Updated`about.ts` with stdlib reference
- [X] Automated device smoke tests: all 9 namespaces (64 functions) validated on Pixel 7 with LINE Messenger

### 13.12 Build Integration

- [X]`copy-orchestrator-agent.mjs` builds both orchestrator and job runtime
- [X] Stdlib bundled into 939KB compiled jobScriptRuntime
- [X] Verified: no imports needed, works in oneshot/daemon/bootstrap jobs

**Exit Criteria**: All stdlib functions work correctly on real Java apps; documented with JSDoc and examples; automatically available via `ctx.stdlib`. **PASSED**

---

## Phase 14: Hardening Concurrency and Persistence

**Objective**: Address bugs identified during comprehensive code review focusing on concurrency safety, data persistence, and error handling.

### 14.1 KeyedLock Race Condition

**Problem**: `KeyedLock.withLock()` had a race between loop completion and `pending.set()`.

**Implementation**: Replaced `while`/`await` polling with synchronous predecessor capture. Lock registration now occurs before any `await`, and cleanup is conditional on being tail of chain.

### 14.2 Nested Lock Deadlock Prevention

**Problem**: `startBootstrapJob()` acquired two locks in sequence, creating potential deadlock.

**Implementation**: Removed unnecessary inner lock from `startBootstrapJob()`. The inner lock served no purpose since the job_id is freshly generated and cannot be referenced until the function returns. Added lock ordering policy documentation to `utils.ts`.

### 14.3 Child Target Cleanup

**Problem**: Child job scripts were not unloaded before session detach in `detachTarget()`.

**Implementation**: Added `unloadAllJobScriptsInternal()` call in the child cleanup loop, after marking state but before orchestrator unload. Uses the lockless internal variant since the parent lock is already held.

### 14.4 Spawn Gating Reference Count Balance

**Problem**: When bootstrap fails with `gating="child"`, ref-count was never decremented. Additionally, spawn gating was enabled after bootstrap, so child processes spawned during bootstrap weren't captured.

**Implementation**: Restructured the bootstrap try/catch in `ensureTargetSpawn()`. Added `spawnGatingEnabled` tracking before the try block. Moved `enableSpawnGatingForTarget()` to before `startBootstrapJob()`. Added cleanup in catch block with best-effort error handling.

### 14.5 Event Persistence Error Handling

**Problem**: WriteStream errors were not handled, and backpressure was ignored.

**Implementation** (`eventPipeline.ts`):

- Extended`TargetState` with`streamErrored`,`backpressureCount`,`droppedDueToError` fields
- Added error listener on WriteStream creation
- Updated`persist()` to skip writes on errored streams and track backpressure
- Updated`closeTargetEventPipeline()` to log metrics and handle errored streams gracefully

### 14.6 Atomic Artifact Storage

**Problem**: Artifacts written before index update could cause inconsistency on crash.

**Implementation** (`artifactManager.ts`):

- Added`cleanupOrphanedTmpFiles()` to remove`.tmp` files on startup
- Implemented atomic write pattern: write to`.tmp`, update index, rename to final
- Added rollback on index update failure

### 14.7 Atomic Draft Persistence

**Problem**: Draft writes could leave partial files on crash.

**Implementation**: Draft writes now use atomic temp file + rename pattern. Orphaned `.tmp` files are cleaned on startup.

### 14.8 Module Index Rebuild Validation

**Problem**: Version directories with malformed names could be included in index without validation.

**Implementation**: Added semver validation in `rebuildIndexFromDisk()` to skip non-conforming version directories.

### 14.9 Draft Promotion Race Condition

**Problem**: `getDraft()` returned a mutable reference. Concurrent `updateDraft()` could mutate the source between fetch and promotion.

**Implementation**: Modified `getDraft()` in `draftManager.ts` to return `{ ...draft }` (shallow copy). Concurrent updates no longer affect snapshots captured for promotion.

### 14.10 ADB Timeout Error Distinction

**Problem**: Timeout errors were indistinguishable from other ADB failures, preventing AI agents from knowing whether to retry with longer timeout.

**Implementation**:

- Added`"timeout"` to`AdbError.kind` type
- Detect timeout by checking`error.code === "ETIMEDOUT"`
- Map to`code: "TIMEOUT"`,`retryable: true` in tool handler
- Added appropriate suggestion for timeout errors

### 14.11 Stdlib Documentation Synchronization

**Problem**: Documentation in `about.ts` had mismatches with actual stdlib implementation.

**Implementation**:

- Fixed`stack.getCaller()` signature (no parameters)
- Fixed`stack.filter()` and`stack.findFirst()` signatures
- Fixed`hook.allOverloads()`,`hook.constructor()`,`hook.onClassLoad()`,`hook.replace()` signatures
- Added missing functions to TypeScript interface:`time.measure()`,`time.debounce()`,`time.throttle()`

**Exit Criteria**: All items resolved; on-device smoke tests verify fixes. **PASSED**

---

## Phase 15: Bootstrap Resolution Fix

**Objective**: Implement `module_ref` and `draft_id` resolution for bootstrap jobs in `kahlo_targets_ensure`.

- [X] Add`getDraft`/`getModule` imports to`targetManager.ts`
- [X] Rewrite`resolveBootstrapSource()` to call`getDraft()`/`getModule()` instead of throwing`NOT_IMPLEMENTED`
- [X] Fix latent bug: move`resolveBootstrapSource()` call inside try/catch in`adoptChildProcess()`
- [X] Add`NOT_IMPLEMENTED` case to error switch in`tools/targets.ts`
- [X] Move`resolveBootstrapSource()` to pre-flight check before`device.spawn()` in`ensureTargetSpawn()`; fixes race condition where nonexistent module/draft could return`ok: true` followed by async target crash (the spawn + attach + orchestrator injection sequence introduced async suspension points that allowed the tool to return before module validation could throw)
- [X] TypeScript compiles clean (`npx tsc --noEmit`)
- [X] Add automated agent tests (`10.1-10.6-bootstrap-resolution.md`)
- [X] On-device verification: all 6 tests pass (3 positive, 2 negative, 1 edge case)

**Exit Criteria**: All three bootstrap kinds (`source`, `draft_id`, `module_ref`) resolve correctly; error cases return proper `NOT_FOUND`/`INVALID_ARGUMENT` codes; no orphaned processes on failure.

---

## Phase 16: Code Review Based Findings

**Objective**: Address bugs and quality issues identified by three independent code reviewers and cross-validated by two independent validators.

**Methodology**: Three reviewers (backend, tool layer, runtime) independently audited the codebase. Their combined findings were then independently validated by two validators. Only issues confirmed by both validators are listed. Issues marked `FALSE POSITIVE` by either validator were investigated and excluded or downgraded as noted.

### 16.1 Critical: `hook.method()` Argument Passing Bug

**Problem**: `jobScriptStdlib.js` lines 3588 and 3622 use `.call(this, args)` which passes the entire args array as a single argument. Should be `.apply(this, args)` to spread arguments correctly. Every hooked multi-parameter Java method receives wrong arguments.

- [X] Fix`.call(this, args)` to`.apply(this, args)` at line 3588 (single-method path)
- [X] Fix`.call(this, args)` to`.apply(this, args)` at line 3622 (overload path)
- [X] Verify with on-device test hooking a multi-parameter method (e.g.,`Cipher.doFinal(byte[], int, int)`)

**Exit Criteria**: Hooked methods with 2+ parameters receive correct individual arguments; no argument type mismatches or ClassCastExceptions.

### 16.2 Critical: Async Signal Handlers Without Top-Level Catch

**Problem**: `handleSpawnAdded` and `handleChildAdded` (`targetManager.ts:251-285, 291-325`) are async functions invoked from synchronous Frida signal handlers without `.catch()`. Unhandled rejection can crash the Node.js process or leave Android processes permanently suspended.

- [X] Wrap`handleSpawnAdded` invocation (line 200) in`.catch()` that logs error and does best-effort`device.resume(pid)`
- [X] Wrap`handleChildAdded` invocation (line 205) in`.catch()` that logs error and does best-effort`device.resume(pid)`

**Exit Criteria**: Signal handler failures are logged, never crash the server; suspended processes are resumed on failure.

### 16.3 Critical: `injectOrchestrator` Swallows Errors Silently

**Problem**: `injectOrchestrator` (`targetManager.ts:545-598`) catches all errors and sets `agent_state = "crashed"` but never throws. Callers (`ensureTargetAttach`, `ensureTargetSpawn`) return success with a target_id that cannot execute jobs.

- [X] After`injectOrchestrator`, check`entry.target.agent_state`; if`"crashed"`, throw`TargetManagerError("UNAVAILABLE", ...)` with the agent error details
- [X] Alternatively, include`agent_state` in the success response so the caller can warn
- [X] Verify that a failed orchestrator injection returns an error to the MCP client

**Exit Criteria**: Clients never receive a target_id with a silently crashed agent; failure is visible in the `ensureTarget` response.

### 16.4 Critical: `hook.onClassLoad()` Corrupts Global ClassLoader

**Problem**: `jobScriptStdlib.js:3953` sets `Java.classFactory.loader = loader` while iterating class loaders, never restoring the original. Corrupts class resolution for the entire script.

- [X] Save`Java.classFactory.loader` before the enumeration loop
- [X] Restore original value in a`finally` block after enumeration completes
- [X] Verify that`Java.use()` calls after`onClassLoad()` still use the correct default loader

**Exit Criteria**: `onClassLoad()` finds the target class without side effects on the global class loader state.

### 16.5 Critical: Artifact Manager No Rollback on Failed Rename

**Problem**: `artifactManager.ts:396-406`, when `renameSync` fails at Step 3, in-memory state (`artifacts` map, `totalBytes`, index) retains the record but the file doesn't exist at `storage_ref`. Budget consumed by phantom entries, `ok: true` returned.

- [X] On rename failure: rollback in-memory state (delete from maps, decrement`totalBytes`)
- [X] Return`{ ok: false }` or include warning in response
- [X] Consider updating`storage_ref` to the`.tmp` path as a fallback

**Exit Criteria**: Failed renames do not consume budget; artifact appears as failed, not successful.

### 16.6 Critical: TIMEOUT Missing from Zod Schema

**Problem**: `schemas.ts:158`, `zKahloErrorCode` enum omits `"TIMEOUT"`, but `result.ts` type includes it and `adb.ts` produces it. ADB timeout responses fail MCP output schema validation.

- [X] Add`"TIMEOUT"` to the`zKahloErrorCode` enum in`schemas.ts`
- [X] Verify ADB timeout errors pass output validation

**Exit Criteria**: `zKahloErrorCode` matches `KahloToolErrorCode` type exactly; ADB timeouts produce valid MCP responses.

### 16.7 Medium: Synthetic Events Silently Dropped

**Problem**: `recordAgentMessage` (`eventPipeline.ts:493`) gates on `msg.type === "send"`. Synthetic messages from `jobController.ts:657` (`job.crashed`) and `targetManager.ts:622` (`target.died`) lack the `type: "send"` wrapper and are silently dropped.

- [X] Wrap synthetic messages in`{ type: "send", payload: { kahlo: { ... } } }` format
- [X] Or add an alternate code path in`recordAgentMessage` for internal synthetic events
- [X] Verify`job.crashed` and`target.died` events appear in`kahlo_events_fetch`

**Exit Criteria**: All synthetic lifecycle events are recorded and fetchable.

### 16.8 Medium: Ad-Hoc `as any` Properties on Target

**Problem**: `targetManager.ts:593,619,959`, `agent_error`, `last_detach`, `resume_error` attached via `(entry.target as any)`. Not in `Target` interface, not surfaced to MCP client.

- [X] Add optional fields (`agent_error?`,`last_detach?`,`resume_error?`) to the`Target` interface
- [X] Include them in`getTargetStatus()` response
- [X] Remove`as any` casts

**Exit Criteria**: Diagnostic properties are properly typed and visible in `kahlo_targets_status` responses.

### 16.9 Medium: `loadConfig()` Reads File on Every Call

**Problem**: `loadConfig()` in `config.ts` calls `fs.readFileSync` on every invocation. Called from event pipeline, artifact manager, module store, draft manager.

- [X] Cache loaded config at module level (`let cachedConfig: KahloConfig | null = null`)
- [X] Provide explicit`reloadConfig()` for runtime changes
- [X] Verify config is loaded once and reused

**Exit Criteria**: Config file read once at startup (or first access), cached thereafter.

### 16.10 Medium: Child Target Cleanup Without Locks

**Problem**: `detachTarget` (`targetManager.ts:1389-1424`) modifies child target state and unloads scripts without holding each child's `targetOpsLock`. Race with concurrent child operations.

- [X] Acquire`targetOpsLock` for each child before modifying state, OR
- [X] Collect child IDs and call`detachTarget()` on each outside the parent's lock scope
- [X] Consider lock ordering implications (parent lock held while acquiring child locks)

**Exit Criteria**: No concurrent state corruption when detaching parent while child operations are in flight.

### 16.11 Medium: Schema Allows Omitting Both Required Params

**Problem**: `kahlo_events_fetch` and `kahlo_artifacts_list` mark both `target_id` and `job_id` as `.optional()`. Handler rejects at runtime, but schema doesn't express the "exactly one required" constraint.

- [X]~~Add Zod `.refine()` to enforce exactly one of `target_id`/`job_id` at schema level~~ Reverted:`.refine()` produces`ZodEffects` which`normalizeObjectSchema()` in MCP SDK cannot extract`.shape` from, causing tool advertisement to emit`{ type: "object" }` with no properties, Claude wouldn't see the parameters. Runtime validation in handlers (`events.ts:22`,`artifacts.ts:52`) already enforces the constraint.
- [X] Or update tool descriptions to prominently state the constraint

**Exit Criteria**: Invalid input rejected at schema validation, not just at runtime.

### 16.12 Medium: Job Tool Handlers Missing Suggestions

**Problem**: `kahloJobsStatus`, `kahloJobsList`, `kahloJobsCancel` (`jobs.ts:200-253`) don't include `suggestion` field in error responses. Inconsistent with target handlers.

- [X] Add`switch (err.code)` blocks with per-code suggestions to all three handlers
- [X] Follow the pattern established in`targets.ts`

**Exit Criteria**: All job tool error responses include actionable `suggestion` text.

### 16.13 Medium: Sync File I/O in Artifact Storage

**Problem**: `storeArtifact()` (`artifactManager.ts:327-409`) uses `writeFileSync`/`renameSync`/`unlinkSync`. Large artifacts block the event loop.

- [X] Adopted **hybrid approach**: write-path I/O (`storeArtifact`,`ensureTargetState`,`cleanupOrphanedTmpFiles`) reverted to sync`fs.*Sync`; read-path (`readArtifactPayload`) kept async since it's read-only with no atomicity requirements.
- [X] Updated callers:`recordAgentMessage`/`recordAgentEventMessage` in`eventPipeline.ts` reverted to sync signatures; all`.catch()` on`recordAgentMessage` in`targetManager.ts` (5 sites) and`jobController.ts` (1 site) converted to`try/catch`.
- [X] Note: agent-side 10 MB artifact cap bounds worst-case blocking;`eventPipeline.ts` own`ensureTargetState` was already deliberately sync, confirming the pattern.

**Exit Criteria**: Artifact storage maintains single-tick atomicity for all write operations; no TOCTOU races on budget, duplicate ID, or target state init.

### 16.14 Medium: `strings.toUtf8()` Surrogate Pair Bug

**Problem**: `jobScriptStdlib.js:2704-2724` - fallback UTF-8 encoder uses `charCodeAt()` which returns UTF-16 code units. Surrogate pairs (emoji, CJK extension B) encoded as two invalid 3-byte sequences instead of one 4-byte sequence.

- [X] Use`codePointAt()` instead of`charCodeAt()`
- [X] Advance by 2 positions when code point >= 0x10000 (surrogate pair consumed)
- [X] Test with emoji strings (e.g., U+1F600)

**Exit Criteria**: Non-BMP characters encoded as valid 4-byte UTF-8 sequences in the fallback path.

### 16.15 Medium: `snapshots.ts` Null vs Schema Mismatch

**Problem**: `snapshots.ts:51` returns `snapshot: null` when orchestrator returns undefined, but `zJsonObject` schema does not accept null.

- [X] Change fallback from`null` to`{}` (empty object), OR
- [X] Make schema field`.nullable()`

**Exit Criteria**: Snapshot responses pass output schema validation even when orchestrator returns no data.

### 16.16 Medium: Module Index Rebuild Overwrites on Failure

**Problem**: `rebuildIndexFromDisk()` (`moduleStore.ts:156-204`) writes empty index to disk even when directory scan fails silently, destroying potentially recoverable data.

- [X] Only persist rebuilt index if at least one module was found, OR
- [X] Back up the corrupted index before overwriting
- [X] Log when scan finds zero modules (distinguish "empty store" from "scan failure")

**Exit Criteria**: Transient filesystem errors do not destroy existing module index.

### 16.17 Medium: Duplicated Error Mapping Functions

**Problem**: `mapDraftErrorCode` and `mapModuleStoreErrorCode` are identical in `jobs.ts:23-50` and `modules.ts:28-57`.

- [X] Extract to shared utility (e.g.,`result.ts` or new`errorMapping.ts`)
- [X] Import from both files

**Exit Criteria**: Single source of truth for error code mapping.

### 16.18 Medium: Inconsistent Draft Tool Error Envelopes

**Problem**: `getDraft`/`listDrafts` (`register.ts:533-583`) use ad-hoc output schemas instead of `zKahloToolResult()`. Error shape differs from all other tools.

- [X] Create`zOutModulesGetDraft` and`zOutModulesListDrafts` in`schemas.ts` using`zKahloToolResult()`
- [X] Reference from`register.ts`

**Exit Criteria**: All tools use consistent error envelope structure.

### 16.19 Low: `about.ts` References Nonexistent "threads" Snapshot Kind

- [X] Change`about.ts:275` from "threads/modules/process info/etc." to "native modules, process info"

### 16.20 Low: `version_strategy: "exact"` Unusable

- [X] Add optional`exact_version` parameter to`promoteFromJob` and`promoteDraft` schemas, OR
- [X] Remove`"exact"` from the enum until implemented

### 16.21 Low: Unbounded `jobsById` Map

- [X] Add pruning for terminal-state jobs after a retention period (e.g., drop`module_source` after 1 hour)
- [X] Or add a configurable max job history size

### 16.22 Low: `safe.timeout()` Timer Leak

- [X] Store`setTimeout` ID; clear it when execution promise wins the race

### 16.23 Low: `bytes.fromBase64()` Non-Integer Length for Unpadded Input

- [X] Apply`Math.floor()` to`outputLen` calculation
- [X] Or pad`cleanedBase64` to multiple of 4 before processing

### 16.24 Low: Undocumented `filters` Parameter

- [X] Document supported filter keys (`kind`,`level`) in`about.ts` data_flow section

### 16.25 Low: Redundant Manual Validation in `updateDraft`

- [X] Remove manual`if (!args.source)` check in`register.ts:597-607` (Zod already enforces)

**Exit Criteria (Phase 16)**: All confirmed issues resolved; TypeScript compiles clean; on-device smoke tests pass; no regressions in existing automated agent tests.
