/**
 * MCP server factory.
 *
 * Owns the tool registration table so the entry point can read the
 * tool count from a single source of truth.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { registerQueryDocs } from './tools/queryDocs.js';
import { registerGetChangelog } from './tools/getChangelog.js';
import { registerSearchExamples } from './tools/searchExamples.js';
import { registerResolveMethod } from './tools/resolveMethod.js';

/** Canonical list of tools the server exposes. */
export const TOOL_NAMES = [
  'query_docs',
  'get_changelog',
  'search_examples',
  'resolve_method',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** Build a fresh MCP server with all 4 tools registered. */
export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: 'docpilot-mcp',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        'docpilot-mcp fetches live, version-accurate documentation and code examples for npm and ' +
        'PyPI packages so you never hallucinate a stale API. ' +
        'Tool selection guide:\n' +
        '• query_docs — use when a user asks HOW to do something with a package ' +
        '(e.g. "how do I paginate stripe charges"). Returns a cited markdown answer with source URLs.\n' +
        '• get_changelog — use when the user asks WHAT CHANGED or wants the latest version. ' +
        'Returns the 10 most recent release notes.\n' +
        '• search_examples — use when the user wants to SEE real code for a task ' +
        '(e.g. "show me a customer creation example"). Returns ≤10 verified GitHub snippets.\n' +
        '• resolve_method — use when the user needs an EXACT method signature or parameter list ' +
        '(e.g. "what args does stripe.customers.create take"). Returns the parsed .d.ts/.pyi ' +
        'signature with a GitHub source link.\n' +
        'Always pass an explicit version when the user mentions one; pass "latest" otherwise. ' +
        'Ecosystem (npm/pypi) is auto-detected from the package registries when omitted.',
    },
  );

  registerQueryDocs(server);
  registerGetChangelog(server);
  registerSearchExamples(server);
  registerResolveMethod(server);

  return server;
}

/** Re-export common zod helpers used by tool input schemas. */
export { z };
