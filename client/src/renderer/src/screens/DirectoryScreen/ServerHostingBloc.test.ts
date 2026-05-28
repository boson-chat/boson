import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  DirectoryService,
  ServerWithToken,
  VerifyResponse,
} from '../../modules/directory';
import { HttpError } from '../../shared/http/http.client';
import { ServerHostingBloc, draftToInput, emptyRegisterDraft } from './ServerHostingBloc';

// A small mock of DirectoryService — only the four methods the bloc
// actually calls. Each test wires its own behaviour with vi.fn().
function mockDirectory(overrides: Partial<DirectoryService> = {}): DirectoryService {
  const base = {
    listMyServers: vi.fn().mockResolvedValue([]),
    registerServer: vi.fn(),
    verifyServer: vi.fn(),
    regenerateServerToken: vi.fn(),
  };
  return { ...base, ...overrides } as unknown as DirectoryService;
}

function pendingServer(overrides: Partial<ServerWithToken> = {}): ServerWithToken {
  return {
    id: 'srv-1',
    name: 'Test',
    hostname: 'irc.example.org',
    port: 6697,
    tls: true,
    description: '',
    tags: [],
    languages: ['en'],
    is_nsfw: false,
    is_featured: false,
    verification_status: 'pending',
    health_status: 'unknown',
    registered_at: '2026-05-27T00:00:00Z',
    verification_token: 'abc-token',
    verification_token_issued_at: '2026-05-27T00:00:00Z',
    ...overrides,
  };
}

describe('draftToInput', () => {
  it('coerces a well-formed draft into RegisterServerInput', () => {
    // tags + languages now arrive as already-normalised arrays from
    // the ChipInput (which lower-cases, trims, dedupes); the bloc
    // just passes them through.
    const result = draftToInput({
      name: '  Example  ',
      hostname: '  IRC.Example.org ',
      port: '6697',
      tls: true,
      description: '  desc ',
      tags: ['foss', 'gamedev'],
      languages: ['en', 'fr'],
      isNsfw: false,
    });
    expect(typeof result).not.toBe('string');
    if (typeof result === 'string') throw new Error('expected object');
    expect(result.hostname).toBe('irc.example.org'); // trimmed + lowered
    expect(result.name).toBe('Example');             // trimmed
    expect(result.tags).toEqual(['foss', 'gamedev']);
    expect(result.languages).toEqual(['en', 'fr']);
    expect(result.description).toBe('desc');
    expect(result.port).toBe(6697);
  });

  it('rejects empty name', () => {
    expect(draftToInput({ ...emptyRegisterDraft, name: '   ', hostname: 'irc.x', languages: ['en'] }))
      .toBe('Name is required.');
  });

  it('rejects empty hostname', () => {
    expect(draftToInput({ ...emptyRegisterDraft, name: 'X', hostname: '', languages: ['en'] }))
      .toBe('Hostname is required.');
  });

  it('rejects out-of-range port', () => {
    expect(draftToInput({ ...emptyRegisterDraft, name: 'X', hostname: 'irc.x', port: '99999', languages: ['en'] }))
      .toBe('Port must be a number between 1 and 65535.');
  });

  it('requires at least one language', () => {
    expect(draftToInput({ ...emptyRegisterDraft, name: 'X', hostname: 'irc.x', port: '6697', languages: [] }))
      .toContain('language');
  });
});

