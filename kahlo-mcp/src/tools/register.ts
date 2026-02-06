import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { kahloAbout, type KahloAboutContext } from "./about.js";
import { kahloAdbCommand } from "./adb.js";
import { kahloArtifactsGet, kahloArtifactsList } from "./artifacts.js";
import { kahloDevicesGet, kahloDevicesHealth, kahloDevicesList } from "./devices.js";
import { kahloEventsFetch } from "./events.js";
import { kahloJobsCancel, kahloJobsList, kahloJobsStart, kahloJobsStatus } from "./jobs.js";
import { kahloProcessesList } from "./processes.js";
import { kahloSnapshotsGet } from "./snapshots.js";
import { kahloTargetsDetach, kahloTargetsEnsure, kahloTargetsStatus } from "./targets.js";
import {
  kahloModulesCreateDraft,
  kahloModulesCreateDraftFromJob,
  kahloModulesUpdateDraft,
  kahloModulesGetDraft,
  kahloModulesListDrafts,
  kahloModulesPromoteDraft,
  kahloModulesPromoteFromJob,
  kahloModulesList,
  kahloModulesGet,
} from "./modules.js";
import { toolErr } from "./result.js";
import {
  withJsonStringFallback,
  zArtifactId,
  zBootstrapModule,
  zDeviceId,
  zDraftId,
  zJobId,
  zJobType,
  zJsonObject,
  zModuleRef,
  zNonEmptyString,
  zOutAdbCommand,
  zOutArtifactsGet,
  zOutArtifactsList,
  zOutDevicesGet,
  zOutDevicesHealth,
  zOutDevicesList,
  zOutEventsFetch,
  zOutJobsCancel,
  zOutJobsList,
  zOutJobsStart,
  zOutJobsStatus,
  zOutMcpAbout,
  zOutModulesCreateDraft,
  zOutModulesGet,
  zOutModulesGetDraft,
  zOutModulesList,
  zOutModulesListDrafts,
  zOutModulesPromoteDraft,
  zOutModulesPromoteFromJob,
  zOutModulesUpdateDraft,
  zOutProcessesList,
  zProcessScope,
  zOutSnapshotsGet,
  zOutTargetsDetach,
  zOutTargetsEnsure,
  zOutTargetsStatus,
  zPackageName,
  zSnapshotKind,
  zTargetGating,
  zTargetId,
  zTargetMode,
  zToolCursor,
} from "./schemas.js";

/**
 * Register the MCP tool surface for kahlo.
 *
 * This is intentionally schema-first:
 * - stable tool names
 * - AI-friendly descriptions
 * - strict input/output schemas
 */
export function registerTools(
  server: McpServer,
  about?: KahloAboutContext
): void {
  registerAboutTool(server, about);
  registerDeviceTools(server);
  registerProcessTools(server);
  registerAdbTools(server);
  registerTargetTools(server);
  registerJobTools(server);
  registerSnapshotTools(server);
  registerEventTools(server);
  registerArtifactTools(server);
  registerModuleTools(server);
}

function registerAboutTool(server: McpServer, about?: KahloAboutContext): void {
  server.registerTool(
    "kahlo_mcp_about",
    {
      title: "About kahlo (operational contract)",
      description:
        "Returns a compact, machine-usable contract for the kahlo toolkit: what targets/jobs/modules are, how events and artifacts flow, typical workflows, and expected failure modes. Use this to re-ground yourself after long sessions and to plan consistently. This tool is grounded in `design.md` and `plan.md`.",
      inputSchema: {},
      outputSchema: zOutMcpAbout,
    },
    async () =>
      kahloAbout(
        about ?? {
          serverName: "kahlo",
          serverVersion: "<unknown>",
          transport: "<unknown>",
          dataDir: "<unknown>",
          logLevel: "<unknown>",
        }
      )
  );
}

