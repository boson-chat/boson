import type {
  DirectoryService,
  RegisterServerInput,
  ServerWithToken,
  VerifyResponse,
} from '../../modules/directory';
import { HttpError } from '../../shared/http/http.client';

// Server-hosting flow state machine. Owned by ServerHostingSection.
//
// Three top-level UI screens with linear progression:
//
//   list      → "Your servers" — every row the user has registered,
//                any status. "Add a server" button opens the form.
//   register  → Single-form registration. Submit → POST /servers
//                → token is returned → bloc advances to verify
//                carrying the freshly-created row.
//   verify    → TXT-record snippet + Copy + "Verify now". Clicking
//                fires POST /servers/{id}/verify; on success the row
//                flips to "verified" and we drop back to `list`; on
//                partial we stay here and show the resolver matrix.
//                On 410 (token expired) we surface the regenerate
//                action that does POST /servers/{id}/regenerate-token
//                in-place without rewinding the screen.
//
// Status messaging + the per-resolver result table is held here too
// rather than in the view layer so behaviour is testable without
// rendering anything.

export type ServerHostingScreen = 'list' | 'register' | 'verify';

export interface RegisterFormDraft {
  name: string;
  hostname: string;
  port: string;          // string while editing — coerced to int on submit
  tls: boolean;
  description: string;
  // tags + languages are arrays driven by the design-system ChipInput.
  // The form layer pushes a fresh array on every chip add/remove, the
  // bloc just stores it. Normalisation (lowercasing, trimming, hash
  // stripping) lives inside ChipInput so the bloc doesn't need to.
  tags: string[];
  languages: string[];
  isNsfw: boolean;
}

export const emptyRegisterDraft: RegisterFormDraft = {
  name: '',
  hostname: '',
  port: '6697',
  tls: true,
  description: '',
  tags: [],
  languages: [],
  isNsfw: false,
};

export type VerifyStatus =
  | { kind: 'idle' }
  | { kind: 'in-flight' }
  | { kind: 'success' }
  | { kind: 'partial'; report: VerifyResponse['report'] }
  | { kind: 'token-expired' }
  | { kind: 'rate-limited'; retryAfterSec: number }
  | { kind: 'error'; message: string };

export interface ServerHostingState {
  screen: ServerHostingScreen;
  loadingList: boolean;
  listError: string | null;
  myServers: ServerWithToken[];
  // Set after a successful POST /servers — drives the verify screen.
  // Also points at the row currently being verified when the bloc is on
  // `screen=verify` (the user may pick "Verify" on an older pending row
  // from the list as well).
  active: ServerWithToken | null;
  registerDraft: RegisterFormDraft;
  registerSubmitting: boolean;
  registerError: string | null;
  verify: VerifyStatus;
}

type Listener = (s: ServerHostingState) => void;

const initialState: ServerHostingState = {
  screen: 'list',
  loadingList: true,
  listError: null,
  myServers: [],
  active: null,
  registerDraft: emptyRegisterDraft,
  registerSubmitting: false,
  registerError: null,
  verify: { kind: 'idle' },
};

export class ServerHostingBloc {
  private state: ServerHostingState = initialState;
  private listeners = new Set<Listener>();

  constructor(private readonly directory: DirectoryService) {}