describe('ServerHostingBloc', () => {
  let bloc: ServerHostingBloc;
  let directory: DirectoryService;

  beforeEach(() => {
    directory = mockDirectory();
    bloc = new ServerHostingBloc(directory);
  });

  it('load() populates myServers and clears loadingList', async () => {
    directory.listMyServers = vi.fn().mockResolvedValue([pendingServer()]);
    bloc = new ServerHostingBloc(directory);
    await bloc.load();
    expect(bloc.getState().loadingList).toBe(false);
    expect(bloc.getState().myServers).toHaveLength(1);
  });

  it('load() captures error to listError', async () => {
    directory.listMyServers = vi.fn().mockRejectedValue(new Error('db down'));
    bloc = new ServerHostingBloc(directory);
    await bloc.load();
    expect(bloc.getState().loadingList).toBe(false);
    expect(bloc.getState().listError).toBe('db down');
  });

  it('openRegister moves to register screen with an empty draft', () => {
    bloc.openRegister();
    const s = bloc.getState();
    expect(s.screen).toBe('register');
    expect(s.registerDraft).toEqual(emptyRegisterDraft);
  });

  it('submitRegister posts and advances to verify on success', async () => {
    const created = pendingServer({ id: 'new-srv' });
    directory.registerServer = vi.fn().mockResolvedValue(created);

    bloc.openRegister();
    bloc.updateDraft({ name: 'X', hostname: 'irc.x', port: '6697', languages: ['en'] });
    await bloc.submitRegister();

    expect(directory.registerServer).toHaveBeenCalledTimes(1);
    const s = bloc.getState();
    expect(s.screen).toBe('verify');
    expect(s.active?.id).toBe('new-srv');
    expect(s.myServers[0].id).toBe('new-srv');
  });

  it('submitRegister surfaces validation errors without calling the backend', async () => {
    directory.registerServer = vi.fn();
    bloc.openRegister();
    // draft has no languages set → validation fails
    bloc.updateDraft({ name: 'X', hostname: 'irc.x', port: '6697' });
    await bloc.submitRegister();
    expect(directory.registerServer).not.toHaveBeenCalled();
    expect(bloc.getState().registerError).toMatch(/language/i);
    expect(bloc.getState().screen).toBe('register');
  });

  it('runVerify success transitions the row to verified', async () => {
    const verified: VerifyResponse = {
      success: true,
      server: pendingServer({ verification_status: 'verified' }),
      report: { success: true, results: {} },
    };
    directory.verifyServer = vi.fn().mockResolvedValue(verified);

    bloc.openVerify(pendingServer());
    await bloc.runVerify();
    expect(bloc.getState().verify).toEqual({ kind: 'success' });
    expect(bloc.getState().active?.verification_status).toBe('verified');
  });

  it('runVerify partial keeps screen + exposes the resolver report', async () => {
    const partial: VerifyResponse = {
      success: false,
      server: pendingServer(),
      report: {
        success: false,
        results: {
          cloudflare: { outcome: 'match' },
          google: { outcome: 'missing_record' },
          quad9: { outcome: 'match' },
        },
      },
    };
    directory.verifyServer = vi.fn().mockResolvedValue(partial);

    bloc.openVerify(pendingServer());
    await bloc.runVerify();
    const s = bloc.getState();
    expect(s.verify.kind).toBe('partial');
    if (s.verify.kind === 'partial') {
      expect(s.verify.report.results.google.outcome).toBe('missing_record');
    }
  });

  it('runVerify 410 surfaces token-expired', async () => {
    directory.verifyServer = vi.fn().mockRejectedValue(new HttpError(410, 'token expired'));
    bloc.openVerify(pendingServer());
    await bloc.runVerify();
    expect(bloc.getState().verify.kind).toBe('token-expired');
  });

  it('runVerify 429 surfaces rate-limited with the cooldown window', async () => {
    directory.verifyServer = vi.fn().mockRejectedValue(new HttpError(429, 'slow down'));
    bloc.openVerify(pendingServer());
    await bloc.runVerify();
    const v = bloc.getState().verify;
    expect(v.kind).toBe('rate-limited');
    if (v.kind === 'rate-limited') expect(v.retryAfterSec).toBeGreaterThan(0);
  });

  it('runRegenerateToken updates active + list with the new row', async () => {
    const stale = pendingServer({ verification_token: 'old' });
    const refreshed = pendingServer({ verification_token: 'new' });
    directory.regenerateServerToken = vi.fn().mockResolvedValue(refreshed);

    bloc.openVerify(stale);
    // Seed the list so we can confirm the row gets replaced.
    (bloc as unknown as { state: typeof bloc.getState extends () => infer S ? S : never }).state = {
      ...bloc.getState(),
      myServers: [stale],
    };
    await bloc.runRegenerateToken();
    expect(bloc.getState().active?.verification_token).toBe('new');
    expect(bloc.getState().myServers[0].verification_token).toBe('new');
    expect(bloc.getState().verify.kind).toBe('idle');
  });
});
