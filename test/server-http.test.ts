/**
 * HTTP/SSE transport — integration tests for src/server-http.ts endpoints.
 *
 * Spins up the HTTP server on a random available port for each test so
 * tests never collide and no manual port management is required.
 */
import { createServer as createNodeHttpServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createMcpServer, TOOL_NAMES } from '../src/server.js';

/** Grab a free OS-assigned port. */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNodeHttpServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') return reject(new Error('No address'));
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

/** Minimal HTTP server that mirrors src/server-http.ts logic. */
function startTestHttpServer(port: number): {
  close: () => Promise<void>;
} {
  const mcpServer = createMcpServer();
  const transports = new Map<string, SSEServerTransport>();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, tools: TOOL_NAMES }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/sse') {
      const transport = new SSEServerTransport('/messages', res);
      transports.set(transport.sessionId, transport);
      res.on('close', () => transports.delete(transport.sessionId));
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

  const httpServer = createNodeHttpServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err));
    });
  });

  httpServer.listen(port);

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        mcpServer.close().finally(() => {
          httpServer.close((err) => (err ? reject(err) : resolve()));
        });
      }),
  };
}

describe('HTTP/SSE transport', () => {
  let port: number;
  let server: { close: () => Promise<void> };
  let base: string;

  beforeEach(async () => {
    port = await getFreePort();
    server = startTestHttpServer(port);
    base = `http://localhost:${port}`;
  });

  afterEach(async () => {
    await server.close();
  });

  it('GET /health returns 200 with ok:true and the tool list', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; tools: string[] };
    expect(body.ok).toBe(true);
    expect(body.tools).toEqual(Array.from(TOOL_NAMES));
  });

  it('GET /health Content-Type is application/json', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('GET /sse opens an SSE stream with the correct event-stream headers', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/sse`, {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    controller.abort(); // close the SSE connection
  });

  it('POST /messages without a valid sessionId returns 404', async () => {
    const res = await fetch(`${base}/messages?sessionId=nonexistent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('nonexistent');
  });

  it('GET /unknown-path returns 404 with a JSON error', async () => {
    const res = await fetch(`${base}/does-not-exist`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not found/i);
  });
});
