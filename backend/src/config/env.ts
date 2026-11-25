import dotenv from 'dotenv';
import { z } from 'zod';

/**
 * WHY THIS FILE EXISTS
 * --------------------
 * Every configurable value the backend needs (ports, URLs, API keys) comes from
 * environment variables, never from hardcoded strings in the code. That way the
 * same code runs locally, in staging, and in production with different .env files.
 *
 * WHY VALIDATE WITH ZOD AT STARTUP?
 * Process environment variables are always plain strings ("5000", not 5000), and
 * they can be missing entirely. If we read them lazily deep inside the app, a typo
 * surfaces as a confusing runtime crash on the 500th request instead of a clear
 * message at boot. Validating once, at startup, turns configuration mistakes into
 * an obvious, immediate failure - and gives us a strongly typed `env` object.
 */

// Loads variables from backend/.env into process.env.
// Safe to call when the file does not exist: it simply does nothing.
dotenv.config();

/**
 * Zod schema describing the shape of a valid environment.
 * Anything not listed here is ignored on purpose - we only trust declared keys.
 */
const envSchema = z.object({
  /** Which mode the app is running in. Controls log verbosity and error detail. */
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  /**
   * Port the HTTP server listens on. `z.coerce.number()` converts the string
   * coming from process.env into a real number, then `.int().min().max()`
   * rejects nonsense values such as "abc" or 99999.
   */
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),

  /** The origin (protocol + host + port) the React app is served from. */
  CORS_ORIGIN: z.string().trim().min(1).default('http://localhost:5173'),

  /**
   * First path segment shared by every API route.
   * Keeping it in config means the version bump to v2 is a one-line change.
   */
  API_PREFIX: z.string().trim().startsWith('/').default('/api/v1'),

  /** Supabase Postgres connection string; local development can omit it to use SQLite. */
  DATABASE_URL: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().trim().url().refine((value) => /^postgres(ql)?:\/\//i.test(value), 'Must be a PostgreSQL connection URL').optional(),
  ),
  DATABASE_PATH: z.string().trim().min(1).default('./storage/case-study-tool.sqlite'),
  SQLITE_MIGRATION_PATH: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().trim().min(1).optional(),
  ),

  SUPABASE_URL: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().trim().url().refine((value) => new URL(value).protocol === 'https:', 'Must use HTTPS').optional(),
  ),
  SUPABASE_SERVICE_ROLE_KEY: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().trim().min(1).optional(),
  ),
  SUPABASE_SECRET_KEY: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().trim().min(1).optional(),
  ),
  SUPABASE_STORAGE_BUCKET: z.string().trim().min(1).default('case-study-files'),

  GITHUB_TOKEN: z.string().trim().optional(),
  GROQ_API_KEY: z.string().trim().optional(),
  GROQ_MODEL: z.string().trim().default('llama-3.3-70b-versatile'),
  GROQ_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  GROQ_MAX_TOKENS: z.coerce.number().int().min(100).max(16000).default(8000),
  TAVILY_API_KEY: z.string().trim().optional(),
  REPORT_STORAGE_DIR: z.string().trim().min(1).default('./storage/reports'),
  UPLOAD_STORAGE_DIR: z.string().trim().min(1).default('./storage/uploads'),
}).superRefine((values, context) => {
  const hasStorageKey = Boolean(values.SUPABASE_SECRET_KEY || values.SUPABASE_SERVICE_ROLE_KEY);
  if (Boolean(values.SUPABASE_URL) !== hasStorageKey) {
    context.addIssue({ code: 'custom', path: ['SUPABASE_SECRET_KEY'], message: 'Set SUPABASE_URL and either SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY to enable Supabase Storage' });
  }
  if (values.NODE_ENV === 'production') {
    if (!values.DATABASE_URL) context.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'DATABASE_URL must point to the Supabase Postgres database in production' });
    if (!values.SUPABASE_URL || !hasStorageKey) {
      context.addIssue({ code: 'custom', path: ['SUPABASE_URL'], message: 'SUPABASE_URL and a Supabase secret key are required for production file storage' });
    }
  }
});

/** The raw, validated result. If this throws, the app must not start. */
const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Print every problem at once so the developer fixes all of them in one edit,
  // not one restart per mistake.
  console.error('\n[env] Invalid environment configuration:\n');
  for (const issue of parsed.error.issues) {
    const key = issue.path.join('.') || '(root)';
    console.error(`  - ${key}: ${issue.message}`);
  }
  console.error('\nCheck backend/.env against backend/.env.example\n');
  process.exit(1);
}

/** Validated, fully-typed configuration used everywhere else in the backend. */
export const env = {
  ...parsed.data,
  /** Convenience booleans so callers never compare strings themselves. */
  isDevelopment: parsed.data.NODE_ENV === 'development',
  isProduction: parsed.data.NODE_ENV === 'production',
  isTest: parsed.data.NODE_ENV === 'test',
} as const;

export type Env = typeof env;
