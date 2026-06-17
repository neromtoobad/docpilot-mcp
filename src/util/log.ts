/**
 * Structured stderr logger.
 *
 * MCP stdio servers MUST NOT write to stdout (it is reserved for JSON-RPC
 * messages). All operator-visible output goes to stderr in a stable
 * `level message` format that is easy to grep in production.
 *
 * Verbosity is controlled by the `LOG_LEVEL` environment variable
 * (debug | info | warn | error). Default: info.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function minLevel(): number {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as LogLevel;
  return LEVEL_ORDER[raw] ?? LEVEL_ORDER.info;
}

export function log(level: LogLevel, message: string): void {
  if (LEVEL_ORDER[level] < minLevel()) return;
  process.stderr.write(`${level} ${message}\n`);
}

export function debug(message: string): void {
  log('debug', message);
}

export function info(message: string): void {
  log('info', message);
}

export function warn(message: string): void {
  log('warn', message);
}

export function error(message: string): void {
  log('error', message);
}
