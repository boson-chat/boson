import { describe, it, expect, vi } from 'vitest';
import { FilesController, ircTextBudget, sendChunks, uploadMessage } from './files.service';
import type { FilesBridge, FilesCall } from './files-bridge';

const FILES = 'https://files.example.org';

function bridge(over: Partial<FilesBridge> = {}, config: object = { enabled: true, guest_enabled: true, limits: { guest: { max_file_bytes: 25e6 }, account: { max_file_bytes: 100e6 } } }) {
  const calls: FilesCall[] = [];
  const b: FilesBridge = {
    discover: vi.fn(async (host: string) => ({ host, ...(host === 'irc.example.org' ? { filesUrl: FILES } : {}) })),
    request: vi.fn(async (c: FilesCall) => {
      calls.push(c);
      if (c.path === '/v1/config') return { status: 200, body: JSON.stringify(config) };
      if (c.path === '/v1/guest-token') return { status: 200, body: '{"token":"gt1"}' };
      return { status: 200, body: '{"used":0,"quota":500000000,"window_seconds":259200,"max_file":25000000,"frees":[]}' };
    }),
    beginUpload: vi.fn(async () => ({ id: 't1', path: '/_boson/files/upload/t1' })),
    cancelUpload: vi.fn(async () => {}),
    onProgress: vi.fn(() => () => {}),
    ...over,
  };
  return { b, calls };
}

const answer = (status: number, body: object) => new Response(JSON.stringify(body), { status });

