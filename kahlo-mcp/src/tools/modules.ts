/**
 * Module and draft tools implementation.
 *
 * @module tools/modules
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  createDraft,
  getDraft,
  updateDraft,
  listDrafts,
  DraftManagerError,
} from "../backend/drafts/draftManager.js";
import { getJobSource, JobControllerError } from "../backend/jobs/jobController.js";
import {
  promoteToModule,
  listModules,
  getModule,
  ModuleStoreError,
  type VersionStrategy,
} from "../backend/modules/moduleStore.js";
import { toolOk, toolErr, mapBackendErrorCode } from "./result.js";


/**
 * Generate a suggestion message for DraftManagerError based on error code.
 *
 * @param code - The error code from DraftManagerError
 * @returns A suggestion string to help the user recover from the error
 */
function getDraftErrorSuggestion(code: DraftManagerError["code"]): string {
  switch (code) {
    case "NOT_FOUND":
      return "Verify draft_id using kahlo_modules_listDrafts";
    case "VALIDATION_ERROR":
      return "Check that all required fields are provided and valid";
    case "ALREADY_EXISTS":
      return "A draft with this identifier already exists. Use a different name or update the existing draft";
    case "INTERNAL":
    default:
      return "An internal error occurred. Retry the operation or check server logs";
  }
}

/**
 * Generate a suggestion message for ModuleStoreError based on error code.
 *
 * @param code - The error code from ModuleStoreError
 * @returns A suggestion string to help the user recover from the error
 */
function getModuleStoreErrorSuggestion(code: ModuleStoreError["code"]): string {
  switch (code) {
    case "NOT_FOUND":
      return "Verify module_ref format (name@version) using kahlo_modules_list";
    case "VALIDATION_ERROR":
      return "Check that all required fields are provided and valid";
    case "ALREADY_EXISTS":
      return "Module version already exists. Use a different version_strategy";
    case "INTERNAL":
    default:
      return "An internal error occurred. Retry the operation or check server logs";
  }
}

/**
 * Create a new draft from raw source code.
 */
