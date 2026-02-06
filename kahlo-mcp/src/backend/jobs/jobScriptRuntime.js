'use strict';

/**
 * Job Script Runtime - Standalone runtime for isolated job execution.
 *
 * This file is compiled with frida-compile to bundle the Java bridge.
 * The bundle is passed unmodified to session.createScript().
 * All job parameters are passed via RPC after script load.
 *
 * RPC parameters (passed via startJob RPC):
 * - job_id : string - unique job identifier
 * - job_type : string - 'oneshot' | 'daemon' | 'interactive'
 * - module_source : string - the user's module code
 * - params : object - parameters passed to start()
 */

// ============================================================================
// Stdlib Resolution
// ============================================================================

/**
 * Resolve the stdlib factory from the global scope.
 *
 * The stdlib factory is exposed by the entry.ts file after bundling.
 * It creates a stdlib instance bound to the Java bridge.
 *
 * @returns {function|null} The createStdlib factory function or null.
 */
function resolveStdlibFactory() {
  try {
    var g = typeof globalThis !== 'undefined' ? globalThis : null;
    if (g && typeof g.__kahloStdlibFactory === 'function') {
      return g.__kahloStdlibFactory;
    }
  } catch (_) {
    // ignore
  }
  return null;
}

/**
 * Stdlib instance (lazily initialized).
 * @type {object|null}
 */
var _stdlibInstance = null;

/**
 * Callback for the stdlib to increment hooks_installed metric.
 *
 * This function is passed to the stdlib factory so that hook helpers
 * can update jobState.metrics.hooks_installed when hooks are installed.
 *
 * @param {number} count - Number of hooks to add (default 1).
 */
function incrementHooksInstalled(count) {
  var increment = typeof count === 'number' && count > 0 ? count : 1;
  jobState.metrics.hooks_installed = (jobState.metrics.hooks_installed || 0) + increment;
}

/**
 * Get or create the stdlib instance.
 *
 * The stdlib is lazily initialized on first access to ensure
 * the Java bridge is available.
 *
 * @returns {object|null} The stdlib object or null if unavailable.
 */
function getStdlib() {
  if (_stdlibInstance !== null) {
    return _stdlibInstance;
  }

  var factory = resolveStdlibFactory();
  if (!factory) {
    return null;
  }

  var jb = resolveJavaBridge();
  _stdlibInstance = factory(jb, { onHookInstalled: incrementHooksInstalled });
  return _stdlibInstance;
}

// ============================================================================
// Utilities
// ============================================================================

function nowIso() {
  return new Date().toISOString();
}

function isThenable(v) {
  return v !== null && v !== undefined && typeof v.then === 'function';
}

function createArtifactId() {
  return 'art_' + Math.random().toString(16).slice(2) + '_' + Date.now().toString(16);
}

var MAX_ARTIFACT_SIZE_BYTES = 10 * 1024 * 1024;
var ALLOWED_ARTIFACT_TYPES = ['file_dump', 'memory_dump', 'trace', 'pcap_like', 'custom'];

// ============================================================================
// Job State (initialized when startJob RPC is called)
// ============================================================================

var jobState = {
  job_id: null,      // Set by startJob RPC
  type: null,        // Set by startJob RPC
  state: 'not_started',
  created_at: null,
  updated_at: null,
  heartbeat: null,
  metrics: { events_emitted: 0, hooks_installed: 0, errors: 0 },
  result: null,
  error: null,
  _timers: []
};

// ============================================================================
// Java Bridge Resolution
// ============================================================================

/**
 * Resolve the Java bridge object (if present).
 *
 * With Frida 17+, bridges are not bundled by default, so the job script
 * entry bundles the Java bridge at compile time.
 *
 * @returns {any | null} Java bridge object or null when unavailable.
 */
function resolveJavaBridge() {
  try {
    if (typeof Java !== 'undefined') return Java;
  } catch (_) {
    // ignore
  }
  try {
    var g = typeof globalThis !== 'undefined' ? globalThis : null;
    if (g && g.Java) return g.Java;
  } catch (_) {
    // ignore
  }
  return null;
}

function isJavaAvailable() {
  var jb = resolveJavaBridge();
  return !!(jb && jb.available);
}

// ============================================================================
// Timer Management
// ============================================================================

function recordTimer(id) {
  jobState._timers.push(id);
  return id;
}