function registerDeviceTools(server: McpServer): void {
  server.registerTool(
    "kahlo_devices_list",
    {
      title: "List connected Android devices",
      description:
        "Returns all rooted Android devices connected via USB or network that are available for Frida instrumentation. Each device has a `device_id` (unique identifier), model name, and transport type (USB/TCP). Use this as the first step in your workflow to choose which device to instrument. If no devices are listed, ensure ADB is running and devices are authorized.",
      inputSchema: {},
      outputSchema: zOutDevicesList,
    },
    async () => kahloDevicesList()
  );

  server.registerTool(
    "kahlo_devices_get",
    {
      title: "Get device details",
      description:
        "Retrieves detailed information about a specific device by its `device_id`. Returns the device model, Android version, transport method (USB/TCP), current availability status, and whether frida-server is present/running. Use this to verify a device is ready before creating targets.",
      inputSchema: {
        device_id: zDeviceId,
      },
      outputSchema: zOutDevicesGet,
    },
    async (args) => kahloDevicesGet(args)
  );

  server.registerTool(
    "kahlo_devices_health",
    {
      title: "Check device health",
      description:
        "Checks whether a device is ready for Frida instrumentation. Verifies: (1) ADB connection is alive, (2) frida-server binary is present on the device, (3) frida-server process is running with appropriate privileges. Returns health status (healthy/degraded/unavailable) and diagnostic details. Use this to troubleshoot connectivity issues before attempting to instrument targets.",
      inputSchema: {
        device_id: zDeviceId,
      },
      outputSchema: zOutDevicesHealth,
    },
    async (args) => kahloDevicesHealth(args)
  );
}

function registerProcessTools(server: McpServer): void {
  server.registerTool(
    "kahlo_processes_list",
    {
      title: "List running processes",
      description:
        "Lists running processes on a device (pid + name). Use this to discover candidate targets before calling kahlo_targets_ensure. Uses frida-node to enumerate processes; scope can be adjusted to include more metadata.",
      inputSchema: {
        device_id: zDeviceId,
        scope: zProcessScope.optional().default("minimal"),
      },
      outputSchema: zOutProcessesList,
    },
    async (args) => kahloProcessesList(args)
  );
}

function registerAdbTools(server: McpServer): void {
  server.registerTool(
    "kahlo_adb_command",
    {
      title: "Execute ADB command",
      description:
        "Execute an ADB command using the configured ADB path. Useful for device exploration, package management, and debugging. " +
        "Common commands: " +
        "`['shell', 'pm', 'list', 'packages']` - list installed packages, " +
        "`['shell', 'dumpsys', 'package', '<pkg>']` - get package info, " +
        "`['shell', 'am', 'start', '-n', '<component>']` - start activity, " +
        "`['shell', 'getprop', 'ro.build.version.release']` - get Android version. " +
        "Returns stdout from the command. For device-specific commands, provide device_id. " +
        "PRIVILEGE ESCALATION: ADB shell runs as unprivileged 'shell' user by default. For root access (e.g., reading /data/data/), wrap commands with `su -c`: " +
        "`['shell', 'su', '-c', 'ls /data/data/<pkg>']` or `['shell', 'su', '-c', 'cat /data/data/<pkg>/databases/app.db']`. " +
        "This requires a rooted device with su binary available (e.g., Magisk).",
      inputSchema: {
        device_id: zDeviceId.optional().describe("Optional device serial. If provided, command runs on that device."),
        command: withJsonStringFallback(
          z.array(z.string()).min(1),
          "command"
        ).describe("ADB command arguments as array, e.g., ['shell', 'pm', 'list', 'packages']"),
        timeout_ms: z.number().int().positive().optional().default(30000).describe("Command timeout in milliseconds (default: 30000)."),
      },
      outputSchema: zOutAdbCommand,
    },
    (args) => kahloAdbCommand(args)
  );
}

