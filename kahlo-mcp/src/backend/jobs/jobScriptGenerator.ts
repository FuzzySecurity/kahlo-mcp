/**
 * Job Script Source Provider - Provides the compiled job script runtime.
 *
 * The job script runtime is compiled with frida-compile to bundle the Java bridge.
 * The bundle is passed unmodified to session.createScript().
 * All job parameters (job_id, job_type, module_source, params) are passed via RPC.
 *
 * @module jobScriptGenerator
 */

import fs from "node:fs";

/**
 * Cache for the compiled runtime source.
 */
let runtimeCache: { source: string; mtimeMs: number } | null = null;

/**
 * Get the compiled job script runtime source.
 *
 * The bundle is returned unmodified - no substitutions are performed.
 * All job parameters are passed via RPC after script load.
 *
 * @returns The compiled runtime source (frida-compile bundle).
 * @throws Error if the runtime file is not found.
 */
export function getJobScriptRuntimeSource(): string {
  // The runtime is compiled to dist/backend/jobs/jobScriptRuntime.js
  const url = new URL("./jobScriptRuntime.js", import.meta.url);

  // Reload if file changed (for development iteration)
  const stat = fs.statSync(url);
  if (runtimeCache && runtimeCache.mtimeMs === stat.mtimeMs) {
    return runtimeCache.source;
  }

  const source = fs.readFileSync(url, "utf8");
  runtimeCache = { source, mtimeMs: stat.mtimeMs };
  return source;
}

/**
 * Validate that the job script runtime is available.
 *
 * @returns true if the runtime is available, false otherwise.
 */
export function isJobScriptRuntimeAvailable(): boolean {
  try {
    getJobScriptRuntimeSource();
    return true;
  } catch {
    return false;
  }
}