describe('FilesController', () => {
  it('is available only with a files host, enabled, and guests allowed for guests', async () => {
    const { b } = bridge();
    const c = new FilesController({ bridge: b, signedIn: () => false });
    await c.ensure('irc.example.org');
    await c.ensure('irc.plain.org');
    expect(c.availability('irc.example.org')).toMatchObject({ available: true, guest: true, limits: { max_file_bytes: 25e6 } });
    expect(c.availability('irc.plain.org').available).toBe(false);
    expect(c.isFilesOrigin('https://files.example.org')).toBe(true);

    const off = new FilesController({ bridge: bridge({}, { enabled: true, guest_enabled: false }).b, signedIn: () => false });
    await off.ensure('irc.example.org');
    expect(off.availability('irc.example.org').available).toBe(false);
    const acct = new FilesController({ bridge: bridge({}, { enabled: true, guest_enabled: false }).b, signedIn: () => true });
    await acct.ensure('irc.example.org');
    expect(acct.availability('irc.example.org').available).toBe(true);
  });

  it('a guest gets a token on the first upload, then posts "<caption> <url>"', async () => {
    const { b, calls } = bridge();
    const url = `${FILES}/f/AbCdEfGhIjKlMnOpQrStUv/beach.jpg`;
    const fetchFn = vi.fn(async () => answer(201, { id: 'x', url }));
    const post = vi.fn();
    const c = new FilesController({ bridge: b, signedIn: () => false, fetch: fetchFn as unknown as typeof fetch, doneLingerMs: 0 });
    await c.ensure('irc.example.org');
    expect(calls.some((x) => x.path === '/v1/guest-token')).toBe(false);
    c.upload({ host: 'irc.example.org', channel: '#a', file: new Blob(['abc'], { type: 'image/jpeg' }), name: 'beach.jpg', caption: ' at the beach ', post });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith(`at the beach ${url}`));
    expect(b.beginUpload).toHaveBeenCalledWith(expect.objectContaining({ filesUrl: FILES, auth: 'Guest gt1', name: 'beach.jpg', size: 3, type: 'image/jpeg' }));
    expect(calls.filter((x) => x.path === '/v1/guest-token')).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledWith('/_boson/files/upload/t1?offset=0', expect.objectContaining({ method: 'POST' }));
  });

  it('an account uses its bearer token', async () => {
    const { b, calls } = bridge();
    const c = new FilesController({
      bridge: b, signedIn: () => true, accountToken: async () => 'acc', doneLingerMs: 0,
      fetch: (async () => answer(201, { url: `${FILES}/f/AbCdEfGhIjKlMnOpQrStUv/a.txt` })) as unknown as typeof fetch,
    });
    await c.ensure('irc.example.org');
    const post = vi.fn();
    c.upload({ host: 'irc.example.org', channel: '#a', file: new Blob(['x']), name: 'a.txt', post });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith(`${FILES}/f/AbCdEfGhIjKlMnOpQrStUv/a.txt`));
    expect(b.beginUpload).toHaveBeenCalledWith(expect.objectContaining({ auth: 'Bearer acc' }));
    expect(calls.some((x) => x.path === '/v1/guest-token')).toBe(false);
  });

  it('a refused upload shows why, and posts nothing', async () => {
    const { b } = bridge();
    const c = new FilesController({
      bridge: b, signedIn: () => false,
      fetch: (async () => answer(507, { code: 'storage_full' })) as unknown as typeof fetch,
    });
    await c.ensure('irc.example.org');
    const post = vi.fn();
    const id = c.upload({ host: 'irc.example.org', channel: '#a', file: new Blob(['x']), name: 'a.txt', post });
    await vi.waitFor(() => expect(c.uploads.value.find((u) => u.id === id)?.status).toBe('error'));
    expect(c.uploads.value[0]).toMatchObject({ errorCode: 'storage_full', error: "This server's file storage is full right now — try again later" });
    expect(post).not.toHaveBeenCalled();
    c.dismiss(id);
    expect(c.uploads.value).toHaveLength(0);
  });

  it('cancel aborts the transfer and tells the shell', async () => {
    const { b } = bridge();
    let signal: AbortSignal | undefined;
    const fetchFn = vi.fn((_: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
      signal = init.signal ?? undefined;
      signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    }));
    const c = new FilesController({ bridge: b, signedIn: () => false, fetch: fetchFn as unknown as typeof fetch });
    await c.ensure('irc.example.org');
    const post = vi.fn();
    const id = c.upload({ host: 'irc.example.org', channel: '#a', file: new Blob(['x']), name: 'a.txt', post });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled());
    c.cancel(id);
    expect(signal?.aborted).toBe(true);
    expect(b.cancelUpload).toHaveBeenCalledWith('t1');
    expect(c.uploads.value).toHaveLength(0);
    expect(post).not.toHaveBeenCalled();
  });

  it('sign-out cancels every upload and forgets the guest token', async () => {
    const { b, calls } = bridge();
    const fetchFn = vi.fn((_: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
      init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    }));
    const c = new FilesController({ bridge: b, signedIn: () => false, fetch: fetchFn as unknown as typeof fetch });
    await c.ensure('irc.example.org');
    const post = vi.fn();
    c.upload({ host: 'irc.example.org', channel: '#a', file: new Blob(['x']), name: 'a.txt', post });
    c.upload({ host: 'irc.example.org', channel: '#b', file: new Blob(['y']), name: 'b.txt', post });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled());
    c.clearForSignOut();
    expect(b.cancelUpload).toHaveBeenCalledWith('t1');
    expect(c.uploads.value).toEqual([]);
    expect(post).not.toHaveBeenCalled();
    // The next person's upload gets a guest token of its own.
    const before = calls.filter((x) => x.path === '/v1/guest-token').length;
    c.upload({ host: 'irc.example.org', channel: '#a', file: new Blob(['z']), name: 'c.txt', post });
    await vi.waitFor(() => expect(calls.filter((x) => x.path === '/v1/guest-token').length).toBe(before + 1));
    c.clearForSignOut();
  });

  it('a refused guest token (invalid_guest_token) is refetched once and the upload retried', async () => {
    const { b, calls } = bridge();
    const url = `${FILES}/f/AbCdEfGhIjKlMnOpQrStUv/a.txt`;
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(answer(401, { error: 'invalid_guest_token' }))
      .mockResolvedValueOnce(answer(201, { url }));
    const c = new FilesController({ bridge: b, signedIn: () => false, fetch: fetchFn as unknown as typeof fetch, doneLingerMs: 0 });
    await c.ensure('irc.example.org');
    const post = vi.fn();
    c.upload({ host: 'irc.example.org', channel: '#a', file: new Blob(['x']), name: 'a.txt', post });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith(url));
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(calls.filter((x) => x.path === '/v1/guest-token')).toHaveLength(2);
  });

  it('uploadMessage', () => {
    expect(uploadMessage('https://x/f/a/b', '')).toBe('https://x/f/a/b');
    expect(uploadMessage('https://x/f/a/b', '  look\nhere ')).toBe('look here https://x/f/a/b');
  });
});

