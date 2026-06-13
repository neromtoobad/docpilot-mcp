/**
 * Structured stderr logger.
 *
 * MCP stdio servers MUST NOT write to stdout (it is reserved for JSON-RPC
 * messages). All operator-visible output goes to stderr in a stable
 * `level message` format that is easy to grep in production.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function log(level: LogLevel, message: string): void {
  const line = `${level} ${message}\n`;
  process.stderr.write(line);
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
