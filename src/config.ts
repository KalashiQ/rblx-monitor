import { z } from 'zod';

const envSchema = z.object({
  DB_PATH: z.string().min(1),
  POLL_INTERVAL_MS: z.coerce.number().int().positive(),
  ANOMALY_N_SIGMA: z.coerce.number().positive(),
  MIN_POINTS_IN_WINDOW: z.coerce.number().int().positive(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  ALLOWED_USER_IDS: z.string().optional(),
  CONCURRENCY: z.coerce.number().int().positive(),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive(),
  RETRY_ATTEMPTS: z.coerce.number().int().nonnegative(),
  RETRY_BACKOFF_MS: z.coerce.number().int().positive(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info').optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development').optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Construct readable error
  const formatted = parsed.error.flatten();
  const entries = Object.entries(formatted.fieldErrors as Record<string, string[] | undefined>);
  const missing = entries
    .filter(([, msgs]) => msgs && msgs.length)
    .map(([key, msgs]) => `${key}: ${msgs?.join(', ')}`)
    .join('; ');
  throw new Error(`Invalid environment configuration: ${missing}`);
}

export type AppConfig = z.infer<typeof envSchema> & {
  LOG_LEVEL: NonNullable<z.infer<typeof envSchema>['LOG_LEVEL']>;
  NODE_ENV: NonNullable<z.infer<typeof envSchema>['NODE_ENV']>;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  ALLOWED_USER_IDS?: string;
};

// Fill defaults for optional fields ensured above
export const config: AppConfig = {
  ...parsed.data,
  LOG_LEVEL: parsed.data.LOG_LEVEL ?? 'info',
  NODE_ENV: parsed.data.NODE_ENV ?? 'development',
};