function clearAllTimers() {
  for (var i = 0; i < jobState._timers.length; i++) {
    var id = jobState._timers[i];
    try { clearTimeout(id); } catch (_) {}
    try { clearInterval(id); } catch (_) {}
  }
  jobState._timers = [];
}

// ============================================================================
// Event Emission
// ============================================================================

function emitEvent(kind, level, payload) {
  var ts = nowIso();
  var safeKind = typeof kind === 'string' ? kind : String(kind);
  if (safeKind.length === 0) safeKind = 'event';

  var safeLevel = typeof level === 'string' ? level : String(level);
  if (
    safeLevel !== 'debug' &&
    safeLevel !== 'info' &&
    safeLevel !== 'warn' &&
    safeLevel !== 'error'
  ) {
    safeLevel = 'info';
  }

  try {
    send({
      kahlo: {
        type: 'event',
        v: 1,
        ts: ts,
        job_id: jobState.job_id,
        kind: safeKind,
        level: safeLevel,
        payload: payload === undefined ? null : payload
      }
    });
    jobState.metrics.events_emitted = (jobState.metrics.events_emitted || 0) + 1;
  } catch (e) {
    jobState.metrics.errors = (jobState.metrics.errors || 0) + 1;
  }
}

// ============================================================================
// Job Context (ctx) - API exposed to module code
// ============================================================================

