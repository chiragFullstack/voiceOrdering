/**
 * Structured logging.
 *
 * One JSON object per line, which any log shipper can ingest. Two rules:
 *
 *  - every request carries a `requestId`, and that id is also returned to the
 *    caller in error responses, so a user-reported failure maps to one log line;
 *  - caller speech is **not** logged at `info`. Utterances are personal data;
 *    they are only emitted at `debug`, which is off by default.
 */

import { config } from './config';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function shouldLog(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[config.logLevel];
}

/** Values that must never reach a log destination. */
const REDACTED_KEYS = new Set(['utterance', 'transcript', 'text', 'authorization', 'cookie']);

function sanitise(fields: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACTED_KEYS.has(key.toLowerCase()) && config.logLevel !== 'debug') {
      output[key] = '[redacted]';
      continue;
    }
    output[key] = value instanceof Error ? `${value.name}: ${value.message}` : value;
  }
  return output;
}

function emit(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  if (!shouldLog(level)) return;
  const entry = {
    level,
    time: new Date().toISOString(),
    message,
    ...sanitise(fields),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => emit('debug', message, fields),
  info: (message: string, fields?: Record<string, unknown>) => emit('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit('error', message, fields),
} as const;
