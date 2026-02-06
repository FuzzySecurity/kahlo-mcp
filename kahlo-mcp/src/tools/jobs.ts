import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  cancelAllJobsForTarget,
  cancelJob,
  JobControllerError,
  jobStatus,
  listJobs,
  startJob,
  type JobType,
  type ModuleProvenance,
} from "../backend/jobs/jobController.js";
import { getDraft, DraftManagerError } from "../backend/drafts/draftManager.js";
import { getModule, ModuleStoreError } from "../backend/modules/moduleStore.js";
import { toolErr, toolOk, mapBackendErrorCode } from "./result.js";

function toJobType(v: unknown): JobType {
  return v === "daemon" || v === "interactive" ? v : "oneshot";
}


/**
 * Resolve module source and provenance from the module selector.
 * Supports inline source, draft_id, and module_ref.
 */
function resolveModuleSource(
  module:
    | { kind: "module_ref"; module_ref: string }
    | { kind: "draft_id"; draft_id: string }
    | { kind: "source"; source: string }
): { ok: true; source: string; provenance: ModuleProvenance } | { ok: false; error: CallToolResult } {
  const tool = "kahlo_jobs_start";

  if (!module) {
    return {
      ok: false,
      error: toolErr({
        code: "INVALID_ARGUMENT",
        tool,
        message: "module is required",
        retryable: false,
      }),
    };
  }

  switch (module.kind) {
    case "source":
      return { ok: true, source: module.source, provenance: { kind: "source" } };

    case "draft_id":
      try {
        const draft = getDraft(module.draft_id);
        return { ok: true, source: draft.source, provenance: { kind: "draft_id", draft_id: module.draft_id } };
      } catch (err) {
        if (err instanceof DraftManagerError) {
          return {
            ok: false,
            error: toolErr({
              code: mapBackendErrorCode(err.code),
              tool,
              message: `Failed to load draft: ${err.message}`,
              retryable: false,
              details: { draft_id: module.draft_id },
              suggestion: "Check if the draft_id exists using kahlo_modules_listDrafts",
            }),
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: toolErr({ code: "INTERNAL", tool, message: msg, retryable: false }),
        };
      }

    case "module_ref":
      try {
        const { source } = getModule(module.module_ref);
        return { ok: true, source, provenance: { kind: "module_ref", module_ref: module.module_ref } };
      } catch (err) {
        if (err instanceof ModuleStoreError) {
          return {
            ok: false,
            error: toolErr({
              code: mapBackendErrorCode(err.code),
              tool,
              message: `Failed to load module: ${err.message}`,
              retryable: false,
              details: { module_ref: module.module_ref },
              suggestion: "Check available modules using kahlo_modules_list",
            }),
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: toolErr({ code: "INTERNAL", tool, message: msg, retryable: false }),
        };
      }

    default:
      return {
        ok: false,
        error: toolErr({
          code: "INVALID_ARGUMENT",
          tool,
          message: `Unknown module.kind: ${(module as any).kind}`,
          retryable: false,
          suggestion: "Use module.kind: 'source', 'draft_id', or 'module_ref'",
        }),
      };
  }
}

export async function kahloJobsStart(args: {
  target_id: string;
  type?: JobType;
  ttl?: number;
  module:
    | { kind: "module_ref"; module_ref: string }
    | { kind: "draft_id"; draft_id: string }
    | { kind: "source"; source: string };
  params?: Record<string, unknown>;
}): Promise<CallToolResult> {
  const tool = "kahlo_jobs_start";

  try {
    // Resolve module source from inline, draft, or (future) module store
    const resolved = resolveModuleSource(args.module);
    if (!resolved.ok) {
      return resolved.error;
    }

    const job_id = await startJob({
      target_id: args.target_id,
      type: toJobType(args.type),
      module_source: resolved.source,
      module_provenance: resolved.provenance,
      params: args.params,
      ttl: args.ttl,
    });

    return toolOk({ job_id });
  } catch (err) {
    if (err instanceof JobControllerError) {
      let suggestion: string | undefined;
      if (err.code === "NOT_FOUND") {
        suggestion = "Verify target_id is valid using kahlo_targets_status";
      } else if (err.code === "UNAVAILABLE") {
        suggestion = "The target may have crashed. Check kahlo_targets_status and re-attach if needed";
      }
      return toolErr({
        code: err.code,
        tool,
        message: err.message,
        retryable: err.code === "UNAVAILABLE",
        details: err.details,
        suggestion,
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return toolErr({ code: "INTERNAL", tool, message: msg, retryable: false });
  }
}

export async function kahloJobsStatus(args: { job_id: string }): Promise<CallToolResult> {
  const tool = "kahlo_jobs_status";
  try {
    const job = await jobStatus({ job_id: args.job_id });
    return toolOk({ job });
  } catch (err) {
    if (err instanceof JobControllerError) {
      let suggestion: string | undefined;
      switch (err.code) {
        case "NOT_FOUND":
          suggestion = "Verify the job_id. Use kahlo_jobs_list to see active jobs.";
          break;
        case "INVALID_ARGUMENT":
          suggestion = "Check the job_id parameter and try again.";
          break;
        case "UNAVAILABLE":
          suggestion = "The target may have crashed. Check kahlo_targets_status and re-attach if needed.";
          break;
      }
      return toolErr({
        code: err.code,
        tool,
        message: err.message,
        retryable: err.code === "UNAVAILABLE",
        details: err.details,
        suggestion,
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return toolErr({ code: "INTERNAL", tool, message: msg, retryable: false });
  }
}

export async function kahloJobsList(args: { target_id: string }): Promise<CallToolResult> {
  const tool = "kahlo_jobs_list";
  try {
    const jobs = await listJobs({ target_id: args.target_id });
    return toolOk({ jobs });
  } catch (err) {
    if (err instanceof JobControllerError) {
      let suggestion: string | undefined;
      switch (err.code) {
        case "NOT_FOUND":
          suggestion = "Verify the target_id. Use kahlo_targets_status to confirm the target is active.";
          break;
        case "INVALID_ARGUMENT":
          suggestion = "Check the target_id parameter and try again.";
          break;
        case "UNAVAILABLE":
          suggestion = "The target may have crashed. Check kahlo_targets_status and re-attach if needed.";
          break;
      }
      return toolErr({
        code: err.code,
        tool,
        message: err.message,
        retryable: err.code === "UNAVAILABLE",
        details: err.details,
        suggestion,
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return toolErr({ code: "INTERNAL", tool, message: msg, retryable: false });
  }
}

export async function kahloJobsCancel(args: { job_id: string }): Promise<CallToolResult> {
  const tool = "kahlo_jobs_cancel";
  try {
    await cancelJob({ job_id: args.job_id });
    return toolOk({ job_id: args.job_id, state: "cancelled" as const });
  } catch (err) {
    if (err instanceof JobControllerError) {
      let suggestion: string | undefined;
      switch (err.code) {
        case "NOT_FOUND":
          suggestion = "Verify the job_id. Use kahlo_jobs_list to see active jobs.";
          break;
        case "INVALID_ARGUMENT":
          suggestion = "Check the job_id parameter and try again.";
          break;
        case "UNAVAILABLE":
          suggestion = "The target may have crashed. Check kahlo_targets_status and re-attach if needed.";
          break;
      }
      return toolErr({
        code: err.code,
        tool,
        message: err.message,
        retryable: err.code === "UNAVAILABLE",
        details: err.details,
        suggestion,
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return toolErr({ code: "INTERNAL", tool, message: msg, retryable: false });
  }
}

export async function kahloJobsCancelAllForTarget(args: { target_id: string }): Promise<void> {
  await cancelAllJobsForTarget({ target_id: args.target_id });
}

