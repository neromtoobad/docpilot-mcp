/**
 * HTTP/SSE transport entry point (Phase 6).
 *
 * Exposes the same 4 MCP tools as the stdio server, but over HTTP:
 *   GET  /sse      — establish an SSE session
 *   POST /messages — send JSON-RPC messages (sessionId required)
 *   GET  /health   — liveness check
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createServer as createMcpServer, TOOL_NAMES } from './server.js';
import { info, warn } from './util/log.js';

const PORT = Number(process.env.PORT ?? 3000);

const mcpServer = createMcpServer();

const transports = new Map<string, SSEServerTransport>();

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, tools: TOOL_NAMES }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/sse') {
    const transport = new SSEServerTransport('/messages', res);
    transports.set(transport.sessionId, transport);
    res.on('close', () => {
      transports.delete(transport.sessionId);
    });
    await mcpServer.connect(transport);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/messages') {
    const sessionId = url.searchParams.get('sessionId') ?? '';
    const transport = transports.get(sessionId);
    if (!transport) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `No active SSE session: ${sessionId}` }));
      return;
    }
    await transport.handlePostMessage(req, res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

const httpServer = createHttpServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    warn(`HTTP handler error: ${message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'Internal server error' }));
  });
});

httpServer.listen(PORT, () => {
  info(`docpilot-mcp HTTP/SSE ready on :${PORT} (tools=${TOOL_NAMES.length})`);
});

process.on('SIGINT', () => httpServer.close(() => process.exit(0)));
process.on('SIGTERM', () => httpServer.close(() => process.exit(0)));
