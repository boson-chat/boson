// Sizes, durations, the usage meter's line and the friendly upload errors.
// Sizes are decimal (5 GB = 5 000 000 000 bytes), as the files service's
// config writes them.

export interface FilesUsage {
  used: number;
  quota: number;
  window_seconds: number;
  max_file: number;
  // When space comes back: bytes freed at each time (ISO or unix seconds).
  frees?: Array<{ bytes: number; at: string | number }>;
}

export interface FilesError {
  code: string;
  message: string;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  let i = 0;
  let v = n;
  while (v >= 1000 && i < UNITS.length - 1) { v /= 1000; i++; }
  if (i === 0) return `${Math.round(v)} B`;
  const s = v >= 100 ? v.toFixed(0) : v.toFixed(1);
  return `${s.replace(/\.0$/, '')} ${UNITS[i]}`;
}

// A time to come: "5 min", "20 h", "3 days".
export function formatDuration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.round(ms / 3_600_000);
  if (h < 48) return `${h} h`;
  const d = Math.round(ms / 86_400_000);
  return `${d} days`;
}

// The quota window: "3 days", "day", "36 h".
export function formatWindow(seconds: number): string {
  if (seconds > 0 && seconds % 86_400 === 0) {
    const d = seconds / 86_400;
    return d === 1 ? 'day' : `${d} days`;
  }
  return `${Math.round(seconds / 3600)} h`;
}

export function toMillis(at: string | number | undefined | null): number | null {
  if (at === undefined || at === null || at === '') return null;
  if (typeof at === 'number') return at < 1e12 ? at * 1000 : at;
  if (/^\d+$/.test(at)) return toMillis(Number(at));
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : t;
}

// The meter: "1.2 GB of 5 GB used · 1 GB frees in 20 h".
export function usageSummary(u: FilesUsage, now = Date.now()): string {
  const base = `${formatBytes(u.used)} of ${formatBytes(u.quota)} used`;
  const next = nextFree(u, now);
  return next ? `${base} · ${formatBytes(next.bytes)} frees in ${formatDuration(next.at - now)}` : base;
}

// The next time space comes back: bytes freed then.
export function nextFree(u: FilesUsage, now = Date.now()): { bytes: number; at: number } | null {
  return (u.frees ?? [])
    .map((f) => ({ bytes: f.bytes, at: toMillis(f.at) }))
    .filter((f): f is { bytes: number; at: number } => f.at !== null && f.at > now && f.bytes > 0)
    .sort((a, b) => a.at - b.at)[0] ?? null;
}

// Files (sizes, in the order listed) against what's left of the quota:
// null when they all fit (or the quota isn't known), else how many fit —
// counted from the top of the list — and the message saying so and when
// space frees up: "Only 2 of 3 files fit in the 1.2 GB left · 1 GB frees
// up in 20 h".
export function batchQuotaCheck(sizes: readonly number[], u: FilesUsage | null | undefined, now = Date.now()): { fit: number; message: string } | null {
  if (!u || !(u.quota > 0)) return null;
  const left = Math.max(0, u.quota - u.used);
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= left) return null;
  let fit = 0;
  let sum = 0;
  for (const n of sizes) {
    if (sum + n > left) break;
    sum += n;
    fit++;
  }
  let message = sizes.length === 1
    ? `This file doesn't fit in the ${formatBytes(left)} left`
    : fit === 0
      ? `None of these files fit in the ${formatBytes(left)} left`
      : `Only ${fit} of ${sizes.length} files fit in the ${formatBytes(left)} left`;
  const next = nextFree(u, now);
  if (next) message += ` · ${formatBytes(next.bytes)} frees up in ${formatDuration(next.at - now)}`;
  return { fit, message };
}

// How much comes back by `at` (from the usage schedule; a minute's slack,
// as the error and the schedule are read at slightly different times).
function freedBy(frees: FilesUsage['frees'], at: number, now: number): number {
  return (frees ?? []).reduce((sum, f) => {
    const t = toMillis(f.at);
    return t !== null && t > now && t <= at + 60_000 ? sum + f.bytes : sum;
  }, 0);
}

