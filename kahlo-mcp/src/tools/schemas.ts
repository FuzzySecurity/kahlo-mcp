import { z } from "zod/v4";

/**
 * Shared Zod schemas for kahlo MCP tool inputs.
 *
 * Note: These schemas are designed to be AI-friendly:
 * - explicit enums (no magic strings)
 * - descriptive field docs
 * - stable naming aligned with `design.md`
 */

// ---------------------------------------------------------------------------
// JSON String Fallback Utility
// ---------------------------------------------------------------------------
// Workaround for MCP clients (e.g., Claude Code) that incorrectly serialize
// object parameters as JSON strings instead of parsed objects.
// See: https://github.com/anthropics/claude-code/issues/18260#issuecomment-3798511148
// ---------------------------------------------------------------------------

/**
 * Wraps a Zod schema to accept either the expected type OR a JSON string
 * that parses to the expected type. This is a transparent workaround for
 * MCP clients that incorrectly serialize object parameters as strings.
 *
 * @example
 * // Without fallback (fails when client sends stringified JSON):
 * module: zModuleSelector
 *
 * // With fallback (accepts both object and stringified JSON):
 * module: withJsonStringFallback(zModuleSelector)
 *
 * @param schema - The Zod schema to wrap
 * @param fieldName - Optional field name for debug logging
 * @returns A schema that preprocesses string inputs via JSON.parse
 */
export function withJsonStringFallback<T extends z.ZodTypeAny>(
  schema: T,
  fieldName?: string
) {
  return z.preprocess((val) => {
    if (typeof val === "string") {
      try {
        const parsed = JSON.parse(val);
        // Log when fallback is triggered (helps diagnose client bugs)
        if (process.env.KAHLO_DEBUG_JSON_FALLBACK) {
          console.warn(
            `[kahlo] JSON string fallback triggered${fieldName ? ` for '${fieldName}'` : ""}: ` +
            `received string, parsed to ${typeof parsed}`
          );
        }
        return parsed;
      } catch {
        // Return original value - let Zod validation produce the appropriate error
        return val;
      }
    }
    return val;
  }, schema);
}

export const zNonEmptyString = z
  .string()
  .min(1, "Must be a non-empty string")
  .describe("A non-empty string.");

export const zDeviceId = zNonEmptyString.describe(
  "Unique device identifier (ADB serial, USB id, or harness-assigned id)."
);

export const zTargetId = zNonEmptyString.describe(
  "Target identifier returned by `kahlo_targets_ensure`."
);

export const zJobId = zNonEmptyString.describe("Job identifier returned by `kahlo_jobs_start`.");

export const zArtifactId = zNonEmptyString.describe(
  "Artifact identifier returned by `kahlo_artifacts_list`."
);

export const zDraftId = zNonEmptyString.describe(
  "Draft identifier returned by `kahlo_modules_createDraft`."
);

export const zSnapshotId = zNonEmptyString.describe("Snapshot identifier.");

export const zModuleRef = zNonEmptyString.describe(
  "Module reference string, typically `module_id@version`."
);

export const zPackageName = zNonEmptyString.describe(
  "For mode='attach': process name as shown by `kahlo_processes_list` (e.g., `LINE`, `Chrome`). " +
  "For mode='spawn': Android package identifier (e.g., `com.example.app`). " +
  "These often differ - attach uses display names, spawn uses package IDs."
);

export const zTargetMode = z
  .enum(["spawn", "attach"])
  .describe("How to instrument the target: spawn a new process or attach to an existing one.");

export const zTargetGating = z
  .enum(["none", "spawn", "child"])
  .describe(
    "Gating policy: `none` (default, resume immediately), `spawn` (requires bootstrap for early hooks), `child` (captures child process spawns - NOTE: does NOT work on Android due to zygote forking)."
  );

/**
 * Bootstrap module specification for spawn+gating workflows.
 * Required when gating="spawn" to install early hooks before the app runs.
 */