function registerTargetTools(server: McpServer): void {
  server.registerTool(
    "kahlo_targets_ensure",
    {
      title: "Instrument a target process",
      description:
        "Instruments an Android app process (target) on a device. A 'target' represents a process that hosts an in-process orchestrator agent capable of executing jobs. You must create a target before starting any jobs. " +
        "TWO MODES: " +
        "(1) `mode='attach'`: Attaches to an already-running process. Use `kahlo_processes_list` first to find the exact process name (Frida process names often differ from Android package identifiers, e.g., 'LINE' not 'jp.naver.line.android'). " +
        "(2) `mode='spawn'`: Spawns the app fresh and instruments it before it runs - ideal for hooking early initialization. Use the Android package identifier (e.g., 'com.example.app'), NOT the process display name. " +
        "GATING (spawn mode only): " +
        "`gating='spawn'` REQUIRES a `bootstrap` job that installs early hooks. The bootstrap runs while the app is suspended, then the app resumes automatically with hooks in place. This enables hooking early init like `Application.onCreate`. " +
        "`gating='none'` resumes immediately after orchestrator injection (may miss earliest init, no bootstrap needed). " +
        "`gating='child'` REQUIRES a `bootstrap` job for the parent AND optionally `child_bootstrap` for captured children. Captures child processes spawned by this app and creates new targets for them. Child spawn events appear via `kahlo_events_fetch` as `target.child_spawned`. " +
        "**ANDROID LIMITATION**: `gating='child'` does NOT work on Android because Android apps don't spawn children directly - child processes are forked from zygote by the Android system. Use `kahlo_processes_list` polling or attach to known child process names instead. " +
        "Returns a `target_id` for all subsequent job/event/snapshot operations.",
      inputSchema: {
        device_id: zDeviceId,
        package: zPackageName,
        mode: zTargetMode,
        gating: zTargetGating.optional().default("none"),
        bootstrap: withJsonStringFallback(zBootstrapModule, "bootstrap")
          .optional()
          .describe(
            "Bootstrap job for early instrumentation. REQUIRED when gating='spawn' or gating='child'. " +
            "The bootstrap runs while the app is suspended, then the app resumes with hooks in place. " +
            "Use {kind:'source', source:'...'} for inline JS, or {kind:'module_ref', module_ref:'name@version'}."
          ),
        bootstrap_params: withJsonStringFallback(zJsonObject, "bootstrap_params")
          .optional()
          .describe("Parameters passed to the bootstrap job's start() function."),
        bootstrap_type: zJobType.optional().default("oneshot").describe(
          "Job type for bootstrap: 'oneshot' (default, runs once), 'daemon' (runs continuously), or 'interactive'."
        ),
        child_bootstrap: withJsonStringFallback(zBootstrapModule, "child_bootstrap")
          .optional()
          .describe(
            "Bootstrap job for captured child processes (used with gating='child'). " +
            "Each child process runs this bootstrap before resuming. If not provided, children resume without early hooks."
          ),
        child_bootstrap_params: withJsonStringFallback(zJsonObject, "child_bootstrap_params")
          .optional()
          .describe("Parameters passed to child bootstrap job's start() function."),
        child_bootstrap_type: zJobType.optional().default("oneshot").describe(
          "Job type for child bootstrap: 'oneshot' (default), 'daemon', or 'interactive'."
        ),
      },
      outputSchema: zOutTargetsEnsure,
    },
    async (args) => kahloTargetsEnsure(args)
  );

  server.registerTool(
    "kahlo_targets_status",
    {
      title: "Get target process status",
      description:
        "Returns the current state of an instrumented target process. Shows: process ID (pid), lifecycle state (pending/running/dead/detached), instrumentation mode (attach/spawn), gating configuration, and orchestrator agent state (not_injected/ready/crashed/reinjecting). " +
        "Use this to verify a target is ready to accept jobs, or to diagnose why jobs aren't starting (e.g., agent crashed).",
      inputSchema: {
        target_id: zTargetId,
      },
      outputSchema: zOutTargetsStatus,
    },
    async (args) => kahloTargetsStatus(args)
  );

  server.registerTool(
    "kahlo_targets_detach",
    {
      title: "Detach from target process",
      description:
        "Cleanly detaches Frida instrumentation from a target process without killing the app. All running jobs on this target will be cancelled, and the orchestrator agent will be unloaded. The app continues running normally after detachment. Use this when you're done instrumenting a process and want to leave it in a clean state. If the app has crashed or is unresponsive, this will fail gracefully.",
      inputSchema: {
        target_id: zTargetId,
      },
      outputSchema: zOutTargetsDetach,
    },
    async (args) => kahloTargetsDetach(args)
  );
}