// "You've used 4.8 GB of 5 GB in the last 3 days, 1 GB frees up in 20 h".
export function quotaExceededMessage(
  e: { used?: number; quota?: number; window_seconds?: number; frees_at?: string | number },
  opts: { now?: number; frees?: FilesUsage['frees'] } = {},
): string {
  const now = opts.now ?? Date.now();
  const used = e.used ?? 0;
  const quota = e.quota ?? 0;
  let s = `You've used ${formatBytes(used)} of ${formatBytes(quota)}`;
  if (e.window_seconds) s += ` in the last ${formatWindow(e.window_seconds)}`;
  const at = toMillis(e.frees_at);
  if (at !== null && at > now) {
    const freed = freedBy(opts.frees, at, now);
    s += freed > 0
      ? `, ${formatBytes(freed)} frees up in ${formatDuration(at - now)}`
      : `, space frees up in ${formatDuration(at - now)}`;
  }
  return s;
}

export function fileTooLargeMessage(max: number, file?: { name: string; size: number }): string {
  const limit = `the limit is ${formatBytes(max)} per file`;
  return file ? `${file.name} is ${formatBytes(file.size)}; ${limit}.` : `That file is too large; ${limit}.`;
}

export const STORAGE_FULL_MESSAGE = "This server's file storage is full right now — try again later";

type Json = Record<string, unknown>;

// The files service's error answer → what the user reads. Its body is
// {"error"|"code": <code>, "message", …details} (details at the top level
// or under "details").
export function describeUploadError(
  status: number,
  body: string,
  opts: { now?: number; frees?: FilesUsage['frees']; file?: { name: string; size: number }; retryAfter?: string | null } = {},
): FilesError {
  let j: Json = {};
  try { j = (JSON.parse(body) as Json) ?? {}; } catch { /* not JSON */ }
  const details = { ...(typeof j['details'] === 'object' && j['details'] ? j['details'] as Json : {}), ...j };
  const code = String(j['error'] ?? j['code'] ?? '') || (status === 507 ? 'storage_full' : '');
  const num = (k: string): number | undefined => (typeof details[k] === 'number' ? details[k] as number : undefined);
  switch (code) {
    case 'quota_exceeded':
      // frees_at null: waiting won't help — the file is bigger than the
      // whole quota.
      if ('frees_at' in details && details['frees_at'] === null) {
        return { code, message: `This file is bigger than your whole upload allowance (${formatBytes(num('quota') ?? 0)} per ${formatWindow(num('window_seconds') ?? 0)})` };
      }
      return {
        code,
        message: quotaExceededMessage({
          used: num('used'),
          quota: num('quota'),
          window_seconds: num('window_seconds'),
          frees_at: details['frees_at'] as string | number | undefined,
        }, opts),
      };
    case 'file_too_large':
      return { code, message: fileTooLargeMessage(num('max') ?? num('max_file') ?? 0, opts.file) };
    case 'storage_full':
      return { code, message: STORAGE_FULL_MESSAGE };
    case 'cancelled':
      return { code, message: 'Upload cancelled' };
    case 'uploads_disabled':
      return { code, message: 'File uploads are turned off on this server right now' };
    case 'guest_disabled':
      return { code, message: 'This server only takes uploads from signed-in users' };
    case 'invalid_guest_token':
      return { code, message: "The files server didn't accept your guest pass — try again" };
    case 'rate_limited': {
      const secs = Number(opts.retryAfter ?? '');
      const wait = Number.isFinite(secs) && secs > 0 ? ` in ${formatDuration(secs * 1000)}` : ' in a moment';
      return { code, message: `Too many uploads — try again${wait}` };
    }
    case 'empty_file':
      return { code, message: 'That file is empty' };
    case 'incomplete_body':
    case 'length_required':
      return { code, message: "The file didn't arrive in full — try again" };
  }
  if (status === 401) return { code: code || 'unauthenticated', message: 'The files server didn\'t accept your sign-in — try again' };
  if (status === 403) return { code: code || 'forbidden', message: "You can't upload files on this server" };
  if (status === 0) return { code: code || 'network', message: "Couldn't reach the files server" };
  const msg = typeof j['message'] === 'string' && j['message'] ? `: ${j['message'] as string}` : '';
  return { code: code || 'upload_failed', message: `Upload failed (${status})${msg}` };
}