var ctx = {
  /**
   * The job identifier for this job's execution context.
   * This is a getter to ensure it returns the correct value after startJob() is called.
   */
  get job_id() {
    return jobState.job_id;
  },

  /**
   * Java bridge handle for this job.
   * This is a getter to ensure it resolves the bridge at access time.
   */
  get Java() {
    return resolveJavaBridge();
  },

  /**
   * Whether Java APIs are available in this process.
   * @returns {boolean}
   */
  javaAvailable: function () {
    return isJavaAvailable();
  },

  /**
   * Ensure Java is available, otherwise emit a structured error and throw.
   * @param {string} [hint] Optional hint to include in the emitted error event.
   * @returns {any} The Java bridge object.
   */
  requireJava: function (hint) {
    var jb = resolveJavaBridge();
    if (!jb || !jb.available) {
      emitEvent(
        'java.unavailable',
        'error',
        { message: 'Java runtime is not available in this process', hint: hint || null }
      );
      throw new Error('Java runtime is not available in this process');
    }
    return jb;
  },

  /**
   * Update the job's heartbeat timestamp.
   * Important for daemon jobs to signal they are still alive.
   */
  heartbeat: function () {
    jobState.heartbeat = nowIso();
    jobState.updated_at = jobState.heartbeat;
    // Send heartbeat to host
    send({
      kahlo: {
        type: 'heartbeat',
        v: 1,
        ts: jobState.heartbeat,
        job_id: jobState.job_id
      }
    });
  },

  /**
   * Frida-safe setTimeout (auto-cleared on job cancel/unload).
   */
  setTimeout: function (fn, ms) {
    return recordTimer(setTimeout(fn, ms));
  },

  /**
   * Frida-safe setInterval (auto-cleared on job cancel/unload).
   */
  setInterval: function (fn, ms) {
    return recordTimer(setInterval(fn, ms));
  },

  /**
   * Clear a timeout.
   */
  clearTimeout: function (id) {
    try { clearTimeout(id); } finally {}
  },

  /**
   * Clear an interval.
   */
  clearInterval: function (id) {
    try { clearInterval(id); } finally {}
  },

  /**
   * Promise-based sleep.
   * @param {number} ms Milliseconds to sleep.
   * @returns {Promise<void>}
   */
  sleep: function (ms) {
    return new Promise(function (resolve) {
      recordTimer(setTimeout(resolve, ms));
    });
  },

  /**
   * Emit a telemetry event.
   * @param {string} kind Event kind/type.
   * @param {object} payload Event payload (JSON-serializable).
   * @param {string} [level] Log level ('debug'|'info'|'warn'|'error'). Defaults to 'info'.
   */
  emit: function (kind, payload, level) {
    emitEvent(kind, level, payload);
  },

  /**
   * Convenience function to emit a log event.
   * @param {string} level Log level.
   * @param {string} message Log message.
   * @param {any} [extra] Optional extra data.
   */
  log: function (level, message, extra) {
    emitEvent('log', level, { message: message, extra: extra === undefined ? null : extra });
  },

  /**
   * Allocate a new artifact identifier.
   * @returns {string}
   */
  newArtifactId: function () {
    return createArtifactId();
  },

  /**
   * Emit an artifact (binary payload) to the host.
   *
   * @param {object} opts - Artifact options
   * @param {string} opts.type - Artifact type (file_dump|memory_dump|trace|pcap_like|custom)
   * @param {string} [opts.mime] - MIME type (default: application/octet-stream)
   * @param {string} [opts.name] - Optional filename hint
   * @param {object} [opts.metadata] - Optional job-defined metadata
   * @param {ArrayBuffer|Uint8Array} bytes - Binary payload
   * @returns {{ artifact_id: string, size_bytes: number } | { error: string }}
   */
  emitArtifact: function (opts, bytes) {
    opts = opts || {};
    var artifactType = opts.type;

    // Validate type
    if (!artifactType || ALLOWED_ARTIFACT_TYPES.indexOf(artifactType) === -1) {
      var errMsg = 'Invalid artifact type: ' + artifactType + '. Allowed: ' + ALLOWED_ARTIFACT_TYPES.join(', ');
      emitEvent('artifact.error', 'error', { error: errMsg, type: artifactType });
      return { error: errMsg };
    }

    // Validate bytes
    var byteLen = 0;
    var payload = null;
    if (bytes instanceof ArrayBuffer) {
      byteLen = bytes.byteLength;
      payload = bytes;
    } else if (bytes && bytes.buffer instanceof ArrayBuffer) {
      // Uint8Array or other TypedArray
      byteLen = bytes.byteLength;
      payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    } else if (bytes === null || bytes === undefined) {
      byteLen = 0;
      payload = new ArrayBuffer(0);
    } else {
      var errMsg2 = 'Invalid bytes argument: expected ArrayBuffer or Uint8Array';
      emitEvent('artifact.error', 'error', { error: errMsg2 });
      return { error: errMsg2 };
    }

    // Validate size limit
    if (byteLen > MAX_ARTIFACT_SIZE_BYTES) {
      var errMsg3 = 'Artifact too large: ' + byteLen + ' bytes exceeds max ' + MAX_ARTIFACT_SIZE_BYTES + ' bytes';
      emitEvent('artifact.error', 'error', { error: errMsg3, size_bytes: byteLen, max_bytes: MAX_ARTIFACT_SIZE_BYTES });
      return { error: errMsg3 };
    }

    var artifact_id = createArtifactId();
    var envelope = {
      kahlo: {
        type: 'artifact',
        ts: nowIso(),
        artifact: {
          artifact_id: artifact_id,
          job_id: jobState.job_id,
          type: artifactType,
          size_bytes: byteLen,
          mime: opts.mime || 'application/octet-stream',
          name: opts.name || null,
          metadata: opts.metadata || null
        }
      }
    };

    send(envelope, payload);
    emitEvent('artifact.sent', 'info', { artifact_id: artifact_id, size_bytes: byteLen, type: artifactType });

    return { artifact_id: artifact_id, size_bytes: byteLen };
  },

  // ==========================================================================
  // Standard Library (stdlib)
  // ==========================================================================

  /**
   * Standard library providing common instrumentation utilities.
   *
   * The stdlib is organized into namespaces:
   * - stack   : Stack trace capture and formatting
   * - inspect : Object introspection and type discovery
   * - classes : Java class enumeration and loading utilities
   * - bytes   : Binary data manipulation (hex, base64, ArrayBuffer)
   * - strings : String manipulation and encoding helpers
   * - intent  : Android Intent parsing and construction
   * - hook    : Hook installation helpers and patterns
   * - safe    : Safe wrappers that handle exceptions gracefully
   * - time    : Timing utilities (timestamps, duration formatting)
   *
   * @type {object|null}
   *
   * @example
   * // Capture and emit a stack trace
   * var trace = ctx.stdlib.stack.toString({ limit: 10 });
   * ctx.emit('stack', { trace: trace });
   *
   * @example
   * // Convert bytes to hex
   * var hex = ctx.stdlib.bytes.toHex(keyData, { separator: ':' });
   * ctx.emit('crypto.key', { hex: hex });
   */
  get stdlib() {
    return getStdlib();
  },

  // ==========================================================================
  // Convenience Functions (shortcuts to commonly used stdlib functions)
  // ==========================================================================

  /**
   * Capture the current Java stack trace as an array of frame objects.
   *
   * This is a convenience shortcut for ctx.stdlib.stack.capture().
   * Each frame object contains: className, methodName, fileName, lineNumber.
   *
   * @param {object} [options] - Options for stack capture.
   * @param {number} [options.skip=0] - Number of frames to skip from the top.
   * @param {number} [options.limit] - Maximum number of frames to return.
   * @returns {Array<object>} Array of stack frame objects, or empty array if unavailable.
   *
   * @example
   * var frames = ctx.getJavaStackTrace({ limit: 5 });
   * frames.forEach(function(f) {
   *   ctx.log('debug', f.className + '.' + f.methodName);
   * });
   */
  getJavaStackTrace: function (options) {
    var lib = getStdlib();
    if (!lib || !lib.stack || typeof lib.stack.capture !== 'function') {
      return [];
    }
    try {
      return lib.stack.capture(options);
    } catch (e) {
      return [];
    }
  },

  /**
   * Capture the current Java stack trace as a formatted string.
   *
   * This is a convenience shortcut for ctx.stdlib.stack.toString().
   * Returns the stack trace in the standard "at class.method(file:line)" format.
   *
   * @param {object} [options] - Options for stack capture.
   * @param {number} [options.skip=0] - Number of frames to skip from the top.
   * @param {number} [options.limit] - Maximum number of frames to include.
   * @param {string} [options.separator='\n'] - Separator between frames.
   * @returns {string} Formatted stack trace string, or empty string if unavailable.
   *
   * @example
   * var trace = ctx.getJavaStackTraceString({ limit: 10 });
   * ctx.emit('call', { method: methodName, stack: trace });
   */
  getJavaStackTraceString: function (options) {
    var lib = getStdlib();
    if (!lib || !lib.stack || typeof lib.stack.toString !== 'function') {
      return '';
    }
    try {
      return lib.stack.toString(options);
    } catch (e) {
      return '';
    }
  },

  /**
   * Inspect a Java object and convert it to a JSON-safe representation.
   *
   * This is a convenience shortcut for ctx.stdlib.inspect.toJson().
   * Handles common types (String, primitives, arrays, collections) and
   * falls back to toString() for complex objects.
   *
   * @param {object} obj - Java object to inspect.
   * @param {object} [options] - Inspection options.
   * @param {number} [options.maxDepth=2] - Maximum recursion depth for nested objects.
   * @param {number} [options.maxArrayLength=100] - Maximum array elements to include.
   * @param {number} [options.maxStringLength=1000] - Maximum string length.
   * @returns {any} JSON-safe representation, or null if inspection fails.
   *
   * @example
   * var data = ctx.inspectObject(bundle, { maxDepth: 3 });
   * ctx.emit('intent.extras', { data: data });
   */
  inspectObject: function (obj, options) {
    var lib = getStdlib();
    if (!lib || !lib.inspect || typeof lib.inspect.toJson !== 'function') {
      // Fallback: try basic toString
      if (obj === null || obj === undefined) {
        return null;
      }
      try {
        return String(obj);
      } catch (e) {
        return '[uninspectable]';
      }
    }
    try {
      return lib.inspect.toJson(obj, options);
    } catch (e) {
      // Fallback on error
      try {
        return String(obj);
      } catch (_) {
        return '[inspection failed]';
      }
    }
  }
};

