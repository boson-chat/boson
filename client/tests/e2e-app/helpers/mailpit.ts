// Read-only-ish client for the two Mailpit instances of the e2e stack:
//
//   Mailpit.users()     the users' own inboxes — Supabase auth mail (sign-up
//                       confirmation, password recovery, email change).
//                       Bundled with the boson-e2e Supabase project.
//   Mailpit.catchall()  the boson.chat catch-all (PurelyMail in prod): ergo's
//                       NickServ verification mails. The backend's nick-claim
//                       worker polls it over POP3 every 5s and DELETES what it
//                       consumes (and anything it can't route), so read from
//                       it promptly or expect messages to vanish.
//
// Both speak Mailpit's HTTP API (https://mailpit.axllent.org/docs/api-v1/).
import { STACK } from '../stack';

export interface MailAddress { Name: string; Address: string }

export interface MailSummary {
  ID: string;
  Subject: string;
  From: MailAddress;
  To: MailAddress[];
  Created: string;
  Snippet: string;
}

export interface MailMessage extends MailSummary {
  Text: string;
  HTML: string;
}

export class Mailpit {
  constructor(readonly baseUrl: string) {}

  static users(): Mailpit {
    return new Mailpit(STACK.supabase.mailpitUrl);
  }

  static catchall(): Mailpit {
    return new Mailpit(STACK.catchallMail.apiUrl);
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, init);
    if (!res.ok) throw new Error(`mailpit ${init?.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // Newest first. `query` uses Mailpit's search syntax, e.g.
  // `to:"a@example.test" subject:"Confirm"`.
  async list(query?: string): Promise<MailSummary[]> {
    const r = query
      ? await this.api<{ messages: MailSummary[] }>(`/search?query=${encodeURIComponent(query)}`)
      : await this.api<{ messages: MailSummary[] }>('/messages');
    return r.messages ?? [];
  }

  async read(id: string): Promise<MailMessage> {
    return this.api<MailMessage>(`/message/${encodeURIComponent(id)}`);
  }

  // Polls until a message matching `to` / `subject` arrives; returns the
  // newest match in full.
  async waitFor(opts: { to?: string; subject?: string | RegExp; timeoutMs?: number }): Promise<MailMessage> {
    const timeoutMs = opts.timeoutMs ?? 20_000;
    const query = opts.to ? `to:"${opts.to}"` : undefined;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = (await this.list(query)).find((m) =>
        opts.subject === undefined ? true
          : typeof opts.subject === 'string' ? m.Subject.includes(opts.subject) : opts.subject.test(m.Subject));
      if (hit) return this.read(hit.ID);
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`no mail ${JSON.stringify({ to: opts.to, subject: String(opts.subject ?? '') })} in ${this.baseUrl} after ${timeoutMs}ms`);
  }

  // Deletes the messages matching `query` (or every message).
  async clear(query?: string): Promise<void> {
    if (query) await this.api(`/search?query=${encodeURIComponent(query)}`, { method: 'DELETE' });
    else await this.api('/messages', { method: 'DELETE' });
  }
}

// Every http(s) URL in a message (text part, falling back to HTML hrefs).
export function extractLinks(msg: Pick<MailMessage, 'Text' | 'HTML'>): string[] {
  const found = new Set<string>();
  for (const m of (msg.Text ?? '').matchAll(/https?:\/\/[^\s<>()"']+/g)) found.add(m[0]);
  for (const m of (msg.HTML ?? '').matchAll(/href="(https?:\/\/[^"]+)"/g)) found.add(m[1]!.replace(/&amp;/g, '&'));
  return [...found];
}

// First match of `re` (default: a standalone 6–8 digit/letter code) in the
// text part. Returns the first capture group when `re` has one.
export function extractCode(msg: Pick<MailMessage, 'Text'>, re = /\b([A-Za-z0-9]{6,8})\b/): string {
  const m = (msg.Text ?? '').match(re);
  if (!m) throw new Error(`no code matching ${re} in mail text`);
  return m[1] ?? m[0];
}
