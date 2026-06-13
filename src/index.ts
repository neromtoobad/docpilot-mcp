/**
 * docpilot-mcp — entry point.
 *
 * Wires the MCP server to the stdio transport, registers the 4 tools,
 * and logs a single `docpilot-mcp ready (tools=N)` line to stderr.
 * Exits 0 when stdin closes.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, TOOL_NAMES } from './server.js';
import { log } from './util/log.js';

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  // Print the ready line BEFORE we start consuming stdin so that
  // an immediate EOF still results in a visible ready signal.
  log('info', `docpilot-mcp ready (tools=${TOOL_NAMES.length})`);

  await server.connect(transport);

  // Graceful shutdown: when stdin closes (the parent MCP client disconnects)
  // or the process is asked to terminate, close the server cleanly so
  // Node exits with code 0.
  const shutdown = async (signal: string): Promise<void> => {
    log('info', `shutting down (signal=${signal})`);
    try {
      await server.close();
    } catch (err) {
      log('error', `shutdown error: ${(err as Error).message}`);
    }
    process.exit(0);
  };

  process.stdin.on('close', () => {
    void shutdown('stdin-close');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

main().catch((err) => {
  // Last-resort logger; we never want to throw past main().
  process.stderr.write(`docpilot-mcp fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
