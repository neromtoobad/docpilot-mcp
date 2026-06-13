/**
 * MCP error helpers.
 *
 * All tool errors are returned as `isError: true` results with a stable
 * machine-readable `code` field (per AC-9) and a human-readable `message`.
 * The codes are intentionally short and uppercase so callers can branch
 * on them without parsing free text.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Stable, machine-readable error codes returned to MCP clients. */
export type ToolErrorCode =
  | 'E_NOT_IMPLEMENTED'
  | 'E_NOT_FOUND'
  | 'E_RATE_LIMIT'
  | 'E_UPSTREAM'
  | 'E_INVALID_INPUT'
  | 'E_INTERNAL';

/** Build an `isError: true` result with a structured `code` + `message` payload. */
export function toolError(
  code: ToolErrorCode,
  message: string,
  details?: unknown,
): CallToolResult {
  const payload = {
    code,
    message,
    ...(details !== undefined ? { details } : {}),
  };
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload),
      },
    ],
  };
}
