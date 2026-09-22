import { z } from 'zod';

const flag = z.enum(['true', 'false']).default('false').transform((v) => v === 'true');
const list = z
  .string()
  .default('')
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(8080),
    LOG_LEVEL: z.string().default('info'),

    // Supabase: Project Settings → Database → Connection string (URI).
    DATABASE_URL: z.string().min(1, 'is required'),
    DATABASE_SSL: flag,

    JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_TTL: z.string().default('30d'),

    // The Web OAuth client ID(s) Google ID tokens are issued for.
    GOOGLE_CLIENT_IDS: list,

    STORAGE_DRIVER: z.enum(['supabase', 'local']).default('local'),
    SUPABASE_URL: z.url().optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
    SUPABASE_BUCKET: z.string().default('photos'),
    LOCAL_STORAGE_DIR: z.string().default('./uploads'),
    PUBLIC_BASE_URL: z.url().optional(),
    SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
    MAX_UPLOAD_MB: z.coerce.number().positive().default(15),

    CORS_ORIGINS: list,
  })
  .superRefine((c, ctx) => {
    if (c.STORAGE_DRIVER === 'supabase' && (!c.SUPABASE_URL || !c.SUPABASE_SERVICE_ROLE_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['STORAGE_DRIVER'],
        message: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required when STORAGE_DRIVER=supabase',
      });
    }
    if (c.SUPABASE_SERVICE_ROLE_KEY && isPublicSupabaseKey(c.SUPABASE_SERVICE_ROLE_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['SUPABASE_SERVICE_ROLE_KEY'],
        message:
          'this is the public (publishable/anon) key. Use the secret key: Supabase → Project Settings → API Keys → ' +
          '"secret" (sb_secret_…) or legacy "service_role". Without it Supabase refuses storage writes.',
      });
    }
  })
  .transform((c) => ({
    ...c,
    PUBLIC_BASE_URL: (c.PUBLIC_BASE_URL ?? `http://localhost:${c.PORT}`).replace(/\/+$/, ''),
  }));

/** Reads and checks settings once at startup; a bad value stops the server with a clear list. */
export function loadConfig(env = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || 'config'}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return Object.freeze(result.data);
}

/** True for keys meant for apps (publishable / anon), which can't manage storage. */
function isPublicSupabaseKey(key) {
  const k = key.trim();
  if (k.startsWith('sb_publishable_')) return true;
  const parts = k.split('.');
  if (parts.length !== 3) return false;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString()).role === 'anon';
  } catch {
    return false;
  }
}