function registerJobTools(server: McpServer): void {
  const zModuleSelector = z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("module_ref"),
      module_ref: zModuleRef,
    }),
    z.object({
      kind: z.literal("draft_id"),
      draft_id: zDraftId,
    }),
    z.object({
      kind: z.literal("source"),
      source: zNonEmptyString.describe(
        "Inline JavaScript source code for the job module (used for rapid iteration)."
      ),
    }),
  ]);

  server.registerTool(
    "kahlo_jobs_start",
    {
      title: "Start instrumentation job",
      description:
        "Starts an instrumentation job inside a target process. Each job runs in its own Frida script instance, providing full isolation - hooks, timers, and state are scoped to that job. When the job is cancelled, Frida automatically cleans up all hooks installed by that job. This means you can iterate freely: cancel an old job, start a new one, and get a clean slate with no leftover hooks. Multiple jobs can run concurrently in the same target without interfering. " +
        "Job types: 'oneshot' (runs once then stops), 'interactive' (controlled by external signals), 'daemon' (runs continuously, should call `ctx.heartbeat()` periodically to signal liveness - kahlo_jobs_status will show health='unhealthy' if no heartbeat for 30s). " +
        "The job's code comes from: (1) a versioned module from the module store, (2) a draft module, or (3) inline source code. " +
        "MODULE FORMAT: Inline source must use CommonJS style: `module.exports = { start: function(params, ctx) { ... } }`. Required: `start(params, ctx)` function. Optional: `init(ctx)` called before start. " +
        "The `ctx` object provides: `ctx.job_id`, `ctx.emit(kind, payload, level)`, `ctx.heartbeat()`, `ctx.emitArtifact(opts, bytes)`, and `ctx.stdlib.*` - a standard library with 50+ utilities for stack traces, object inspection, class discovery, byte manipulation, hooking helpers, and more. " +
        "STDLIB NAMESPACES: stack (capture/format traces), inspect (introspect Java objects), classes (find/load classes), bytes (hex/base64/Java byte[]), strings (Java↔JS conversion), intent (parse/create Android Intents), hook (simplified hooking), safe (error-safe wrappers), time (timestamps/stopwatch/debounce). " +
        "See `kahlo_mcp_about` for the full module contract and stdlib reference.",
      inputSchema: {
        target_id: zTargetId,
        type: zJobType.optional().default("oneshot"),
        ttl: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Optional time-to-live in seconds. Job will auto-cancel after this duration."
          ),
        module: withJsonStringFallback(zModuleSelector, "module").describe(
          "Specifies job code source: {kind:'module_ref', module_ref:'name@1.0.0'} for stored modules, {kind:'draft_id', draft_id:'...'} for drafts, or {kind:'source', source:'...'} for inline JavaScript."
        ),
        params: withJsonStringFallback(zJsonObject, "params")
          .optional()
          .describe("JSON parameters passed to the job's init/start lifecycle methods."),
      },
      outputSchema: zOutJobsStart,
    },
    async (args) => kahloJobsStart(args)
  );

  server.registerTool(
    "kahlo_jobs_status",
    {
      title: "Get job status",
      description:
        "Returns the current state of a job. Shows: lifecycle state (queued/starting/running/completed/failed/cancelled), `heartbeat` timestamp (ISO 8601), `health` status (healthy/unhealthy/unknown - for daemon jobs based on heartbeat staleness), `metrics` object containing `events_emitted`, `hooks_installed`, and `errors` counts, plus `error` object and `result` if the job failed or completed. Use this to monitor long-running jobs, diagnose failures, or confirm a job completed successfully.",
      inputSchema: {
        job_id: zJobId,
      },
      outputSchema: zOutJobsStatus,
    },
    async (args) => kahloJobsStatus(args)
  );

  server.registerTool(
    "kahlo_jobs_list",
    {
      title: "List jobs for target",
      description:
        "Lists all jobs (past and present) associated with a target process. Returns job IDs, types, current states, creation timestamps, and brief summaries. Use this to: see what instrumentation is currently active, find job IDs for status checks or cancellation, review job history after a target crashes, or audit which jobs produced specific events/artifacts.",
      inputSchema: {
        target_id: zTargetId,
      },
      outputSchema: zOutJobsList,
    },
    async (args) => kahloJobsList(args)
  );

  server.registerTool(
    "kahlo_jobs_cancel",
    {
      title: "Cancel running job",
      description:
        "Immediately cancels a running job by unloading its Frida script. This triggers Frida's automatic cleanup: all Interceptor.attach() hooks, Interceptor.replace() replacements, Java.use().implementation replacements, timers (setTimeout, setInterval), and any other script-local state are removed. Use this to stop a misbehaving job, free resources, or end a daemon job. When iterating on instrumentation code, cancel the old job before starting a new one to get a clean slate. Other jobs on the same target are unaffected.",
      inputSchema: {
        job_id: zJobId,
      },
      outputSchema: zOutJobsCancel,
    },
    async (args) => kahloJobsCancel(args)
  );
}