describe('sendChunks', () => {
  const more = () => new Response('{}', { status: 202, headers: { 'X-Boson-Upload': 'more' } });

  it('sends the file in order as ArrayBuffer chunks, ?offset= on each, and returns the last answer', async () => {
    const bytes = new Uint8Array(10).map((_, i) => i);
    const seen: { url: string; body: number[] }[] = [];
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.body).toBeInstanceOf(ArrayBuffer);
      seen.push({ url, body: [...new Uint8Array(init.body as ArrayBuffer)] });
      return seen.length < 3 ? more() : answer(201, { url: 'u' });
    });
    const res = await sendChunks(fetchFn as unknown as typeof fetch, '/_boson/files/upload/t1', new Blob([bytes]), 4, new AbortController().signal);
    expect(res.status).toBe(201);
    expect(seen.map((x) => x.url)).toEqual(['/_boson/files/upload/t1?offset=0', '/_boson/files/upload/t1?offset=4', '/_boson/files/upload/t1?offset=8']);
    expect(seen.flatMap((x) => x.body)).toEqual([...bytes]);
  });

  it('stops at the first answer that is not "more" (a refusal part-way)', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(more()).mockResolvedValueOnce(answer(413, { error: 'quota_exceeded' }));
    const res = await sendChunks(fetchFn as unknown as typeof fetch, '/p', new Blob(['abcdefghij']), 3, new AbortController().signal);
    expect(res.status).toBe(413);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('stops sending once aborted', async () => {
    const ac = new AbortController();
    const fetchFn = vi.fn(async () => { ac.abort(); return more(); });
    await expect(sendChunks(fetchFn as unknown as typeof fetch, '/p', new Blob(['abcdefghij']), 3, ac.signal)).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('a controller upload goes in chunks and finishes', async () => {
    const { b } = bridge();
    const url = `${FILES}/f/AbCdEfGhIjKlMnOpQrStUv/a.bin`;
    const fetchFn = vi.fn().mockResolvedValueOnce(more()).mockResolvedValueOnce(more()).mockResolvedValueOnce(answer(201, { url }));
    const c = new FilesController({ bridge: b, signedIn: () => false, fetch: fetchFn as unknown as typeof fetch, doneLingerMs: 0, chunkBytes: 2 });
    await c.ensure('irc.example.org');
    const post = vi.fn();
    c.upload({ host: 'irc.example.org', channel: '#a', file: new Blob(['abcde']), name: 'a.bin', post });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith(url));
    expect(fetchFn.mock.calls.map((x) => x[0])).toEqual(['/_boson/files/upload/t1?offset=0', '/_boson/files/upload/t1?offset=2', '/_boson/files/upload/t1?offset=4']);
  });
});

