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
        'docpilot-mcp exposes 4 tools for fetching live, version-accurate documentation and code ' +
        'examples for npm and PyPI packages. Use query_docs for ranked answers, get_changelog for ' +
        'recent releases, search_examples for official code samples, and resolve_method for ' +
        'current method signatures.',
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