function registerSnapshotTools(server: McpServer): void {
  server.registerTool(
    "kahlo_snapshots_get",
    {
      title: "Get runtime snapshot",
      description:
        "Captures an on-demand snapshot of the target process's current runtime state. Snapshots are point-in-time queries (unlike streaming events) and can be computationally expensive, so request them sparingly. Available snapshot kinds: 'native.modules' (loaded native libraries), 'process.info' (pid, architecture, runtime basics). Use snapshots to quickly inspect the target environment before deciding what instrumentation jobs to run next.",
      inputSchema: {
        target_id: zTargetId,
        kind: zSnapshotKind,
        options: withJsonStringFallback(zJsonObject, "options")
          .optional()
          .describe("Optional snapshot-specific parameters (reserved for future use)."),
      },
      outputSchema: zOutSnapshotsGet,
    },
    async (args) => kahloSnapshotsGet(args as any)
  );
}

function registerEventTools(server: McpServer): void {
  server.registerTool(
    "kahlo_events_fetch",
    {
      title: "Fetch telemetry events",
      description:
        "Retrieves structured telemetry events emitted by jobs during instrumentation. Events are small, high-volume log messages containing timestamped data about what jobs are doing (function calls intercepted, values observed, execution flow, errors encountered). Events are buffered in-memory on the host and persisted to disk, then retrieved via cursor-based polling for efficiency and backpressure handling. Each event has: event_id, timestamp, target_id, process ID, job_id, kind (custom string), log level (debug/info/warn/error), and a JSON payload. You can fetch all events for a target (to see activity across all jobs) or filter by job_id (to track one specific job). Use 'cursor' to paginate through results efficiently; the response includes a new cursor for the next fetch. Events are distinct from artifacts: events are small structured telemetry, while artifacts are larger files/dumps saved to disk.",
      inputSchema: z.object({
        target_id: zTargetId.optional().describe("Fetch all events for this target (across all jobs)."),
        job_id: zJobId.optional().describe("Fetch events only for this specific job."),
        cursor: zToolCursor.optional().describe("Pagination cursor from the previous fetch (for efficient polling)."),
        limit: z
          .number()
          .int()
          .positive()
          .max(5000)
          .optional()
          .describe("Maximum number of events to return in this batch (default depends on implementation)."),
        filters: withJsonStringFallback(zJsonObject, "filters")
          .optional()
          .describe("Optional filters to narrow results. Supported keys: 'kind' (string, exact match on event kind, e.g., 'log', 'function_call', 'hook.triggered') and 'level' (string, exact match on severity: 'debug'|'info'|'warn'|'error'). Both keys are optional; when both are provided they are combined with AND logic. Example: {kind:'function_call', level:'error'}."),
      }),
      outputSchema: zOutEventsFetch,
    },
    async (args) => kahloEventsFetch(args)
  );
}