describe('uploadBatch', () => {
  // A fetch whose answers the test hands out: each upload's (single) chunk
  // waits until finish(name) or failWith(name).
  function controlled() {
    const waiting = new Map<string, (r: Response) => void>();
    const started: string[] = [];
    let tickets = 0;
    const names = new Map<string, string>();
    const b = bridge({
      beginUpload: vi.fn(async (req: { name: string }) => {
        const id = `t${++tickets}`;
        names.set(id, req.name);
        return { id, path: `/_boson/files/upload/${id}` };
      }),
    }).b;
    const fetchFn = vi.fn((url: string, init: RequestInit) => new Promise<Response>((res, rej) => {
      const name = names.get(url.split('/').pop()!.split('?')[0]!)!;
      started.push(name);
      waiting.set(name, res);
      init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    }));
    const finish = (name: string) => waiting.get(name)!(answer(201, { url: `${FILES}/f/AbCdEfGhIjKlMnOpQrStUv/${name}` }));
    const failWith = (name: string) => waiting.get(name)!(answer(507, { code: 'storage_full' }));
    return { b, fetchFn, started, finish, failWith };
  }
  const url = (n: string) => `${FILES}/f/AbCdEfGhIjKlMnOpQrStUv/${n}`;
  const items = (...names: string[]) => names.map((name) => ({ file: new Blob([name]), name }));

  async function setupBatch(names: string[], opts: { caption?: string; maxTextBytes?: number } = {}) {
    const k = controlled();
    const c = new FilesController({ bridge: k.b, signedIn: () => false, fetch: k.fetchFn as unknown as typeof fetch, doneLingerMs: 0 });
    await c.ensure('irc.example.org');
    const post = vi.fn();
    const ids = c.uploadBatch({ host: 'irc.example.org', channel: '#a', items: items(...names), post, ...opts });
    return { ...k, c, post, ids };
  }

  it('runs at most 2 at once, the rest queued; posts in the listed order, not finish order', async () => {
    const { c, started, finish, post } = await setupBatch(['a', 'b', 'c', 'd'], { maxTextBytes: 10 });
    await vi.waitFor(() => expect(started).toEqual(['a', 'b']));
    expect(c.uploads.value.map((u) => u.status)).toEqual(['uploading', 'uploading', 'queued', 'queued']);
    finish('b');
    await vi.waitFor(() => expect(started).toEqual(['a', 'b', 'c']));
    expect(post).not.toHaveBeenCalled(); // b waits for a
    finish('a');
    await vi.waitFor(() => expect(post.mock.calls.map((x) => x[0])).toEqual([url('a'), url('b')]));
    await vi.waitFor(() => expect(started).toEqual(['a', 'b', 'c', 'd']));
    finish('d');
    finish('c');
    await vi.waitFor(() => expect(post.mock.calls.map((x) => x[0])).toEqual([url('a'), url('b'), url('c'), url('d')]));
  });

  it('a failed upload is skipped and shows its error; the rest still post', async () => {
    const { c, started, finish, failWith, post } = await setupBatch(['a', 'b', 'c'], { maxTextBytes: 10 });
    await vi.waitFor(() => expect(started).toEqual(['a', 'b']));
    failWith('a');
    finish('b');
    await vi.waitFor(() => expect(started).toEqual(['a', 'b', 'c']));
    finish('c');
    await vi.waitFor(() => expect(post.mock.calls.map((x) => x[0])).toEqual([url('b'), url('c')]));
    expect(c.uploads.value.find((u) => u.name === 'a')).toMatchObject({ status: 'error', errorCode: 'storage_full' });
  });

  it('the caption goes first; URLs that fit one line go together, space-separated', async () => {
    const { started, finish, post } = await setupBatch(['a', 'b', 'c'], { caption: '  holiday  pics ' });
    await vi.waitFor(() => expect(started.length).toBe(2));
    finish('a');
    finish('b');
    await vi.waitFor(() => expect(started.length).toBe(3));
    expect(post).not.toHaveBeenCalled();
    finish('c');
    await vi.waitFor(() => expect(post.mock.calls.map((x) => x[0])).toEqual(['holiday pics', `${url('a')} ${url('b')} ${url('c')}`]));
  });

  it("URLs that don't fit one line: the caption, then one URL per message", async () => {
    const { started, finish, post } = await setupBatch(['a', 'b'], { caption: 'pics', maxTextBytes: 80 });
    await vi.waitFor(() => expect(started.length).toBe(2));
    finish('a');
    await vi.waitFor(() => expect(post.mock.calls.map((x) => x[0])).toEqual(['pics', url('a')]));
    finish('b');
    await vi.waitFor(() => expect(post.mock.calls.map((x) => x[0])).toEqual(['pics', url('a'), url('b')]));
  });

  it('nothing posted, not even the caption, when every upload fails', async () => {
    const { started, failWith, post, c } = await setupBatch(['a', 'b'], { caption: 'pics' });
    await vi.waitFor(() => expect(started.length).toBe(2));
    failWith('a');
    failWith('b');
    await vi.waitFor(() => expect(c.uploads.value.every((u) => u.status === 'error')).toBe(true));
    expect(post).not.toHaveBeenCalled();
  });

  it('cancel one (queued or running) skips it; Cancel all stops the rest', async () => {
    const { c, started, finish, post, ids, b } = await setupBatch(['a', 'b', 'c', 'd', 'e'], { maxTextBytes: 10 });
    await vi.waitFor(() => expect(started).toEqual(['a', 'b']));
    c.cancel(ids[2]!); // c, queued
    c.cancel(ids[0]!); // a, running
    expect(b.cancelUpload).toHaveBeenCalledWith('t1');
    await vi.waitFor(() => expect(started).toEqual(['a', 'b', 'd']));
    finish('b');
    await vi.waitFor(() => expect(post.mock.calls.map((x) => x[0])).toEqual([url('b')]));
    await vi.waitFor(() => expect(started).toEqual(['a', 'b', 'd', 'e']));
    c.cancelAll('irc.example.org', '#a');
    expect(c.uploadsFor('irc.example.org', '#a').filter((u) => u.status !== 'done')).toHaveLength(0);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('caps a batch at MAX_BATCH_FILES', async () => {
    const { ids } = await setupBatch(Array.from({ length: 25 }, (_, i) => `f${i}`));
    expect(ids).toHaveLength(20);
  });

  it('ircTextBudget leaves room for the prefix in a 512-byte line', () => {
    expect(ircTextBudget('nick', '#chan')).toBe(512 - (1 + 4 + 1 + 10 + 1 + 63) - 9 - 5 - 2 - 2);
  });
});

describe('the home files host', () => {
  const HOME = 'https://files.boson.chat';
  function homeBridge(network: string | null = null) {
    const { b, calls } = bridge({
      discover: vi.fn(async (host: string) => ({ host, ...(network ? { filesUrl: network } : {}) })),
      home: vi.fn(async () => ({ host: 'https://auth.boson.chat', filesUrl: HOME, source: 'home' as const })),
    });
    return { b, calls };
  }

  it('a network without a files host: uploads go home, as the app account, when signed in there', async () => {
    const { b } = homeBridge();
    const fetchFn = vi.fn(async () => answer(201, { url: `${HOME}/f/AbCdEfGhIjKlMnOpQrStUv/a.txt` }));
    let signedIn = true;
    const c = new FilesController({
      bridge: b, signedIn: () => false, homeSignedIn: () => signedIn, homeToken: async () => 'home-tok',
      fetch: fetchFn as unknown as typeof fetch, doneLingerMs: 0,
    });
    await c.ensure('irc.plain.org');
    await c.ensureHome();
    expect(c.availability('irc.plain.org')).toMatchObject({ available: true, filesUrl: HOME, guest: false, home: true, label: 'boson.chat', limits: { max_file_bytes: 100e6 } });
    // Its links render inline on any network.
    expect(c.isFilesOrigin(HOME)).toBe(true);
    const post = vi.fn();
    c.upload({ host: 'irc.plain.org', channel: '#a', file: new Blob(['x']), name: 'a.txt', post });
    await vi.waitFor(() => expect(post).toHaveBeenCalled());
    expect(b.beginUpload).toHaveBeenCalledWith(expect.objectContaining({ filesUrl: HOME, auth: 'Bearer home-tok' }));
    // Signed out (or a guest): no attach button.
    signedIn = false;
    expect(c.availability('irc.plain.org').available).toBe(false);
  });

  it("the network's own files host wins", async () => {
    const { b } = homeBridge(FILES);
    const c = new FilesController({ bridge: b, signedIn: () => false, homeSignedIn: () => true, homeToken: async () => 'home-tok' });
    await c.ensure('irc.example.org');
    await c.ensureHome();
    const a = c.availability('irc.example.org');
    expect(a).toMatchObject({ available: true, filesUrl: FILES, guest: true });
    expect(a.home).toBeUndefined();
  });

  it('usage is read from the home files host with the account token', async () => {
    const { b, calls } = homeBridge();
    const c = new FilesController({ bridge: b, signedIn: () => false, homeSignedIn: () => true, homeToken: async () => 'home-tok' });
    await c.ensure('irc.plain.org');
    await c.ensureHome();
    await c.usage('irc.plain.org');
    expect(calls.find((x) => x.path === '/v1/me/usage')).toMatchObject({ filesUrl: HOME, auth: 'Bearer home-tok' });
  });
});
