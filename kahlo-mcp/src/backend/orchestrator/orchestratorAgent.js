'use strict';

/**
 * Orchestrator Agent - Minimal coordinator for target instrumentation.
 *
 * This agent is injected into target processes to provide:
 * - Liveness probing (ping)
 * - Runtime snapshots (process info, native modules)
 *
 * Job execution is handled by per-job scripts (see jobScriptRuntime.js).
 * Each job runs in its own Frida script instance, providing full hook isolation
 * and automatic cleanup when jobs are cancelled.
 */

/**
 * Capture an on-demand snapshot of process state.
 *
 * Supported kinds:
 * - process.info: Basic process information (pid, arch, platform)
 * - native.modules: List of loaded native libraries
 *
 * @param {string} kind Snapshot kind string.
 * @param {object} [options] Optional snapshot-specific options.
 * @returns {object} Snapshot payload (shape depends on kind).
 */
function getSnapshot(kind, options) {
  var k = typeof kind === 'string' ? kind : String(kind);
  var opts = options && typeof options === 'object' ? options : {};

  if (k === 'process.info') {
    return {
      pid: (typeof Process !== 'undefined' && Process.id) ? Process.id : null,
      arch: (typeof Process !== 'undefined' && Process.arch) ? Process.arch : null,
      platform: (typeof Process !== 'undefined' && Process.platform) ? Process.platform : null,
      pointer_size: (typeof Process !== 'undefined' && Process.pointerSize) ? Process.pointerSize : null,
      page_size: (typeof Process !== 'undefined' && Process.pageSize) ? Process.pageSize : null
    };
  }

  if (k === 'native.modules') {
    var maxModules = 0;
    try {
      maxModules = typeof opts.max_modules === 'number' ? opts.max_modules : 0;
    } catch (_) {}
    if (!maxModules || maxModules <= 0) maxModules = 512;

    var mods = [];
    try {
      var rawMods = Process.enumerateModules();
      for (var i = 0; i < rawMods.length && mods.length < maxModules; i++) {
        var m = rawMods[i];
        mods.push({
          name: m.name || null,
          base: m.base ? String(m.base) : null,
          size: typeof m.size === 'number' ? m.size : null,
          path: m.path || null
        });
      }
    } catch (e) {
      throw new Error('native.modules snapshot failed: ' + String(e && e.message ? e.message : e));
    }

    return { modules: mods, truncated: mods.length >= maxModules };
  }

  throw new Error('Unknown snapshot kind: ' + k);
}

rpc.exports = {
  /**
   * Liveness probe. Host calls this after loading the script to verify it's ready.
   *
   * @returns {string} "pong"
   */
  ping: function () {
    return 'pong';
  },

  /**
   * Capture a runtime snapshot.
   *
   * @param {string} kind One of: process.info | native.modules
   * @param {object} [options] Optional snapshot-specific parameters.
   * @returns {object} Snapshot payload (shape depends on kind).
   */
  getSnapshot: function (kind, options) {
    return getSnapshot(kind, options || {});
  },

  /**
   * List jobs in this target. Returns empty array.
   * Jobs are tracked host-side, not in the orchestrator.
   *
   * @returns {Array} Empty array (jobs tracked host-side)
   */
  listJobs: function () {
    return [];
  },

  /**
   * Cancel all jobs. Returns 0.
   * Jobs are managed host-side via isolated scripts.
   *
   * @returns {number} 0 (no jobs in orchestrator)
   */
  cancelAllJobs: function () {
    return 0;
  }
};
