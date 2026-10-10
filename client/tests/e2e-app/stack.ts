// Endpoints of the e2e stack (infra/e2e/stack.json — shared with
// scripts/e2e-stack.mjs and scripts/build-e2e-app.mjs) and where the app
// build lives. Pure data: no fixtures, safe to import from global setup.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const CLIENT_DIR = resolve(here, '../..');
export const REPO_ROOT = resolve(CLIENT_DIR, '..');
export const E2E_INFRA_DIR = join(REPO_ROOT, 'infra', 'e2e');
// Runtime dir of the host-run backend (pid, log, coverage counters).
export const E2E_RUN_DIR = join(E2E_INFRA_DIR, '.run');

// The built app (scripts/build-e2e-app.mjs). E2E_OUT_DIR lets several
// authors build + run their own copy side by side; resolved like the build
// script does (relative to client/).
export const APP_DIR = resolve(CLIENT_DIR, process.env['E2E_OUT_DIR'] || 'out-e2e');

export interface StackConfig {
  irc: { host: string; port: number };
  znc: { host: string; port: number; users: string[]; password: string; network: string };
  postgres: { host: string; port: number; database: string; user: string; password: string };
  catchallMail: { smtpPort: number; pop3Port: number; pop3User: string; pop3Password: string; apiUrl: string };
  minio: { endpoint: string; accessKey: string; secretKey: string; bucket: string };
  supabase: { apiUrl: string; dbPort: number; mailpitUrl: string; publishableKey: string; secretKey: string };
  backend: { url: string; port: number };
}

export const STACK = JSON.parse(readFileSync(join(E2E_INFRA_DIR, 'stack.json'), 'utf8')) as StackConfig;

// The Supabase secret (service-role) key isn't in stack.json — GitHub push
// protection rejects it even though it's the CLI's local key. `e2e-stack.mjs
// up` writes the running project's key to .run/supabase.json; read it lazily
// so guest-only runs and global setup don't need the stack up.
Object.defineProperty(STACK.supabase, 'secretKey', { enumerable: true, get: supabaseSecretKey });

function supabaseSecretKey(): string {
  const fromEnv = process.env['E2E_SUPABASE_SECRET_KEY'];
  if (fromEnv) return fromEnv;
  try {
    return (JSON.parse(readFileSync(join(E2E_RUN_DIR, 'supabase.json'), 'utf8')) as { secretKey: string }).secretKey;
  } catch {
    throw new Error(
      'Supabase secret key not found: bring the e2e stack up (`make test-e2e-app-up`), which writes ' +
      'infra/e2e/.run/supabase.json — or set E2E_SUPABASE_SECRET_KEY.',
    );
  }
}
