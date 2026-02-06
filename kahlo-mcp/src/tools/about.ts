import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toolOk } from "./result.js";

export interface KahloAboutContext {
  serverName: string;
  serverVersion: string;
  transport: string;
  dataDir: string;
  logLevel: string;
}

/**
 * Return a compact, operational "contract" describing how kahlo works.
 *
 * Why this exists:
 * - AI agents can lose context over long sessions.
 * - A single tool that restates the core model + workflows + failure modes
 *   reduces mis-planning and helps keep behavior consistent.
 *
 * This is intentionally more structured than prose so models can reliably
 * re-ingest it and use it as a stable mental model.
 *
 */
export function kahloAbout(ctx: KahloAboutContext): CallToolResult {
  const toolNames = {
    about: "kahlo_mcp_about",
    devices_list: "kahlo_devices_list",
    devices_get: "kahlo_devices_get",
    devices_health: "kahlo_devices_health",
    processes_list: "kahlo_processes_list",
    adb_command: "kahlo_adb_command",
    targets_ensure: "kahlo_targets_ensure",
    targets_status: "kahlo_targets_status",
    targets_detach: "kahlo_targets_detach",
    jobs_start: "kahlo_jobs_start",
    jobs_status: "kahlo_jobs_status",
    jobs_list: "kahlo_jobs_list",
    jobs_cancel: "kahlo_jobs_cancel",
    snapshots_get: "kahlo_snapshots_get",
    events_fetch: "kahlo_events_fetch",
    artifacts_list: "kahlo_artifacts_list",
    artifacts_get: "kahlo_artifacts_get",
    modules_list: "kahlo_modules_list",
    modules_get: "kahlo_modules_get",
    modules_createDraft: "kahlo_modules_createDraft",
    modules_createDraftFromJob: "kahlo_modules_createDraftFromJob",
    modules_getDraft: "kahlo_modules_getDraft",
    modules_listDrafts: "kahlo_modules_listDrafts",
    modules_updateDraft: "kahlo_modules_updateDraft",
    modules_promoteFromJob: "kahlo_modules_promoteFromJob",
    modules_promoteDraft: "kahlo_modules_promoteDraft",
  } as const;

  const payload = {
    schema_version: 1,
    toolkit: {
      name: ctx.serverName,
      version: ctx.serverVersion,
      transport: ctx.transport,
      log_level: ctx.logLevel,
      data_dir: ctx.dataDir,
      storage_layout_hint: {
        // From design.md §7 (example structure). This is a hint to help clients locate on-disk storage.
        runs: path.join(ctx.dataDir, "runs"),
        modules: path.join(ctx.dataDir, "modules"),
        drafts: path.join(ctx.dataDir, "drafts"),
        snapshots: path.join(ctx.dataDir, "snapshots"),
      }
    },

    concepts: {
      target: {
        summary:
          "A Target represents one instrumented Android app process (or spawn intent) on a specific device.",
        identity: ["target_id"],
        key_fields: [
          "device_id",
          "package (attach: process name from kahlo_processes_list; spawn: Android package ID)",
          "pid (if attached)",
          "mode: spawn|attach",
          "gating: none|spawn|child",
          "state: pending|running|dead|detached",
          "agent_state: not_injected|ready|crashed|reinjecting",
          "parent_target_id (for child targets captured via gating='child')",
        ],
        invariants: [
          "You must create/ensure a target before starting jobs. For gating='spawn' or gating='child', the bootstrap job runs automatically at spawn time.",
          "Targets can die; crashes are normal and should be expected.",
          "For mode='attach': use kahlo_processes_list first to get the exact process name.",
          "For mode='spawn': use the Android package ID directly (e.g., 'com.example.app').",
          "For gating='spawn': provide a bootstrap job in kahlo_targets_ensure - it runs while app is suspended, then app auto-resumes with hooks in place.",
          "For gating='child': DOES NOT WORK ON ANDROID. Android apps don't spawn children directly - zygote forks them. Use kahlo_processes_list polling or attach to known child process names (e.g., 'com.example.app:background') instead.",
        ],
      },

      job: {
        summary:
          "A Job is a unit of work that runs in its own Frida script instance within a target process. Each job is fully isolated - hooks, timers, and state are scoped to that job's script.",
        identity: ["job_id"],
        key_fields: [
          "target_id",
          "type: oneshot|interactive|daemon",
          "state: queued|starting|running|completed|failed|cancelled",
          "heartbeat (ISO 8601 timestamp of last heartbeat)",
          "metrics: { events_emitted, hooks_installed (auto-tracked via stdlib.hook helpers), errors }",
          "result (for completed oneshot jobs)",
          "error (last error payload if failed)",
          "is_bootstrap (true for bootstrap jobs created via gating='spawn')",
        ],
        invariants: [
          "Each job runs in its own Frida script - full isolation from other jobs.",
          "Jobs are independently cancellable. Cancellation unloads the job's script, which triggers Frida's automatic cleanup of all hooks, timers, and state installed by that job.",
          "Multiple jobs may run concurrently in one target without interfering.",
          "Iterating on jobs (cancel old, start new) gives you a clean slate each time - no hook accumulation.",
        ],
      },

      module: {
        summary:
          "A versioned, reusable instrumentation bundle (e.g., tls.unpin@1.2.0) used as job code.",
        identity: ["module_id@version (module_ref)"],
        key_fields: ["name", "version (semver)", "entrypoint", "manifest"],
      },

      draft: {
        summary:
          "A mutable, temporary module used for rapid iteration (edit/retest/promote).",
        identity: ["draft_id"],
        typical_flow: [
          "create draft",
          "start job from draft",
          "iterate updates",
          "promote to a versioned module",
        ],
      },

      event: {
        summary:
          "Small structured telemetry emitted by jobs; optimized for high volume and polled via cursor.",
        identity: ["event_id"],
        key_fields: [
          "ts",
          "target_id",
          "pid",
          "job_id",
          "kind",
          "level: debug|info|warn|error",
          "payload (JSON, size-bounded)",
          "dropped markers (on overflow)",
        ],
      },

      artifact: {
        summary:
          "Larger payloads stored/referenced on disk (files, dumps, traces). Fetch by id when needed. Max 10MB per artifact.",
        identity: ["artifact_id"],
        key_fields: [
          "target_id",
          "job_id",
          "ts",
          "type: file_dump|memory_dump|trace|pcap_like|custom",
          "size_bytes (raw size)",
          "stored_size_bytes (bytes on disk)",
          "sha256 (hex digest)",
          "mime (MIME type, default: application/octet-stream)",
          "name (optional filename hint)",
          "metadata (optional JSON)",
          "storage_ref (path to .bin file on disk)",
        ],
        retrieval_pattern: [
          "Job emits artifact via ctx.emitArtifact(opts, bytes)",
          "Host persists to disk and records in artifacts.jsonl",
          "Client calls kahlo_artifacts_list to discover artifacts by target_id or job_id",
          "Client calls kahlo_artifacts_get with artifact_id to retrieve metadata + storage_ref",
          "For small artifacts (≤32KB), kahlo_artifacts_get also returns inline base64 payload",
        ],
      },
    },

    data_flow: {
      // design.md §2.2 and §4.5
      events: [
        "Job emits event inside target process (agent)",
        "Host receives and normalizes event",
        "Host buffers events (per-target/per-job) and may persist to disk depending on configuration",
        "Client polls via kahlo_events_fetch(cursor) for backpressure-friendly retrieval",
        "Supported filter keys for kahlo_events_fetch: { kind: string (exact match on event kind, e.g., 'log', 'function_call', 'hook.triggered'), level: 'debug'|'info'|'warn'|'error' (exact match on event severity) }. Both filters are optional and combined with AND logic when both are provided.",
      ],
      artifacts: [
        "Job produces artifact (large payload) and sends an artifact envelope plus binary bytes (byte array) to the host",
        "Host stores artifact and returns references via kahlo_artifacts_list",
        "Client retrieves artifact via kahlo_artifacts_get when needed",
      ],
      guidance: [
        "Prefer polling (kahlo_events_fetch) over pushing huge data through tool outputs.",
        "Treat artifacts as the mechanism for non-trivial payloads; keep events small.",
      ],
    },

    typical_workflows: [
      {
        name: "Basic instrumentation loop",
        steps: [
          { tool: toolNames.devices_list, purpose: "Discover available devices." },
          {
            tool: toolNames.processes_list,
            purpose: "For mode='attach': list running processes to find the exact process name. Use the name field as 'package' (e.g., 'LINE' not 'jp.naver.line.android'). Skip this step for mode='spawn'.",
          },
          {
            tool: toolNames.targets_ensure,
            purpose: "mode='attach': attach to running process (use process name from kahlo_processes_list). mode='spawn' with gating='spawn': provide bootstrap job to install early hooks - app starts with hooks in place. mode='spawn' with gating='none': no bootstrap needed, may miss early init.",
          },
          {
            tool: toolNames.jobs_start,
            purpose: "Start additional jobs from module_ref/draft/source (for gating='spawn', bootstrap already ran at spawn time).",
          },
          {
            tool: toolNames.events_fetch,
            purpose: "Poll telemetry via cursor/limit; filter if needed.",
          },
          {
            tool: toolNames.jobs_status,
            purpose: "Check job lifecycle/heartbeat/metrics; decide to cancel or continue.",
          },
          {
            tool: toolNames.jobs_cancel,
            purpose: "Stop a misbehaving job (best-effort cleanup).",
          },
          {
            tool: toolNames.targets_detach,
            purpose: "Detach cleanly when done (cancels remaining jobs).",
          },
        ],
      },
      {
        name: "Iterate on a draft module",
        steps: [
          { tool: toolNames.modules_createDraft, purpose: "Create a draft from JS source." },
          { tool: toolNames.jobs_start, purpose: "Run the draft as a job via module.kind='draft_id' and observe events." },
          { tool: toolNames.jobs_cancel, purpose: "Cancel the job when done testing. This automatically cleans up all hooks installed by that job." },
          { tool: toolNames.modules_updateDraft, purpose: "Update draft source." },
          { tool: toolNames.jobs_start, purpose: "Start a new job with updated draft - you get a clean slate with no leftover hooks from previous iterations." },
          {
            tool: toolNames.modules_promoteDraft,
            purpose: "Freeze into a versioned module once stable.",
          },
        ],
        notes: [
          "Each job runs in its own script. Cancelling a job fully cleans up its hooks.",
          "No need for manual cleanup code in modules - just cancel and start fresh.",
        ],
      },
      {
        name: "Save working job as draft",
        steps: [
          { tool: toolNames.jobs_start, purpose: "Run inline job with module.kind='source'." },
          { tool: toolNames.events_fetch, purpose: "Verify job works correctly." },
          { tool: toolNames.modules_createDraftFromJob, purpose: "Save the job's source as a draft for iteration." },
          { tool: toolNames.modules_updateDraft, purpose: "Iterate on the draft if needed." },
          { tool: toolNames.modules_promoteDraft, purpose: "Promote to permanent module when stable." },
        ],
      },
      {
        name: "Use permanent modules",
        steps: [
          { tool: toolNames.modules_list, purpose: "List available modules in the store." },
          { tool: toolNames.modules_get, purpose: "Inspect module source and provenance." },
          { tool: toolNames.jobs_start, purpose: "Run module via module.kind='module_ref' (e.g., 'tls.unpin@1.0.0')." },
        ],
      },
      {
        name: "Inspection",
        steps: [
          { tool: toolNames.processes_list, purpose: "List running processes to identify candidate targets." },
          { tool: toolNames.snapshots_get, purpose: "Request on-demand state (native modules, process info)." },
          { tool: toolNames.artifacts_list, purpose: "List larger outputs produced by jobs." },
          { tool: toolNames.artifacts_get, purpose: "Retrieve artifact payload or storage reference." },
        ],
      },
    ],

    failure_modes: [
      {
        name: "Target app crash / process restart",
        expectation: "Normal during research; do not treat as catastrophic.",
        symptoms: ["target state becomes dead", "jobs stop heartbeating", "instrumentation stops triggering"],
        recommended_actions: [
          "Call kahlo_targets_status to confirm state/agent_state.",
          "Re-run kahlo_targets_ensure to reattach/respawn (depending on mode).",
          "Restart jobs that were running (best-effort).",
        ],
      },
      {
        name: "Orchestrator agent crash",
        expectation: "Possible under chaotic scripts; reinjection is best-effort.",
        symptoms: ["agent_state becomes crashed", "jobs fail/start errors", "no new events"],
        recommended_actions: ["Call kahlo_targets_status and then kahlo_targets_ensure again if needed."],
      },
      {
        name: "Job misbehavior (deadloop / event spam / no heartbeat)",
        expectation: "Common with arbitrary scripts.",
        symptoms: ["job heartbeat stalls", "event flood", "CPU spikes"],
        recommended_actions: [
          "Use kahlo_jobs_cancel for that job_id.",
          "Prefer tighter filters + limits in kahlo_events_fetch to avoid overload.",
          "As a last resort, detach the target session.",
        ],
      },
      {
        name: "Event flood / buffer overflow",
        expectation: "The system will drop events rather than crash; dropped markers may appear.",
        symptoms: ["missing events", "dropped markers/counters", "slower polling"],
        recommended_actions: [
          "Reduce event emission at source (job params) when possible.",
          "Poll more frequently with smaller limits.",
          "Use artifacts for bulk data instead of events.",
        ],
      },
      {
        name: "Persistence failures (disk full / permission issues)",
        expectation: "May occur on operator machines; surfaced as tool errors/diagnostics.",
        symptoms: ["errors writing events/artifacts", "missing artifacts", "fetch failures"],
        recommended_actions: ["Check data_dir free space and permissions; retry operations."],
      },
    ],

    operational_guidelines: [
      "Treat crashes as normal; always design workflows to reattach and resume.",
      "Prefer polling for telemetry (kahlo_events_fetch) with cursor + limit; avoid huge tool responses.",
      "Use job cancellation early and often to keep sessions healthy. Cancelling a job automatically cleans up all its hooks.",
      "When iterating on instrumentation code, cancel the old job before starting a new one. Each new job gets a clean slate - no accumulated hooks from previous iterations.",
      "No need to write cleanup code in modules. Frida automatically removes all Interceptor hooks, Java method replacements, timers, and state when a job's script is unloaded.",
      "Use artifacts for large payloads and keep events small and structured.",
      "Use kahlo_adb_command for device exploration: list packages, get app info, check Android version, etc. ADB shell runs as unprivileged 'shell' user by default.",
      "For root access via ADB (e.g., /data/data/), use su: ['shell', 'su', '-c', 'ls /data/data/<pkg>'] or ['shell', 'su', '-c', 'cat /data/data/<pkg>/shared_prefs/prefs.xml']. Requires rooted device with su binary (Magisk, etc.).",
      "For mode='attach': use kahlo_processes_list first to get the exact process name.",
      "For mode='spawn': use the Android package ID (e.g., 'com.example.app') - no need to list processes first.",
      "For gating='spawn' (early hooks): provide a bootstrap job in kahlo_targets_ensure - the bootstrap runs while suspended, then app auto-resumes with hooks in place. No separate resume step needed.",
      "For gating='none': app resumes immediately after orchestrator injection (simpler but may miss earliest init, no bootstrap needed).",
      "For gating='child' (multi-process): DOES NOT WORK ON ANDROID. Android uses zygote to fork child processes, which Frida's spawn gating cannot capture. For Android multi-process apps, use kahlo_processes_list to discover child processes by name pattern (e.g., 'com.example.app:background', 'com.example.app:service') and attach to them separately.",
      "Use mode='spawn' with gating='spawn' and a bootstrap job when you need to hook early app initialization (e.g., Application.onCreate).",
      // stdlib guidelines
      "Use ctx.stdlib.* utilities instead of writing boilerplate - they handle edge cases, Java/JS type conversions, and error handling correctly.",
      "For stack traces: ctx.getJavaStackTrace() or ctx.stdlib.stack.capture() - don't manually call Thread.currentThread().getStackTrace().",
      "For byte arrays: ctx.stdlib.bytes.fromJavaBytes() handles signed→unsigned conversion that raw array access gets wrong.",
      "For hooking: ctx.stdlib.hook.method() simplifies Java.use + implementation replacement with proper error handling.",
      "For safe Java calls: ctx.stdlib.safe.tryUse() returns null instead of throwing, ctx.stdlib.safe.java() wraps in Java.perform().",
      "For Intent analysis: ctx.stdlib.intent.parse() extracts action, data, extras, component, flags in one call.",
    ],

    module_contract: {
      summary:
        "Job modules are CommonJS-style JavaScript that export lifecycle functions. Each job runs in its own Frida script instance, providing full isolation. When a job is cancelled, Frida automatically cleans up all hooks, timers, and state - no manual cleanup code needed.",
      format: "module.exports = { init: function(ctx) { ... }, start: function(params, ctx) { ... } }",
      required_exports: {
        start: {
          signature: "start(params, ctx)",
          description:
            "Main entry point. Called after init. `params` is the JSON object passed via kahlo_jobs_start. Return value becomes job.result for oneshot jobs. May return a Promise for async work.",
        },
      },
      optional_exports: {
        init: {
          signature: "init(ctx)",
          description:
            "Called once before start. Use for setup that doesn't depend on params.",
        },
      },
      ctx_api: {
        job_id: "string - Unique identifier for this job instance.",
        emit: {
          signature: "ctx.emit(kind, payload, level)",
          description: "Emit a telemetry event. Arguments: kind (string), payload (object), level ('debug'|'info'|'warn'|'error'). Events are retrieved via kahlo_events_fetch.",
          example: "ctx.emit('hook.triggered', { method: 'onCreate' }, 'info')",
        },
        log: {
          signature: "ctx.log(level, message, extra)",
          description: "Convenience function to emit a log event. Wraps ctx.emit('log', {message, extra}, level).",
          example: "ctx.log('info', 'Hook installed', { target: 'Cipher' })",
        },
        heartbeat: {
          signature: "ctx.heartbeat()",
          description: "Update the job's heartbeat timestamp. Important for daemon jobs to signal they are still alive.",
        },
        sleep: {
          signature: "ctx.sleep(ms)",
          description: "Promise-based sleep. Returns a Promise that resolves after ms milliseconds. Timer is auto-cleared on job cancel.",
          example: "await ctx.sleep(1000); // wait 1 second",
        },
        newArtifactId: {
          signature: "ctx.newArtifactId()",
          description: "Generate a unique artifact ID (low-level, prefer emitArtifact).",
        },
        emitArtifact: {
          signature: "ctx.emitArtifact(opts, bytes)",
          description: "Emit an artifact to the host. opts: { type, mime?, name?, metadata? }. bytes: ArrayBuffer or Uint8Array. Returns { artifact_id, size_bytes } or { error }. Max 10MB per artifact.",
          example: "ctx.emitArtifact({ type: 'memory_dump', name: 'heap.bin' }, bytes)",
        },
        setTimeout: "Frida-safe setTimeout (auto-cleared on job cancel).",
        setInterval: "Frida-safe setInterval (auto-cleared on job cancel).",
        clearTimeout: "Clear a timeout.",
        clearInterval: "Clear an interval.",
        Java: "Java bridge handle (null if unavailable). Prefer ctx.Java over global Java for portability.",
        javaAvailable: {
          signature: "ctx.javaAvailable()",
          description: "Returns true if Java APIs are available in this process.",
        },
        requireJava: {
          signature: "ctx.requireJava(hint)",
          description: "Ensure Java is available, otherwise emit error event and throw. Returns the Java bridge object.",
          example: "var Java = ctx.requireJava('Need Java for this hook');",
        },
        // ========== Convenience shortcuts to stdlib ==========
        getJavaStackTrace: {
          signature: "ctx.getJavaStackTrace(options?)",
          description: "Capture current Java stack trace as array of frame objects. Shortcut for ctx.stdlib.stack.capture(). Each frame: {className, methodName, fileName, lineNumber}.",
          example: "var frames = ctx.getJavaStackTrace({ limit: 5 });",
        },
        getJavaStackTraceString: {
          signature: "ctx.getJavaStackTraceString(options?)",
          description: "Capture current Java stack trace as formatted string. Shortcut for ctx.stdlib.stack.toString().",
          example: "ctx.emit('call', { stack: ctx.getJavaStackTraceString({ limit: 10 }) }, 'info');",
        },
        inspectObject: {
          signature: "ctx.inspectObject(obj, options?)",
          description: "Convert Java object to JSON-safe representation. Shortcut for ctx.stdlib.inspect.toJson(). Handles primitives, strings, arrays, collections, maps.",
          example: "var data = ctx.inspectObject(intent.getExtras(), { maxDepth: 3 });",
        },
        // ========== Standard Library ==========
        stdlib: {
          signature: "ctx.stdlib.<namespace>.<function>()",
          description: "Standard library providing 50+ utility functions for common instrumentation tasks. Organized into 9 namespaces. Available automatically in all jobs - no imports needed.",
          namespaces: {
            stack: "Stack trace capture and formatting",
            inspect: "Object introspection and type discovery",
            classes: "Java class enumeration and loading",
            bytes: "Binary data manipulation (hex, base64, Java byte[])",
            strings: "String manipulation and encoding",
            intent: "Android Intent parsing and construction",
            hook: "Hook installation helpers",
            safe: "Safe execution wrappers (structured errors)",
            time: "Timing utilities (timestamps, stopwatch, debounce)",
          },
          example: "var hex = ctx.stdlib.bytes.toHex(keyData); ctx.emit('key', { hex: hex }, 'info');",
        },
      },
      stdlib_reference: {
        note: "Complete function reference for ctx.stdlib.* - use these instead of writing boilerplate code.",
        stack: {
          "capture(options?)": "Returns array of {className, methodName, fileName, lineNumber}. Options: {skip?, limit?}",
          "toString(options?)": "Returns formatted stack trace string. Options: {skip?, limit?, separator?}",
          "getException(throwable)": "Convert Java Throwable to full stack trace string with cause chain",
          "filter(frames, pattern)": "Filter stack frames by pattern (string or RegExp)",
          "findFirst(frames, pattern)": "Find first frame matching pattern (string or RegExp)",
          "getCaller()": "Get caller frame (auto-skips internal frames)",
        },
        inspect: {
          "className(obj)": "Get fully-qualified class name of Java object",
          "simpleClassName(obj)": "Get simple class name (without package)",
          "fields(obj, options?)": "Get all fields including private. Returns [{name, type, declaringClass, modifiers}]",
          "methods(obj, options?)": "List all methods. Options: {includeInherited?}. Returns [{name, returnType, paramTypes}]",
          "getField(obj, fieldName)": "Get field value. Returns {ok, value?, error?}",
          "toJson(obj, options?)": "Convert to JSON-safe representation. Options: {maxDepth?, maxArrayLength?, maxStringLength?}",
          "isInstance(obj, className)": "Check if object is instance of a class",
          "superclassChain(obj)": "Get inheritance chain as array of class names",
          "interfaces(obj, includeInherited?)": "Get interfaces implemented by the object's class",
        },
        classes: {
          "find(pattern, options?)": "Find loaded classes. String=prefix match, RegExp=full match. Options: {limit?}",
          "enumerate(callbackOrOptions)": "Stream all classes. Callback mode: enumerate(fn) calls fn(className). Options mode: enumerate({limit}) returns array",
          "load(className)": "Safe Java.use() - returns null on failure instead of throwing",
          "isLoaded(className)": "Check if class is loaded (faster than try-catch around Java.use)",
          "instances(className, options?)": "Find live heap instances. Options: {limit?}",
          "getClassLoader(className)": "Get ClassLoader for a loaded class",
        },
        bytes: {
          "toHex(bytes)": "Convert byte array to hex string: [0xDE,0xAD] → 'dead'",
          "fromHex(hex)": "Convert hex string to Uint8Array (handles 0x prefix)",
          "toBase64(bytes)": "Encode bytes as base64 string",
          "fromBase64(b64)": "Decode base64 string to Uint8Array",
          "fromJavaBytes(javaByteArray)": "Convert Java byte[] to Uint8Array (handles signed→unsigned)",
          "toJavaBytes(data)": "Convert Uint8Array/array to Java byte[]",
          "equals(a, b)": "Compare two byte arrays for equality",
          "concat(...arrays)": "Concatenate multiple byte arrays",
          "slice(data, start, end?)": "Extract a slice of a byte array",
        },
        strings: {
          "fromJava(javaString)": "Safely convert Java String to JS string (null → '')",
          "toJava(jsString)": "Convert JS string to Java String object",
          "truncate(str, maxLen)": "Truncate with ellipsis: 'hello world',8 → 'hello...'",
          "toUtf8(str)": "Encode string as UTF-8 bytes (Uint8Array)",
          "fromUtf8(bytes)": "Decode bytes as UTF-8 string",
          "matches(str, pattern)": "Test if string matches pattern (string or RegExp)",
          "safeToString(obj)": "Safe toString that handles null/undefined and exceptions",
        },
        intent: {
          "parse(intent)": "Extract all Intent info: {action, data, type, categories, extras, flags, component}",
          "getExtras(intent)": "Extract extras Bundle as JSON object",
          "create(opts)": "Create Intent from {action?, data?, type?, className?, packageName?, extras?}",
          "getComponent(intent)": "Get component name: {packageName, className} or null",
          "isExplicit(intent)": "Check if Intent has component set (explicit intent)",
          "flagsToStrings(intent)": "Convert flags bitmask to human-readable strings",
        },
        hook: {
          _note: "All hook helpers auto-increment metrics.hooks_installed on success. Use kahlo_jobs_status to see the count.",
          "method(className, methodName, callbacks)": "Hook first overload. callbacks: {onEnter?, onLeave?}. Returns {ok}. Auto-increments hooks_installed by 1.",
          "methodWithSignature(className, methodName, paramTypes, callbacks)": "Hook specific overload by param types. paramTypes: ['java.lang.String', 'int']. Auto-increments hooks_installed by 1.",
          "allOverloads(className, methodName, handler)": "Hook ALL overloads with unified handler. handler: function(args, original) { return original.call(this, args); }. Returns {ok, count}. Auto-increments hooks_installed by count.",
          "constructor(className, handler)": "Hook all constructors. handler: function(args) { ... }. Returns {ok, count}. Auto-increments hooks_installed by count.",
          "native(address, callbacks)": "Hook native function by NativePointer address. Auto-increments hooks_installed by 1.",
          "onClassLoad(className, callback)": "Register callback for when a specific class is loaded. callback: function(classWrapper) { ... }",
          "replace(classWrapper, methodName, replacement)": "Replace method implementation entirely. Returns cleanup function. Auto-increments hooks_installed by 1.",
        },
        safe: {
          "call(fn)": "Execute fn with structured result: {ok, result?, error?}",
          "java(fn)": "Execute Java-interacting code, auto-wraps in Java.perform()",
          "tryUse(className)": "Java.use() that returns null instead of throwing",
          "invoke(obj, methodName, ...args)": "Safely invoke method with variadic args, returns null on failure",
          "get(obj, path, defaultValue?)": "Safely get nested property by dot-path: 'a.b.c'",
          "timeout(fn, timeoutMs)": "Execute with timeout: {ok, result?, timedOut?}",
        },
        time: {
          "now()": "Current time as ISO 8601 string",
          "nowMs()": "Current time as epoch milliseconds",
          "hrNow()": "High-resolution timestamp for performance measurement",
          "format(durationMs)": "Format ms as human duration: 3661000 → '1h 1m 1s'",
          "stopwatch()": "Create stopwatch: {elapsed(), reset()}",
          "sleep(ms)": "Async sleep: await ctx.stdlib.time.sleep(1000)",
          "measure(fn)": "Execute and measure: {result, durationMs}",
          "debounce(fn, delayMs)": "Return debounced version of function",
          "throttle(fn, intervalMs)": "Return throttled version (max 1 call per interval)",
        },
      },
      artifact_emission: {
        description:
          "PREFERRED: Use ctx.emitArtifact(opts, bytes) which handles envelope creation, validation, and size limits. ALTERNATIVE: Use Frida's send() directly with a kahlo envelope and ArrayBuffer.",
        envelope_format: {
          kahlo: {
            type: "artifact",
            ts: "ISO timestamp",
            artifact: {
              artifact_id: "from ctx.newArtifactId()",
              job_id: "from ctx.job_id",
              type: "memory_dump|file_dump|trace|pcap_like|custom",
              size_bytes: "byte length of payload",
              mime: "optional MIME type",
              name: "optional filename hint",
              metadata: "optional JSON object",
            },
          },
        },
        example:
          "var id = ctx.newArtifactId(); send({ kahlo: { type: 'artifact', ts: new Date().toISOString(), artifact: { artifact_id: id, job_id: ctx.job_id, type: 'memory_dump', size_bytes: bytes.byteLength } } }, bytes.buffer);",
      },
      common_mistakes: [
        "Using IIFE format instead of module.exports - WRONG: (function(){...})() - RIGHT: module.exports = {...}",
        "Wrong function signature - WRONG: start(ctx, params) - RIGHT: start(params, ctx)",
        "Wrong emit signature - WRONG: ctx.emit({kind:'x', payload:{}, level:'info'}) - RIGHT: ctx.emit('x', {}, 'info')",
        "Writing boilerplate instead of using stdlib - WRONG: Java.use('java.lang.Thread').currentThread().getStackTrace() - RIGHT: ctx.stdlib.stack.capture()",
        "Manual byte conversion with sign errors - WRONG: javaBytes[i] (gives signed -128 to 127) - RIGHT: ctx.stdlib.bytes.fromJavaBytes(javaBytes)",
        "Unsafe Java.use that throws - WRONG: Java.use('may.not.Exist') in try-catch - RIGHT: ctx.stdlib.safe.tryUse('may.not.Exist') returns null",
        "Passing array to safe.invoke - WRONG: ctx.stdlib.safe.invoke(obj, 'method', [a, b]) - RIGHT: ctx.stdlib.safe.invoke(obj, 'method', a, b) (variadic)",
        "String pattern to classes.find for suffix match - WRONG: classes.find('Activity') (prefix only) - RIGHT: classes.find(/.*Activity$/) (use RegExp for patterns)",
      ],
    },
  } as const;

  return toolOk(payload);
}