  getState(): ServerHostingState { return this.state; }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => { this.listeners.delete(fn); };
  }

  // Pull the user's own servers from the backend. Surfaced separately
  // from the constructor so the section can wait until the modal is
  // actually open before incurring the round-trip.
  async load(): Promise<void> {
    this.set({ loadingList: true, listError: null });
    try {
      const myServers = await this.directory.listMyServers();
      this.set({ loadingList: false, myServers });
    } catch (err) {
      this.set({ loadingList: false, listError: messageOf(err) });
    }
  }

  openRegister(): void {
    this.set({ screen: 'register', registerDraft: emptyRegisterDraft, registerError: null });
  }

  closeRegister(): void {
    this.set({ screen: 'list', registerError: null });
  }

  updateDraft(patch: Partial<RegisterFormDraft>): void {
    this.set({ registerDraft: { ...this.state.registerDraft, ...patch } });
  }

  async submitRegister(): Promise<void> {
    const draft = this.state.registerDraft;
    const input = draftToInput(draft);
    if (typeof input === 'string') {
      this.set({ registerError: input });
      return;
    }
    this.set({ registerSubmitting: true, registerError: null });
    try {
      const created = await this.directory.registerServer(input);
      this.set({
        registerSubmitting: false,
        myServers: [created, ...this.state.myServers],
        active: created,
        screen: 'verify',
        verify: { kind: 'idle' },
      });
    } catch (err) {
      this.set({ registerSubmitting: false, registerError: messageOf(err) });
    }
  }

  // Switch from the list view directly to verifying a row that's
  // already pending — operator may have abandoned a verify earlier and
  // is coming back to finish.
  openVerify(server: ServerWithToken): void {
    this.set({ screen: 'verify', active: server, verify: { kind: 'idle' } });
  }

  backToList(): void {
    this.set({ screen: 'list', verify: { kind: 'idle' } });
  }

  async runVerify(): Promise<void> {
    const active = this.state.active;
    if (!active) return;
    this.set({ verify: { kind: 'in-flight' } });
    try {
      const res = await this.directory.verifyServer(active.id);
      if (res.success) {
        // Replace the row in the list with the updated server (now
        // verified, token redacted by the backend).
        const updated = res.server;
        this.set({
          verify: { kind: 'success' },
          active: updated,
          myServers: this.state.myServers.map((s) => (s.id === updated.id ? updated : s)),
        });
        return;
      }
      this.set({ verify: { kind: 'partial', report: res.report } });
    } catch (err) {
      this.set({ verify: classifyVerifyError(err) });
    }
  }

  async runRegenerateToken(): Promise<void> {
    const active = this.state.active;
    if (!active) return;
    try {
      const refreshed = await this.directory.regenerateServerToken(active.id);
      this.set({
        active: refreshed,
        myServers: this.state.myServers.map((s) => (s.id === refreshed.id ? refreshed : s)),
        verify: { kind: 'idle' },
      });
    } catch (err) {
      this.set({ verify: { kind: 'error', message: messageOf(err) } });
    }
  }

  private set(patch: Partial<ServerHostingState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }
}

// draftToInput coerces the form draft into a RegisterServerInput,
// returning a string error message if validation fails. Done here so
// the section component never has to know what "valid" looks like.
export function draftToInput(d: RegisterFormDraft): RegisterServerInput | string {
  const name = d.name.trim();
  const hostname = d.hostname.trim().toLowerCase();
  if (!name) return 'Name is required.';
  if (!hostname) return 'Hostname is required.';
  // IRC hostnames are DNS names — bare IPs are rejected by policy
  // server-side, but we don't fight the user about it here. The
  // server will return ErrInvalidInput if it's truly malformed.
  const port = Number.parseInt(d.port.trim(), 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return 'Port must be a number between 1 and 65535.';
  }
  if (d.languages.length === 0) {
    return 'Pick at least one language so the directory filter has something to match.';
  }
  const description = d.description.trim();
  return {
    name,
    hostname,
    port,
    tls: d.tls,
    description: description || undefined,
    tags: d.tags,
    languages: d.languages,
    is_nsfw: d.isNsfw,
  };
}

// classifyVerifyError maps HTTP failures into the typed VerifyStatus
// the UI renders. 410 → token expired (offer regenerate). 429 →
// rate-limited (read the Retry-After header so the UI can count down).
// 4xx/5xx fallback → generic error.
function classifyVerifyError(err: unknown): VerifyStatus {
  if (err instanceof HttpError) {
    if (err.status === 410) return { kind: 'token-expired' };
    if (err.status === 429) {
      // Body could carry retryAfter, but the canonical place is the
      // Retry-After response header. fetch() doesn't expose response
      // headers through the HttpClient wrapper, so the bloc just
      // assumes the 30s window the middleware enforces. Refining this
      // later means surfacing headers from HttpClient.
      return { kind: 'rate-limited', retryAfterSec: 30 };
    }
  }
  return { kind: 'error', message: messageOf(err) };
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}