export const zBootstrapModule = z.discriminatedUnion("kind", [
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
      "Inline JavaScript source code for the bootstrap job (installs early hooks)."
    ),
  }),
]).describe(
  "Bootstrap job code for early instrumentation. Required when gating='spawn'. " +
  "The bootstrap job runs while the app is suspended, then the app resumes with hooks in place."
);

export const zJobType = z
  .enum(["oneshot", "interactive", "daemon"])
  .describe("Job type: one-shot, interactive, or long-running daemon.");

export const zJsonObject = z
  .record(z.string(), z.any())
  .describe("A JSON object (string keys) used for parameters or metadata.");

export const zToolCursor = z
  .string()
  .min(1)
  .describe("Opaque cursor used for polling paginated streams (events).");

/**
 * Common primitive field shapes used by outputs.
 */
export const zIsoDateTime = z
  .string()
  .datetime()
  .describe("An ISO-8601 datetime string (e.g., 2026-01-18T12:34:56.789Z).");

/**
 * kahlo standardized tool result envelopes (success + error).
 *
 * We use these envelopes as `structuredContent` so MCP clients can consume
 * responses without parsing `content[].text`.
 */
export const zKahloErrorCode = z
  .enum(["NOT_IMPLEMENTED", "INVALID_ARGUMENT", "NOT_FOUND", "UNAVAILABLE", "INTERNAL", "TIMEOUT"])
  .describe("Stable machine-readable error code.");

export const zKahloToolError = z
  .object({
    code: zKahloErrorCode,
    message: zNonEmptyString.describe("Human-readable error message."),
    tool: zNonEmptyString.describe("Tool name that produced this error."),
    retryable: z.boolean().optional().describe("Whether a retry may succeed."),
    details: zJsonObject.optional().describe("Optional structured details for debugging/triage."),
    suggestion: zNonEmptyString.optional().describe("Actionable suggestion for the AI/operator on how to resolve."),
  })
  .describe("Standard kahlo tool error envelope.");

/**
 * Create an object-shaped schema for kahlo tool outputs.
 *
 * NOTE: The MCP SDK currently normalizes tool output schemas to an object schema
 * for validation. Using union-only schemas can break output validation. Keeping
 * this envelope as a `z.object(...)` avoids that issue while still providing a
 * stable contract.
 *
 * @param dataSchema - Schema for the tool-specific success payload.
 */
export function zKahloToolResult<T extends z.ZodTypeAny>(dataSchema: T) {
  return z
    .object({
      ok: z.boolean().describe("True on success; false on failure."),
      data: dataSchema.optional().describe("Success payload when ok=true."),
      error: zKahloToolError.optional().describe("Error payload when ok=false."),
    })
    .passthrough()
    .describe("Standard kahlo tool result envelope.");
}

/**
 * Domain models (outputs) aligned with `design.md` §3.
 *
 * These are intentionally slightly permissive (`passthrough`) so we can add
 * new fields without breaking older clients.
 */
export const zDeviceTransport = z.enum(["USB", "TCP"]).describe("Device transport type.");

export const zDeviceSummary = z
  .object({
    device_id: zDeviceId,
    model: zNonEmptyString.describe("Device model name."),
    transport: zDeviceTransport,
  })
  .passthrough()
  .describe("A compact device record suitable for device listing.");

export const zDeviceDetails = z
  .object({
    device_id: zDeviceId,
    model: zNonEmptyString.describe("Device model name."),
    android_version: zNonEmptyString.describe("Android version string (e.g., '14').").optional(),
    transport: zDeviceTransport,
    availability: z
      .enum(["available", "busy", "offline"])
      .describe("High-level availability indicator.")
      .optional(),
    frida_server_present: z.boolean().optional(),
    frida_server_running: z.boolean().optional(),
  })
  .passthrough()
  .describe("A detailed device record.");

export const zHealthStatus = z.enum(["healthy", "degraded", "unavailable"]).describe("Health status.");

