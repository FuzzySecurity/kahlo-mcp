/**
 * Job Script Runtime entrypoint compiled by `frida-compile`.
 *
 * Frida 17+ no longer bundles bridges (Java/ObjC/Swift) into GumJS by default when
 * injecting scripts through bindings (like frida-node). To make Java APIs available
 * in isolated job scripts, we bundle the Java bridge here.
 *
 * This entrypoint also bundles the stdlib (standard library) utilities for
 * common instrumentation tasks.
 *
 * See: https://frida.re/docs/bridges/
 */
import Java from "frida-java-bridge";

// Import stdlib factory and types
import { createStdlib } from "./jobScriptStdlib.js";

// Expose the bridge globally for the runtime to access
(globalThis as any).Java = Java;

// Expose the stdlib factory globally so the runtime can create instances
(globalThis as any).__kahloStdlibFactory = createStdlib;

// Load the job script runtime (rpc.exports, ctx API, module execution, etc.)
import "./jobScriptRuntime.js";
