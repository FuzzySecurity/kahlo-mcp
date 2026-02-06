import path from "node:path";
import fs from "node:fs/promises";
import * as frida from "frida";

/**
 * Build Frida agent bundles into `dist/`.
 *
 * Why: Frida 17+ no longer bundles bridges (e.g., Java) into GumJS by default
 * when injecting via bindings (frida-node). We compile entrypoints that
 * import `frida-java-bridge` so the injected agents always have Java available.
 *
 * The output must be plain script JS suitable for `session.createScript()`.
 *
 * Builds:
 * 1. Orchestrator agent (coordinator for snapshots, ping, etc.)
 * 2. Job script runtime (standalone job execution with ctx API)
 */
async function main() {
  const projectRoot = path.resolve(process.cwd());

  const compiler = new frida.Compiler();
  compiler.diagnostics.connect((diag) => {
    // Keep this readable; it's usually structured objects/arrays.
    process.stderr.write(`[kahlo-mcp] frida compiler diagnostics: ${JSON.stringify(diag)}\n`);
  });

  // Build orchestrator agent
  await buildOrchestratorAgent(projectRoot, compiler);

  // Build job script runtime
  await buildJobScriptRuntime(projectRoot, compiler);
}

/**
 * Build the orchestrator agent bundle.
 */
async function buildOrchestratorAgent(projectRoot, compiler) {
  const srcPath = path.join(
    projectRoot,
    "src",
    "backend",
    "orchestrator",
    "orchestratorAgent.entry.ts"
  );
  const distDir = path.join(projectRoot, "dist", "backend", "orchestrator");
  const distPath = path.join(distDir, "orchestratorAgent.js");

  await fs.mkdir(distDir, { recursive: true });

  const bundle = await compiler.build(srcPath, { projectRoot });
  await fs.writeFile(distPath, bundle, "utf8");

  process.stderr.write(`[kahlo-mcp] Built orchestrator agent: ${distPath}\n`);
}

/**
 * Build the job script runtime bundle.
 *
 * This runtime is a template with placeholders that get replaced at runtime
 * to create standalone job scripts.
 */
async function buildJobScriptRuntime(projectRoot, compiler) {
  const srcPath = path.join(
    projectRoot,
    "src",
    "backend",
    "jobs",
    "jobScriptRuntime.entry.ts"
  );
  const distDir = path.join(projectRoot, "dist", "backend", "jobs");
  const distPath = path.join(distDir, "jobScriptRuntime.js");

  await fs.mkdir(distDir, { recursive: true });

  const bundle = await compiler.build(srcPath, { projectRoot });
  await fs.writeFile(distPath, bundle, "utf8");

  process.stderr.write(`[kahlo-mcp] Built job script runtime: ${distPath}\n`);
}

main().catch((err) => {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  process.stderr.write(`[kahlo-mcp] build failed: ${msg}\n`);
  process.exitCode = 1;
});