export const zDeviceHealth = z
  .object({
    device_id: zDeviceId,
    status: zHealthStatus,
    details: zJsonObject.optional().describe("Structured health diagnostics."),
  })
  .passthrough()
  .describe("Device health report.");

export const zTargetState = z.enum(["pending", "running", "dead", "detached"]).describe(
  "Target lifecycle state: pending (creating), running (active), dead (crashed), detached (cleanly detached)."
);

export const zAgentState = z
  .enum(["not_injected", "ready", "crashed", "reinjecting"])
  .describe("In-process orchestrator agent state.");

export const zTarget = z
  .object({
    target_id: zTargetId,
    device_id: zDeviceId,
    package: zPackageName,
    pid: z.number().int().positive().optional().describe("Process ID (present for attach/spawn once running)."),
    mode: zTargetMode,
    gating: zTargetGating,
    state: zTargetState,
    agent_state: zAgentState,
    parent_target_id: zTargetId.optional().describe("For child targets: the parent target that captured this child spawn."),
    agent_error: z
      .object({
        message: zNonEmptyString.describe("Error message from orchestrator injection failure."),
        hint: zNonEmptyString.describe("Actionable hint for resolving the injection failure."),
      })
      .optional()
      .describe("Diagnostic details when orchestrator injection fails (agent_state='crashed')."),
    last_detach: z
      .object({
        reason: zNonEmptyString.describe("Frida session detach reason string."),
        crash: z
          .object({
            summary: z.string().describe("Crash summary from Frida."),
            report: z.string().describe("Full crash report from Frida."),
          })
          .nullable()
          .describe("Crash details if the detach was caused by a process crash."),
      })
      .optional()
      .describe("Diagnostic details from the last unexpected session detach (state='dead')."),
    resume_error: z
      .object({
        message: zNonEmptyString.describe("Error message from process resume failure."),
      })
      .optional()
      .describe("Diagnostic details when process resume fails after spawn (gating='none')."),
  })
  .passthrough()
  .describe("Target model (design.md §3.1).");

export const zJobState = z
  .enum(["queued", "starting", "running", "completed", "failed", "cancelled"])
  .describe("Job lifecycle state.");

export const zJobMetrics = z
  .object({
    events_emitted: z.number().int().nonnegative().optional(),
    hooks_installed: z.number().int().nonnegative().optional(),
    errors: z.number().int().nonnegative().optional(),
  })
  .passthrough()
  .describe("Job performance counters.");

export const zJobHealth = z
  .enum(["healthy", "unhealthy", "unknown"])
  .describe("Job health status. For daemon jobs: healthy if heartbeat within threshold, unhealthy if stale. Unknown for non-daemon jobs.");

export const zJob = z
  .object({
    job_id: zJobId,
    target_id: zTargetId,
    type: zJobType,
    state: zJobState,
    heartbeat: zIsoDateTime.optional().describe("Last heartbeat timestamp."),
    health: zJobHealth.optional().describe("Job health status based on heartbeat."),
    metrics: zJobMetrics.optional(),
    result: zJsonObject.optional().describe("Oneshot completion payload (if any)."),
    error: zJsonObject.optional().describe("Detailed job error payload (if failed)."),
  })
  .passthrough()
  .describe("Job model (design.md §3.2).");

export const zEventLevel = z.enum(["debug", "info", "warn", "error"]).describe("Event log level.");

export const zEvent = z
  .object({
    event_id: zNonEmptyString.describe("Unique event identifier."),
    ts: zIsoDateTime.describe("Event timestamp."),
    target_id: zTargetId,
    pid: z.number().int().positive().optional(),
    job_id: zJobId,
    kind: zNonEmptyString.describe("Event kind string (tool/module-defined)."),
    level: zEventLevel,
    correlation_id: zNonEmptyString.optional(),
    payload: zJsonObject.describe("Size-bounded JSON payload."),
    dropped: z
      .object({
        count: z.number().int().positive(),
      })
      .optional()
      .describe("Optional marker indicating events were dropped due to overflow."),
  })
  .passthrough()
  .describe("Event envelope (design.md §3.4).");

