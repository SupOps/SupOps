import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Anchor relative paths to the repository root, not to the current working
 * directory. Otherwise `npm run seed` from apps/server and `npm run dev` from the
 * root quietly open two different SQLite files, and the symptom ("no such table")
 * points nowhere near the cause.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fromRoot = (p: string): string => (isAbsolute(p) ? p : join(REPO_ROOT, p));

function required(name: string, hint: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`\n  Missing ${name}.\n  ${hint}\n  See .env.example and copy it to .env.\n`);
    process.exit(1);
  }
  return v;
}

const devSecret = randomBytes(32).toString('hex');

export const config = {
  port: Number(process.env.PORT ?? 3001),
  repoRoot: REPO_ROOT,
  /** The built SPA. Served on the API port when present (the Docker image builds it). */
  webDir: join(REPO_ROOT, 'apps/web/dist'),
  databasePath: fromRoot(process.env.DATABASE_PATH ?? './data/supops.db'),
  masterKey: required(
    'SUPOPS_MASTER_KEY',
    'Generate one with: openssl rand -base64 32',
  ),
  // A generated fallback keeps `npm run dev` working out of the box; in production an
  // unset secret would silently invalidate every session on restart, so we warn.
  jwtSecret: process.env.JWT_SECRET ?? devSecret,
  jwtSecretIsEphemeral: !process.env.JWT_SECRET,
  runConcurrency: Number(process.env.RUN_CONCURRENCY ?? 1),
  /**
   * Restrict new accounts to these email domains (comma-separated). Empty = no
   * restriction (the open-source default). Set e.g. AUTH_ALLOWED_EMAIL_DOMAIN=acme.com
   * on an internal deployment to make it org-only. Enforced at account creation, never
   * at login, so a break-glass local admin can always sign in.
   */
  authAllowedDomains: (process.env.AUTH_ALLOWED_EMAIL_DOMAIN ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
  /**
   * Other origins allowed to call the API from a browser (comma-separated), e.g. a
   * separate dashboard. Empty = same origin only: the built UI is served from this
   * port and `npm run dev` proxies through Vite, so neither needs CORS.
   */
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean),
  llm: {
    baseUrl: process.env.LLM_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta/openai/',
    apiKey: process.env.LLM_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? 'gemini-3.8-flash',
    classifierModel: process.env.LLM_CLASSIFIER_MODEL ?? 'gemini-3.5-flash-lite',
    /** Tried when the main model fails (overloaded, rate limited, unknown). Empty: none. */
    fallbackModel: process.env.LLM_FALLBACK_MODEL ?? '',
  },
};

export function warnAboutConfig(): void {
  if (config.jwtSecretIsEphemeral) {
    console.warn('  ! JWT_SECRET is unset; using a random one. Sessions will not survive a restart.');
  }
  if (!config.llm.apiKey) {
    console.warn('  ! LLM_API_KEY is unset. Runs will fail until you set one in .env.');
    console.warn('    Free Gemini key: https://aistudio.google.com/apikey');
  }
  if (config.authAllowedDomains.length) {
    console.log(`  accounts restricted to: ${config.authAllowedDomains.map((d) => '@' + d).join(', ')}`);
  }
}
