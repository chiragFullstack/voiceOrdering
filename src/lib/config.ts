/**
 * Runtime configuration.
 *
 * Read once at module load, validated, and frozen. Every value has a safe
 * default so the app boots with an empty environment — a malformed value is
 * reported and replaced with its default rather than crashing the server on a
 * typo in a deployment variable.
 */

import { z } from 'zod';

const numberFromEnv = (fallback: number, min: number, max: number) =>
  z
    .preprocess((value) => {
      if (value === undefined || value === '') return fallback;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }, z.number().int().min(min).max(max))
    .catch(fallback);

const configSchema = z.object({
  sessionTtlMinutes: numberFromEnv(30, 1, 24 * 60),
  maxSessions: numberFromEnv(500, 1, 100_000),
  rateLimitMaxRequests: numberFromEnv(90, 1, 10_000),
  rateLimitWindowSeconds: numberFromEnv(60, 1, 3600),
  maxUtteranceLength: numberFromEnv(500, 10, 2000),
  maxTranscriptTurns: numberFromEnv(120, 10, 1000),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).catch('info'),
  orderLogDir: z.string().trim().min(1).nullable().catch(null),
  isProduction: z.boolean(),
});

export type AppConfig = Readonly<z.infer<typeof configSchema>>;

function readConfig(): AppConfig {
  const parsed = configSchema.parse({
    sessionTtlMinutes: process.env.SESSION_TTL_MINUTES,
    maxSessions: process.env.MAX_SESSIONS,
    rateLimitMaxRequests: process.env.RATE_LIMIT_MAX_REQUESTS,
    rateLimitWindowSeconds: process.env.RATE_LIMIT_WINDOW_SECONDS,
    maxUtteranceLength: process.env.MAX_UTTERANCE_LENGTH,
    maxTranscriptTurns: process.env.MAX_TRANSCRIPT_TURNS,
    logLevel: process.env.LOG_LEVEL,
    orderLogDir: process.env.ORDER_LOG_DIR ?? null,
    isProduction: process.env.NODE_ENV === 'production',
  });
  return Object.freeze(parsed);
}

export const config: AppConfig = readConfig();