function registerArtifactTools(server: McpServer): void {
  server.registerTool(
    "kahlo_artifacts_list",
    {
      title: "List captured artifacts",
      description:
        "Lists artifacts produced by instrumentation jobs. Artifacts are larger files or binary data saved to disk during a job's execution, as opposed to events which are small structured telemetry messages. Artifact types include: 'file_dump' (files extracted from the app's filesystem or intercepted during I/O), 'memory_dump' (raw memory regions dumped from the process), 'trace' (execution traces or call graphs), 'pcap_like' (network traffic captures), and 'custom' (job-defined types). Each artifact has metadata (timestamp, size, MIME type, hash) and a storage reference (file path or object key). Use this to discover what evidence or outputs a job captured, then retrieve specific artifacts with kahlo_artifacts_get. You can list all artifacts for a target (across all jobs) or filter by job_id.",
      inputSchema: z.object({
        target_id: zTargetId.optional(),
        job_id: zJobId.optional(),
      }),
      outputSchema: zOutArtifactsList,
    },
    async (args) => kahloArtifactsList(args)
  );

  server.registerTool(
    "kahlo_artifacts_get",
    {
      title: "Retrieve artifact data",
      description:
        "Retrieves a specific artifact by its unique artifact_id (obtained from kahlo_artifacts_list). Returns the artifact's metadata (type, timestamp, size, MIME type, hash, associated target and job IDs) plus either: (1) a storage reference (file path or URL) for large artifacts that you can download separately, or (2) the inline payload for small artifacts. Artifacts are immutable once created. Use this to access the actual files, dumps, or traces that your instrumentation jobs captured during execution.",
      inputSchema: {
        artifact_id: zArtifactId,
      },
      outputSchema: zOutArtifactsGet,
    },
    async (args) => kahloArtifactsGet(args)
  );
}

