import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { fetchEvents, type KahloEvent } from "../backend/events/eventPipeline.js";
import { toolErr, toolOk } from "./result.js";

/**
 * `kahlo_events_fetch` - cursor-based retrieval of buffered telemetry.
 *
 * Notes:
 * - Exactly one of {target_id, job_id} must be provided.
 * - `cursor` is an opaque, server-issued value. If omitted, fetching starts at the beginning
 *   of the currently retained in-memory window.
 */
export async function kahloEventsFetch(args: {
  target_id?: string;
  job_id?: string;
  cursor?: string;
  limit?: number;
  filters?: Record<string, unknown>;
}): Promise<CallToolResult> {
  const tool = "kahlo_events_fetch";

  const scopeCount = (args.target_id ? 1 : 0) + (args.job_id ? 1 : 0);
  if (scopeCount !== 1) {
    return toolErr({
      code: "INVALID_ARGUMENT",
      tool,
      message: "Provide exactly one of { target_id, job_id }.",
      retryable: false,
      details: {
        target_id: args.target_id ?? null,
        job_id: args.job_id ?? null,
      },
      suggestion: "Provide either target_id or job_id, not both or neither",
    });
  }

  try {
    const res = fetchEvents({
      target_id: args.target_id,
      job_id: args.job_id,
      cursor: args.cursor,
      limit: args.limit,
      filters: args.filters,
    });

    // Tool schema expects the stable Event envelope. Our backend already normalizes to it.
    return toolOk({
      events: res.events as KahloEvent[],
      cursor: args.cursor,
      next_cursor: res.next_cursor,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return toolErr({
      code: "INTERNAL",
      tool,
      message: msg,
      retryable: false,
      suggestion: "Check target status with kahlo_targets_status",
    });
  }
}

