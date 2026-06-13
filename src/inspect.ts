/**
 * `npm run inspect` — enumerate the tools the server registers.
 *
 * Prints exactly 4 tool names with a one-line description for each.
 * This is the human-facing sanity check referenced by AC-2.
 */
import { createServer, TOOL_NAMES } from './server.js';

const server = createServer();
// `registerTool` stores its result on the McpServer (not the underlying
// Server). The internal field name is private to the SDK so we read
// through a typed escape hatch.
const registered = (
  server as unknown as { _registeredTools: Record<string, { description?: string; title?: string }> }
)._registeredTools;

for (const name of TOOL_NAMES) {
  const tool = registered[name];
  const description = (tool?.description ?? tool?.title ?? '').split('\n')[0];
  process.stdout.write(`- ${name}: ${description}\n`);
}