function registerModuleTools(server: McpServer): void {
  server.registerTool(
    "kahlo_modules_list",
    {
      title: "List reusable modules",
      description:
        "Lists all versioned instrumentation modules stored in the module store. Modules are reusable, tested units of instrumentation code (e.g., 'tls.unpin@1.2.0' for SSL unpinning, 'http.trace@2.0.1' for HTTP interception). Each module includes: a unique name, semantic version, entrypoint JavaScript file, manifest describing capabilities and parameters, and optional documentation/tests. Modules represent stable, production-ready instrumentation logic that you can reference when starting jobs. Use this to discover what pre-built instrumentation is available, then reference modules via 'name@version' syntax in kahlo_jobs_start.",
      inputSchema: {},
      outputSchema: zOutModulesList,
    },
    () => kahloModulesList()
  );

  server.registerTool(
    "kahlo_modules_get",
    {
      title: "Get module details",
      description:
        "Retrieves detailed information about a specific versioned module from the store. Specify the module using 'name@version' syntax (e.g., 'tls.unpin@1.0.0'). Returns the complete module bundle: source code, manifest (capabilities, parameters schema, event schema), documentation, and provenance metadata (derived from which job/draft, when created). Use this to inspect a module's implementation before using it in a job, or to understand what parameters it expects.",
      inputSchema: {
        module_ref: zModuleRef,
      },
      outputSchema: zOutModulesGet,
    },
    (args) => kahloModulesGet(args)
  );

  server.registerTool(
    "kahlo_modules_createDraft",
    {
      title: "Create draft module",
      description:
        "Creates a draft module for rapid iteration and experimentation. Drafts are temporary, mutable modules stored separately from the main module store. You provide JavaScript source code (Frida instrumentation logic) and optionally a name and manifest. Returns a `draft_id` which you can: (1) use immediately in kahlo_jobs_start to test the code, (2) update iteratively with kahlo_modules_updateDraft as you refine it, (3) promote to a versioned module with kahlo_modules_promoteDraft once stable. Drafts are useful for prototyping instrumentation workflows before committing them to the permanent module store.",
      inputSchema: {
        name: zNonEmptyString
          .optional()
          .describe("Human-friendly name for this draft (helps track multiple drafts)."),
        source: zNonEmptyString.describe("JavaScript source code implementing the instrumentation logic (Frida API)."),
        manifest: withJsonStringFallback(zJsonObject, "manifest")
          .optional()
          .describe("Optional manifest specifying capabilities, parameter schemas, event schemas. Auto-generated if omitted."),
      },
      outputSchema: zOutModulesCreateDraft,
    },
    (args) => kahloModulesCreateDraft(args)
  );

  server.registerTool(
    "kahlo_modules_createDraftFromJob",
    {
      title: "Create draft from job",
      description:
        "Captures a working job's source code and saves it as a draft module. This is the key 'save my work' action - when an inline job works well, use this to preserve the code for iteration and eventual promotion to the module store. The draft records provenance (derived_from_job_id) linking it back to the original job. After saving, you can: (1) iterate on the draft with updateDraft, (2) test changes by starting jobs from the draft, (3) promote to a permanent module when stable.",
      inputSchema: {
        job_id: zJobId.describe("The job whose source code should be saved as a draft."),
        name: zNonEmptyString
          .optional()
          .describe("Human-friendly name for this draft (helps track multiple drafts)."),
      },
      outputSchema: zOutModulesCreateDraft,
    },
    (args) => kahloModulesCreateDraftFromJob(args)
  );

  server.registerTool(
    "kahlo_modules_getDraft",
    {
      title: "Get draft details",
      description:
        "Retrieves a draft module by its draft_id, including the full source code. Use this to inspect a draft's implementation before testing or promoting it.",
      inputSchema: {
        draft_id: zDraftId.describe("Draft identifier returned by createDraft or createDraftFromJob."),
      },
      outputSchema: zOutModulesGetDraft,
    },
    (args) => kahloModulesGetDraft(args)
  );

  server.registerTool(
    "kahlo_modules_listDrafts",
    {
      title: "List drafts",
      description:
        "Lists all draft modules with metadata (without full source for efficiency). Use this to discover available drafts for iteration or cleanup.",
      inputSchema: {},
      outputSchema: zOutModulesListDrafts,
    },
    () => kahloModulesListDrafts()
  );

  server.registerTool(
    "kahlo_modules_updateDraft",
    {
      title: "Update draft module",
      description:
        "Modifies an existing draft module by replacing its source code. Use this during iterative development: create a draft, start a job to test it, observe the results, then update the draft and test again. Updated drafts can immediately be used in new jobs; running jobs using the old draft version are unaffected.",
      inputSchema: {
        draft_id: zDraftId,
        source: zNonEmptyString.describe("Replace entire draft source code with this JavaScript."),
      },
      outputSchema: zOutModulesUpdateDraft,
    },
    (args) => kahloModulesUpdateDraft({ draft_id: args.draft_id, source: args.source })
  );

  server.registerTool(
    "kahlo_modules_promoteFromJob",
    {
      title: "Promote job to versioned module",
      description:
        "Takes the instrumentation code from a successfully-tested job and promotes it into a permanent, versioned module in the module store. This workflow is: (1) start a job with inline source or draft, (2) verify it works by checking events/artifacts, (3) promote that job's code to a reusable module. The promotion process: freezes the job's source code into an immutable snapshot, assigns a semantic version number (patch/minor/major increment), bundles it with manifest/docs, runs smoke tests (optional), then writes it to the module store. Records provenance linking the module back to the originating job. Use this to convert experimental instrumentation into production-ready reusable modules.",
      inputSchema: {
        job_id: zJobId,
        name: zNonEmptyString.describe("Module name to create or update (e.g., 'my.custom.hook')."),
        version_strategy: z
          .enum(["patch", "minor", "major"])
          .describe("How to assign version: 'patch' (0.0.X), 'minor' (0.X.0), 'major' (X.0.0)."),
        notes: zNonEmptyString.optional().describe("Optional release notes documenting what this version does/changes."),
      },
      outputSchema: zOutModulesPromoteFromJob,
    },
    async (args) => kahloModulesPromoteFromJob(args)
  );

  server.registerTool(
    "kahlo_modules_promoteDraft",
    {
      title: "Promote draft to versioned module",
      description:
        "Promotes a tested draft module into a permanent, versioned module in the module store. Similar to kahlo_modules_promoteFromJob but starts from a draft_id instead of job_id. Use this workflow: (1) create a draft with kahlo_modules_createDraft, (2) iterate on it with kahlo_modules_updateDraft, (3) test it in jobs, (4) once stable, promote it here. The promotion freezes the draft source into an immutable snapshot, assigns a semantic version, bundles manifest/schema, optionally runs smoke tests, and writes it to the module store with provenance metadata. After promotion, the draft remains available for further experimentation, but the versioned module is immutable.",
      inputSchema: {
        draft_id: zDraftId,
        name: zNonEmptyString.describe("Target module name (e.g., 'network.intercept')."),
        version_strategy: z
          .enum(["patch", "minor", "major"])
          .describe("Version numbering strategy: patch/minor/major increment."),
        notes: zNonEmptyString.optional().describe("Optional provenance notes or changelog entry for this version."),
      },
      outputSchema: zOutModulesPromoteDraft,
    },
    async (args) => kahloModulesPromoteDraft(args)
  );
}

