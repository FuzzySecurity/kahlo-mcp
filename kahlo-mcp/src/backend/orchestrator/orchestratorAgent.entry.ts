/**
 * Orchestrator Agent entrypoint compiled by `frida-compile`.
 *
 * Frida 17+ no longer bundles bridges (Java/ObjC/Swift) into GumJS by default when
 * injecting scripts through bindings (like frida-node). We bundle the Java bridge
 * here for future snapshot providers that may need Java introspection.
 *
 * See: https://frida.re/docs/bridges/
 */
import Java from "frida-java-bridge";

// Expose the bridge for orchestrator internals (snapshot providers, etc.)
(globalThis as any).Java = Java;

// Load the orchestrator implementation
import "./orchestratorAgent.js";