export async function kahloModulesCreateDraft(args: {
  name?: string;
  source: string;
  manifest?: Record<string, unknown>;
}): Promise<CallToolResult> {
  const tool = "kahlo_modules_createDraft";

  try {
    const draft = await createDraft({
      name: args.name,
      source: args.source,
      manifest: args.manifest,
    });

    return toolOk({
      draft_id: draft.draft_id,
      draft: {
        draft_id: draft.draft_id,
        name: draft.name,
        manifest: draft.manifest,
        created_at: draft.created_at,
        updated_at: draft.updated_at,
      },
    });
  } catch (err) {
    if (err instanceof DraftManagerError) {
      return toolErr({
        code: mapBackendErrorCode(err.code),
        tool,
        message: err.message,
        retryable: false,
        details: err.details,
        suggestion: getDraftErrorSuggestion(err.code),
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return toolErr({
      code: "INTERNAL",
      tool,
      message: msg,
      retryable: false,
      suggestion: "An internal error occurred. Retry the operation or check server logs",
    });
  }
}

/**
 * Create a new draft from an existing job's source code.
 * This is the key "save my work" action for agents.
 */
export async function kahloModulesCreateDraftFromJob(args: {
  job_id: string;
  name?: string;
}): Promise<CallToolResult> {
  const tool = "kahlo_modules_createDraftFromJob";

  try {
    // Get the job's source code
    const source = getJobSource(args.job_id);

    // Create the draft with provenance
    const draft = await createDraft({
      name: args.name,
      source,
      derived_from_job_id: args.job_id,
    });

    return toolOk({
      draft_id: draft.draft_id,
      draft: {
        draft_id: draft.draft_id,
        name: draft.name,
        created_at: draft.created_at,
        updated_at: draft.updated_at,
        derived_from_job_id: draft.derived_from_job_id,
      },
    });
  } catch (err) {
    if (err instanceof JobControllerError) {
      return toolErr({
        code: err.code,
        tool,
        message: err.message,
        retryable: false,
        details: err.details,
        suggestion: "Verify job_id using kahlo_jobs_list",
      });
    }
    if (err instanceof DraftManagerError) {
      return toolErr({
        code: mapBackendErrorCode(err.code),
        tool,
        message: err.message,
        retryable: false,
        details: err.details,
        suggestion: getDraftErrorSuggestion(err.code),
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return toolErr({
      code: "INTERNAL",
      tool,
      message: msg,
      retryable: false,
      suggestion: "An internal error occurred. Retry the operation or check server logs",
    });
  }
}

/**
 * Update a draft's source code.
 */
export async function kahloModulesUpdateDraft(args: {
  draft_id: string;
  source: string;
}): Promise<CallToolResult> {
  const tool = "kahlo_modules_updateDraft";

  try {
    const draft = await updateDraft({
      draft_id: args.draft_id,
      source: args.source,
    });

    return toolOk({
      draft_id: draft.draft_id,
      draft: {
        draft_id: draft.draft_id,
        name: draft.name,
        manifest: draft.manifest,
        created_at: draft.created_at,
        updated_at: draft.updated_at,
        derived_from_job_id: draft.derived_from_job_id,
      },
    });
  } catch (err) {
    if (err instanceof DraftManagerError) {
      return toolErr({
        code: mapBackendErrorCode(err.code),
        tool,
        message: err.message,
        retryable: false,
        details: err.details,
        suggestion: getDraftErrorSuggestion(err.code),
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return toolErr({
      code: "INTERNAL",
      tool,
      message: msg,
      retryable: false,
      suggestion: "An internal error occurred. Retry the operation or check server logs",
    });
  }
}

/**
 * Get a draft by ID (includes full source).
 */
export function kahloModulesGetDraft(args: { draft_id: string }): CallToolResult {
  const tool = "kahlo_modules_getDraft";

  try {
    const draft = getDraft(args.draft_id);

    return toolOk({
      draft: {
        draft_id: draft.draft_id,
        name: draft.name,
        source: draft.source,
        manifest: draft.manifest,
        created_at: draft.created_at,
        updated_at: draft.updated_at,
        derived_from_job_id: draft.derived_from_job_id,
      },
    });
  } catch (err) {
    if (err instanceof DraftManagerError) {
      return toolErr({
        code: mapBackendErrorCode(err.code),
        tool,
        message: err.message,
        retryable: false,
        details: err.details,
        suggestion: getDraftErrorSuggestion(err.code),
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return toolErr({
      code: "INTERNAL",
      tool,
      message: msg,
      retryable: false,
      suggestion: "An internal error occurred. Retry the operation or check server logs",
    });
  }
}

/**
 * List all drafts (without full source for efficiency).
 */
export function kahloModulesListDrafts(): CallToolResult {
  const tool = "kahlo_modules_listDrafts";

  try {
    const drafts = listDrafts();

    return toolOk({
      drafts: drafts.map((d) => ({
        draft_id: d.draft_id,
        name: d.name,
        manifest: d.manifest,
        created_at: d.created_at,
        updated_at: d.updated_at,
        derived_from_job_id: d.derived_from_job_id,
        source_length: d.source_length,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return toolErr({
      code: "INTERNAL",
      tool,
      message: msg,
      retryable: false,
      suggestion: "An internal error occurred. Retry the operation or check server logs",
    });
  }
}

/**
 * Promote a draft to a permanent versioned module.
 */
export async function kahloModulesPromoteDraft(args: {
  draft_id: string;
  name: string;
  version_strategy: string;
  notes?: string;
}): Promise<CallToolResult> {
  const tool = "kahlo_modules_promoteDraft";

  try {
    // Get the draft
    const draft = getDraft(args.draft_id);

    // Validate version strategy
    const validStrategies = ["patch", "minor", "major"];
    if (!validStrategies.includes(args.version_strategy)) {
      return toolErr({
        code: "INVALID_ARGUMENT",
        tool,
        message: `Invalid version_strategy: ${args.version_strategy}. Must be one of: ${validStrategies.join(", ")}`,
        retryable: false,
        suggestion: "Valid strategies: 'patch', 'minor', or 'major'",
      });
    }

    // Promote to module store
    const result = await promoteToModule({
      source: draft.source,
      name: args.name,
      version_strategy: args.version_strategy as VersionStrategy,
      notes: args.notes,
      derived_from_draft_id: args.draft_id,
      derived_from_job_id: draft.derived_from_job_id,
    });

    return toolOk({
      module_ref: result.module_ref,
    });
  } catch (err) {
    if (err instanceof DraftManagerError) {
      return toolErr({
        code: mapBackendErrorCode(err.code),
        tool,
        message: err.message,
        retryable: false,
        details: err.details,
        suggestion: getDraftErrorSuggestion(err.code),
      });
    }
    if (err instanceof ModuleStoreError) {
      return toolErr({
        code: mapBackendErrorCode(err.code),
        tool,
        message: err.message,
        retryable: false,
        details: err.details,
        suggestion: getModuleStoreErrorSuggestion(err.code),
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return toolErr({
      code: "INTERNAL",
      tool,
      message: msg,
      retryable: false,
      suggestion: "An internal error occurred. Retry the operation or check server logs",
    });
  }
}

/**
 * Promote a job directly to a permanent versioned module (skip draft).
 */
export async function kahloModulesPromoteFromJob(args: {
  job_id: string;
  name: string;
  version_strategy: string;
  notes?: string;
}): Promise<CallToolResult> {
  const tool = "kahlo_modules_promoteFromJob";

  try {
    // Get the job's source code
    const source = getJobSource(args.job_id);

    // Validate version strategy
    const validStrategies = ["patch", "minor", "major"];
    if (!validStrategies.includes(args.version_strategy)) {
      return toolErr({
        code: "INVALID_ARGUMENT",
        tool,
        message: `Invalid version_strategy: ${args.version_strategy}. Must be one of: ${validStrategies.join(", ")}`,
        retryable: false,
        suggestion: "Valid strategies: 'patch', 'minor', or 'major'",
      });
    }

    // Promote to module store
    const result = await promoteToModule({
      source,
      name: args.name,
      version_strategy: args.version_strategy as VersionStrategy,
      notes: args.notes,
      derived_from_job_id: args.job_id,
    });

    return toolOk({
      module_ref: result.module_ref,
    });
  } catch (err) {
    if (err instanceof JobControllerError) {
      return toolErr({
        code: err.code,
        tool,
        message: err.message,
        retryable: false,
        details: err.details,
        suggestion: "Verify job_id using kahlo_jobs_list",
      });
    }
    if (err instanceof ModuleStoreError) {
      return toolErr({
        code: mapBackendErrorCode(err.code),
        tool,
        message: err.message,
        retryable: false,
        details: err.details,
        suggestion: getModuleStoreErrorSuggestion(err.code),
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return toolErr({
      code: "INTERNAL",
      tool,
      message: msg,
      retryable: false,
      suggestion: "An internal error occurred. Retry the operation or check server logs",
    });
  }
}

/**
 * List all modules in the permanent store.
 * Returns a flattened list where each version is a separate entry.
 */
export function kahloModulesList(): CallToolResult {
  const tool = "kahlo_modules_list";

  try {
    const moduleEntries = listModules();

    // Flatten: each version becomes a separate entry
    const modules: Array<{ name: string; version: string; module_ref: string }> = [];
    for (const entry of moduleEntries) {
      for (const version of entry.versions) {
        modules.push({
          name: entry.name,
          version,
          module_ref: `${entry.name}@${version}`,
        });
      }
    }

    return toolOk({ modules });
  } catch (err) {
    if (err instanceof ModuleStoreError) {
      return toolErr({
        code: mapBackendErrorCode(err.code),
        tool,
        message: err.message,
        retryable: false,
        details: err.details,
        suggestion: getModuleStoreErrorSuggestion(err.code),
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return toolErr({
      code: "INTERNAL",
      tool,
      message: msg,
      retryable: false,
      suggestion: "An internal error occurred. Retry the operation or check server logs",
    });
  }
}

/**
 * Get a specific module by module_ref (name@version).
 */
export function kahloModulesGet(args: { module_ref: string }): CallToolResult {
  const tool = "kahlo_modules_get";

  try {
    const { manifest, source } = getModule(args.module_ref);

    return toolOk({
      module: {
        module_ref: args.module_ref,
        name: manifest.name,
        version: manifest.version,
        source,
        created_at: manifest.created_at,
        notes: manifest.notes,
        provenance: manifest.provenance,
      },
    });
  } catch (err) {
    if (err instanceof ModuleStoreError) {
      return toolErr({
        code: mapBackendErrorCode(err.code),
        tool,
        message: err.message,
        retryable: false,
        details: err.details,
        suggestion: getModuleStoreErrorSuggestion(err.code),
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return toolErr({
      code: "INTERNAL",
      tool,
      message: msg,
      retryable: false,
      suggestion: "An internal error occurred. Retry the operation or check server logs",
    });
  }
}
