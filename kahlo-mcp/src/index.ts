import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, resolveDataDir } from "./config.js";
import { Logger } from "./logger.js";
import { loadPackageMeta } from "./meta.js";
import { registerTools } from "./tools/register.js";

/**
 * MCP server entrypoint.
 *
 * This process hosts the kahlo MCP server and wires tool registration plus
 * runtime configuration (transport, data directory, log level).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pkg = loadPackageMeta();
  const logger = new Logger(config.logLevel);

  const resolvedDataDir = resolveDataDir(config);

  const server = new McpServer({ name: "kahlo", version: pkg.version });

  // IMPORTANT: tools must be registered before connecting to a transport, since
  // registration mutates server capabilities and request handlers.
  registerTools(server, {
    serverName: "kahlo",
    serverVersion: pkg.version,
    transport: config.transport,
    dataDir: resolvedDataDir,
    logLevel: config.logLevel,
  });

  // Start the MCP server so clients can connect.
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Print retro-styled banner and configuration info.
  logger.printBanner({
    transport: config.transport,
    dataDir: resolvedDataDir,
  });
}

main().catch((err) => {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  process.stderr.write(`[kahlo-mcp] fatal ${msg}\n`);
  process.exitCode = 1;
});