// ============================================================================
// Module Loading and Execution
// ============================================================================

function loadModuleFromSource(source) {
  // CommonJS-ish loader so callers can write:
  //   module.exports = { start(params, ctx) { ... } };
  var module = { exports: {} };
  var exports = module.exports;
  var fn = new Function('module', 'exports', source);
  fn(module, exports);
  return module.exports;
}

/**
 * Run the job with the provided parameters.
 * Called via RPC after script load.
 *
 * @param {object} args - Job arguments: { job_id, job_type, module_source, params }
 * @returns {object} Initial job status.
 */
function runJob(args) {
  if (jobState.state !== 'not_started') {
    return {
      ok: false,
      error: 'Job already started',
      state: jobState.state
    };
  }

  // Validate required arguments
  if (!args || typeof args !== 'object') {
    return { ok: false, error: 'Invalid arguments: expected object', state: 'failed' };
  }
  if (typeof args.job_id !== 'string' || args.job_id.length === 0) {
    return { ok: false, error: 'Invalid job_id: expected non-empty string', state: 'failed' };
  }
  if (args.job_type !== 'oneshot' && args.job_type !== 'daemon' && args.job_type !== 'interactive') {
    return { ok: false, error: 'Invalid job_type: expected oneshot, daemon, or interactive', state: 'failed' };
  }
  if (typeof args.module_source !== 'string' || args.module_source.length === 0) {
    return { ok: false, error: 'Invalid module_source: expected non-empty string', state: 'failed' };
  }

  // Initialize job state from RPC arguments
  jobState.job_id = args.job_id;
  jobState.type = args.job_type;
  jobState.created_at = nowIso();
  jobState.state = 'starting';
  jobState.updated_at = nowIso();
  
  var moduleSource = args.module_source;
  var params = args.params || {};

  // Emit job started event
  emitEvent('job.started', 'info', {
    job_id: jobState.job_id,
    type: jobState.type
  });

  var mod;
  try {
    mod = loadModuleFromSource(moduleSource);
  } catch (e) {
    jobState.state = 'failed';
    jobState.error = { message: 'Module load failed: ' + String(e && e.message ? e.message : e) };
    jobState.updated_at = nowIso();
    emitEvent('job.failed', 'error', {
      error: jobState.error.message,
      phase: 'load',
      metrics: jobState.metrics
    });
    return { ok: false, error: jobState.error.message, state: jobState.state };
  }

  // Call init() if present
  if (typeof mod.init === 'function') {
    try {
      mod.init(ctx);
    } catch (e) {
      jobState.state = 'failed';
      jobState.error = { message: 'Module init failed: ' + String(e && e.message ? e.message : e) };
      jobState.updated_at = nowIso();
      emitEvent('job.failed', 'error', {
        error: jobState.error.message,
        phase: 'init',
        metrics: jobState.metrics
      });
      return { ok: false, error: jobState.error.message, state: jobState.state };
    }
  }

  jobState.state = 'running';
  jobState.updated_at = nowIso();

  function finishOk(result) {
    jobState.result = result === undefined ? null : result;
    jobState.state = 'completed';
    jobState.updated_at = nowIso();
    emitEvent('job.completed', 'info', {
      result: jobState.result,
      metrics: jobState.metrics
    });
    clearAllTimers();
  }

  function finishErr(err) {
    jobState.state = 'failed';
    jobState.error = { message: String(err && err.message ? err.message : err) };
    jobState.updated_at = nowIso();
    emitEvent('job.failed', 'error', {
      error: jobState.error.message,
      phase: 'start',
      metrics: jobState.metrics
    });
    clearAllTimers();
  }

  // Call start()
  try {
    if (typeof mod.start !== 'function') {
      var errMsg = 'Module missing required function: start(params, ctx)';
      finishErr(new Error(errMsg));
      return { ok: false, error: errMsg, state: jobState.state };
    }

    var out = mod.start(params || {}, ctx);

    if (jobState.type === 'oneshot') {
      if (isThenable(out)) {
        out.then(finishOk, finishErr);
      } else {
        finishOk(out);
      }
    } else {
      // For daemon/interactive jobs, start() returning means "running"
      if (isThenable(out)) {
        out.then(function () {
          jobState.updated_at = nowIso();
        }, finishErr);
      }
    }

    return { ok: true, state: jobState.state };
  } catch (e) {
    finishErr(e);
    return { ok: false, error: jobState.error.message, state: jobState.state };
  }
}

// ============================================================================
// RPC Exports (for host communication)
// ============================================================================

rpc.exports = {
  /**
   * Liveness probe.
   * @returns {string} "pong"
   */
  ping: function () {
    return 'pong';
  },

  /**
   * Start the job with the provided parameters.
   * This is called by the host after script load.
   *
   * @param {object} args - Job arguments: { job_id, job_type, module_source, params }
   * @returns {object} Result with ok/error and initial state.
   */
  startJob: function (args) {
    return runJob(args);
  },

  /**
   * Get current job status.
   * @returns {object} Job state object.
   */
  getStatus: function () {
    return {
      job_id: jobState.job_id,
      type: jobState.type,
      state: jobState.state,
      heartbeat: jobState.heartbeat || undefined,
      metrics: jobState.metrics,
      result: jobState.result || undefined,
      error: jobState.error || undefined,
      created_at: jobState.created_at,
      updated_at: jobState.updated_at
    };
  }
};

// Script is ready - host calls rpc.exports.startJob({ job_id, job_type, module_source, params })