export const zArtifactType = z
  .enum(["file_dump", "memory_dump", "trace", "pcap_like", "custom"])
  .describe("Artifact type.");

export const zArtifact = z
  .object({
    artifact_id: zArtifactId,
    target_id: zTargetId,
    job_id: zJobId,
    ts: zIsoDateTime,
    type: zArtifactType,
    size_bytes: z.number().int().nonnegative().describe("Raw payload size in bytes."),
    stored_size_bytes: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Bytes stored on disk (typically equals size_bytes; present after persistence)."),
    sha256: zNonEmptyString.optional().describe("SHA-256 hex digest of the raw payload."),
    mime: zNonEmptyString.optional().describe("MIME type (default: application/octet-stream)."),
    name: zNonEmptyString.optional().describe("Optional filename hint (e.g., mem_0x1234_0x1000.bin)."),
    metadata: zJsonObject.optional().describe("Additional job-defined metadata."),
    storage_ref: zNonEmptyString.optional().describe("Path/key to stored artifact payload."),
  })
  .passthrough()
  .describe("Artifact record (design.md §3.5).");

export const zModuleSummary = z
  .object({
    name: zNonEmptyString.describe("Module name."),
    version: zNonEmptyString.describe("SemVer version string."),
    module_ref: zModuleRef,
  })
  .passthrough()
  .describe("Versioned module summary.");

/**
 * Tool output schemas (public contract).
 */
export const zOutMcpAbout = zKahloToolResult(
  z
    .object({
      schema_version: z.number().int().positive(),
      toolkit: z
        .object({
          name: zNonEmptyString,
          version: zNonEmptyString,
          transport: zNonEmptyString,
          log_level: zNonEmptyString,
          data_dir: zNonEmptyString,
          storage_layout_hint: z
            .object({
              runs: zNonEmptyString,
              modules: zNonEmptyString,
              drafts: zNonEmptyString,
              snapshots: zNonEmptyString,
            })
            .passthrough(),
        })
        .passthrough(),
    })
    .passthrough()
);

export const zOutDevicesList = zKahloToolResult(
  z.object({
    devices: z.array(zDeviceSummary),
  })
);

export const zOutDevicesGet = zKahloToolResult(
  z.object({
    device: zDeviceDetails,
  })
);

export const zOutDevicesHealth = zKahloToolResult(
  z.object({
    health: zDeviceHealth,
  })
);

export const zOutAdbCommand = zKahloToolResult(
  z.object({
    stdout: z.string().describe("Command stdout output."),
    command: z.string().describe("The command that was executed."),
    device_id: z.string().optional().describe("Device serial if specified."),
  })
);

export const zProcessScope = z
  .enum(["minimal", "metadata", "full"])
  .describe("Process enumeration scope (minimal/metadata/full).");

export const zProcessEntry = z
  .object({
    pid: z.number().int().positive().describe("Process ID."),
    name: zNonEmptyString.describe("Process name."),
    parameters: zJsonObject.optional().describe("Optional process parameters (scope-dependent)."),
  })
  .passthrough()
  .describe("Process entry from frida-node enumeration.");

export const zOutProcessesList = zKahloToolResult(
  z.object({
    processes: z.array(zProcessEntry),
  })
);

export const zOutTargetsEnsure = zKahloToolResult(
  z.object({
    target_id: zTargetId,
  })
);

export const zOutTargetsStatus = zKahloToolResult(
  z.object({
    target: zTarget,
  })
);

export const zOutTargetsDetach = zKahloToolResult(
  z.object({
    target_id: zTargetId,
    state: z.literal("detached"),
  })
);


export const zOutJobsStart = zKahloToolResult(
  z.object({
    job_id: zJobId,
  })
);

