import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  getArtifact,
  listArtifactsByTarget,
  listArtifactsByJob,
  readArtifactPayload,
  INLINE_MAX_BYTES,
  type ArtifactRecord,
} from "../backend/events/eventPipeline.js";
import { toolErr, toolOk } from "./result.js";

/**
 * Convert an ArtifactRecord to the schema-compliant artifact object.
 */
function toArtifactOutput(record: ArtifactRecord): Record<string, unknown> {
  return {
    artifact_id: record.artifact_id,
    target_id: record.target_id,
    job_id: record.job_id,
    ts: record.ts,
    type: record.type,
    size_bytes: record.size_bytes,
    stored_size_bytes: record.stored_size_bytes,
    sha256: record.sha256,
    mime: record.mime,
    name: record.name,
    metadata: record.metadata,
    storage_ref: record.storage_ref,
  };
}

/**
 * `kahlo_artifacts_list` - list artifacts by target or job.
 *
 * Notes:
 * - At least one of {target_id, job_id} should be provided.
 * - If neither is provided, returns an empty list (defensive).
 */
export async function kahloArtifactsList(args: {
  target_id?: string;
  job_id?: string;
}): Promise<CallToolResult> {
  const tool = "kahlo_artifacts_list";

  try {
    let records: ArtifactRecord[] = [];

    if (args.target_id) {
      records = listArtifactsByTarget(args.target_id);
    } else if (args.job_id) {
      records = listArtifactsByJob(args.job_id);
    } else {
      // Neither provided - return empty list with guidance
      return toolErr({
        code: "INVALID_ARGUMENT",
        tool,
        message: "Provide at least one of { target_id, job_id } to list artifacts.",
        retryable: false,
        details: {
          target_id: args.target_id ?? null,
          job_id: args.job_id ?? null,
        },
        suggestion: "Provide at least one of target_id or job_id",
      });
    }

    const artifacts = records.map(toArtifactOutput);

    return toolOk({ artifacts });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return toolErr({
      code: "INTERNAL",
      tool,
      message: msg,
      retryable: false,
      suggestion: "An unexpected error occurred. Verify target and job status",
    });
  }
}

/**
 * `kahlo_artifacts_get` - retrieve artifact metadata and optionally inline payload.
 *
 * Notes:
 * - Returns artifact metadata and storage_ref by default.
 * - For small artifacts (≤ INLINE_MAX_BYTES), also returns base64-encoded payload.
 */
export async function kahloArtifactsGet(args: {
  artifact_id: string;
}): Promise<CallToolResult> {
  const tool = "kahlo_artifacts_get";

  if (!args.artifact_id || args.artifact_id.trim().length === 0) {
    return toolErr({
      code: "INVALID_ARGUMENT",
      tool,
      message: "artifact_id is required.",
      retryable: false,
      suggestion: "Provide a valid artifact_id from kahlo_artifacts_list",
    });
  }

  try {
    const record = getArtifact(args.artifact_id);

    if (!record) {
      return toolErr({
        code: "NOT_FOUND",
        tool,
        message: `Artifact not found: ${args.artifact_id}`,
        retryable: false,
        details: { artifact_id: args.artifact_id },
        suggestion: "Verify artifact_id using kahlo_artifacts_list",
      });
    }

    const artifact = toArtifactOutput(record);
    const result: Record<string, unknown> = {
      artifact,
      storage_ref: record.storage_ref,
    };

    // Inline small payloads as base64
    if (record.size_bytes <= INLINE_MAX_BYTES) {
      const payload = await readArtifactPayload(args.artifact_id);
      if (payload) {
        result.encoding = "base64";
        result.payload_b64 = payload.toString("base64");
      }
    }

    return toolOk(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return toolErr({
      code: "INTERNAL",
      tool,
      message: msg,
      retryable: false,
      suggestion: "An unexpected error occurred. Verify artifact_id using kahlo_artifacts_list",
    });
  }
}
