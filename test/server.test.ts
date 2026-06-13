/**
 * AC-2 — server registers exactly 4 tools with the right names,
 * descriptions, and input schemas.
 *
 * Validates the tool table end-to-end over an in-process MCP transport
 * so the wire-level JSON Schema and error handling are exercised
 * exactly as a real MCP client would see them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer, TOOL_NAMES } from '../src/server.js';

const EXPECTED_TOOLS = [
  'query_docs',
  'get_changelog',
  'search_examples',
  'resolve_method',
] as const;

const REQUIRED_FIELDS: Record<(typeof EXPECTED_TOOLS)[number], string[]> = {
  query_docs: ['package', 'version', 'question'],
  get_changelog: ['package'], // version is optional
  search_examples: ['package', 'version', 'query'],
  resolve_method: ['package', 'version', 'method'],
};

describe('AC-2: 4 tools with correct names, descriptions, and schemas', () => {
  let client: Client;
  let server: ReturnType<typeof createServer>;
  let transports: [InMemoryTransport, InMemoryTransport];

  beforeEach(async () => {
    server = createServer();
    transports = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'ac2-test-client', version: '0.0.0' });
    await Promise.all([
      server.connect(transports[0]),
      client.connect(transports[1]),
    ]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it('exports exactly 4 tool names in the canonical order', () => {
    expect(TOOL_NAMES).toEqual(EXPECTED_TOOLS);
    expect(new Set(TOOL_NAMES).size).toBe(4);
  });

  it('lists exactly 4 tools over MCP, with the documented names and one-line descriptions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(EXPECTED_TOOLS);

    for (const tool of tools) {
      expect(tool.description, `${tool.name} should have a description`).toBeTypeOf('string');
      const desc = tool.description ?? '';
      // AC-2 + plan verification matrix: "one-line description for each"
      expect(
        desc.length,
        `${tool.name} description must fit in a single line (${desc.length} chars)`,
      ).toBeLessThanOrEqual(200);
      expect(
        desc.includes('\n'),
        `${tool.name} description must be a single line`,
      ).toBe(false);
    }
  });

  it('publishes the documented required fields in each tool\'s JSON Schema', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    for (const name of EXPECTED_TOOLS) {
      const tool = byName[name];
      expect(tool, `${name} should be listed`).toBeDefined();
      const schema = tool.inputSchema as {
        type: 'object';
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(schema.type).toBe('object');
      expect(schema.properties, `${name} should expose properties`).toBeDefined();
      expect(schema.required, `${name} should expose required[]`).toBeDefined();

      const required = schema.required ?? [];
      const expected = REQUIRED_FIELDS[name];
      for (const field of expected) {
        expect(required, `${name} should require "${field}"`).toContain(field);
        expect(
          schema.properties?.[field],
          `${name} should declare a "${field}" property`,
        ).toBeDefined();
      }
    }

    // get_changelog's `version` is optional, must NOT be in `required`
    const getChangelog = byName.get_changelog.inputSchema as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(getChangelog.required ?? []).not.toContain('version');
    expect(getChangelog.properties?.version).toBeDefined();
  });

  it('does not advertise any `any`-typed properties (no empty {} schemas)', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const schema = tool.inputSchema as {
        properties?: Record<string, unknown>;
      };
      const props = schema.properties ?? {};
      for (const [propName, propSchema] of Object.entries(props)) {
        // A property whose schema is `{}` is a JSON-Schema "anything goes"
        // (the moral equivalent of `any`). We forbid that.
        const keys = Object.keys(propSchema as object);
        expect(
          keys.length,
          `${tool.name}.${propName} has an empty schema {} — equivalent to any`,
        ).toBeGreaterThan(0);
        // Sanity: every property must declare a type.
        expect(
          (propSchema as { type?: string }).type,
          `${tool.name}.${propName} must declare a JSON Schema "type"`,
        ).toBeTypeOf('string');
      }
    }
  });

  it('rejects calls with missing required fields with a clear error', async () => {
    // query_docs: missing `question`
    const r1 = await client.callTool({
      name: 'query_docs',
      arguments: { package: 'stripe', version: '5.0.0' },
    });
    expect(r1.isError).toBe(true);
    const text1 = (r1.content[0] as { text: string }).text;
    expect(text1).toMatch(/question/i);

    // resolve_method: missing `method`
    const r2 = await client.callTool({
      name: 'resolve_method',
      arguments: { package: 'stripe', version: '5.0.0' },
    });
    expect(r2.isError).toBe(true);
    const text2 = (r2.content[0] as { text: string }).text;
    expect(text2).toMatch(/method/i);

    // get_changelog: missing `package`
    const r3 = await client.callTool({
      name: 'get_changelog',
      arguments: {},
    });
    expect(r3.isError).toBe(true);
    const text3 = (r3.content[0] as { text: string }).text;
    expect(text3).toMatch(/package/i);
  });

  it('rejects calls to a non-existent tool with a clear error', async () => {
    const r = await client.callTool({ name: 'nope', arguments: {} });
    expect(r.isError).toBe(true);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/nope/);
  });
});