export const zOutJobsStatus = zKahloToolResult(
  z.object({
    job: zJob,
  })
);

export const zOutJobsList = zKahloToolResult(
  z.object({
    jobs: z.array(zJob),
  })
);

export const zOutJobsCancel = zKahloToolResult(
  z.object({
    job_id: zJobId,
    state: z.literal("cancelled"),
  })
);

export const zSnapshotKind = z
  .enum(["native.modules", "process.info"])
  .describe("Snapshot kind.");

export const zOutSnapshotsGet = zKahloToolResult(
  z.object({
    target_id: zTargetId,
    kind: zSnapshotKind,
    snapshot: zJsonObject.describe("Snapshot payload (shape depends on kind)."),
  })
);

export const zOutEventsFetch = zKahloToolResult(
  z.object({
    events: z.array(zEvent),
    cursor: zToolCursor.optional().describe("Cursor used for this fetch (if provided)."),
    next_cursor: zToolCursor.optional().describe("Cursor for the next fetch (if more events remain)."),
  })
);

export const zOutArtifactsList = zKahloToolResult(
  z.object({
    artifacts: z.array(zArtifact),
  })
);

export const zOutArtifactsGet = zKahloToolResult(
  z.object({
    artifact: zArtifact,
    storage_ref: zNonEmptyString.optional().describe("Path/key/URL to stored artifact (default response)."),
    encoding: z
      .literal("base64")
      .optional()
      .describe("Encoding of inline payload (only present for small artifacts)."),
    payload_b64: z
      .string()
      .optional()
      .describe("Base64-encoded payload (only for small artifacts, guarded by hard max)."),
  })
);

export const zOutModulesList = zKahloToolResult(
  z.object({
    modules: z.array(zModuleSummary),
  })
);

export const zOutModulesGet = zKahloToolResult(
  z.object({
    module: zJsonObject.describe("Module bundle details (manifest + files + provenance)."),
  })
);

export const zOutModulesCreateDraft = zKahloToolResult(
  z.object({
    draft_id: zDraftId,
    draft: z.object({
      draft_id: zDraftId,
      name: zNonEmptyString.optional(),
      manifest: zJsonObject.optional(),
      created_at: zNonEmptyString,
      updated_at: zNonEmptyString,
      derived_from_job_id: zJobId.optional(),
    }).optional(),
  })
);

export const zOutModulesUpdateDraft = zKahloToolResult(
  z.object({
    draft_id: zDraftId,
    draft: z.object({
      draft_id: zDraftId,
      name: zNonEmptyString.optional(),
      manifest: zJsonObject.optional(),
      created_at: zNonEmptyString,
      updated_at: zNonEmptyString,
      derived_from_job_id: zJobId.optional(),
    }).optional(),
  })
);

export const zOutModulesGetDraft = zKahloToolResult(
  z.object({
    draft: z.object({
      draft_id: zDraftId,
      name: zNonEmptyString.optional(),
      source: zNonEmptyString.describe("Full draft source code."),
      manifest: zJsonObject.optional(),
      created_at: zNonEmptyString,
      updated_at: zNonEmptyString,
      derived_from_job_id: zJobId.optional(),
    }),
  })
);

export const zOutModulesListDrafts = zKahloToolResult(
  z.object({
    drafts: z.array(
      z.object({
        draft_id: zDraftId,
        name: zNonEmptyString.optional(),
        manifest: zJsonObject.optional(),
        created_at: zNonEmptyString,
        updated_at: zNonEmptyString,
        derived_from_job_id: zJobId.optional(),
        source_length: z.number().int().nonnegative().describe("Length of draft source in characters (source omitted for efficiency)."),
      })
    ),
  })
);

export const zOutModulesPromoteFromJob = zKahloToolResult(
  z.object({
    module_ref: zModuleRef,
  })
);

export const zOutModulesPromoteDraft = zKahloToolResult(
  z.object({
    module_ref: zModuleRef,
  })
);

