import { describe, it, expect, vi } from 'vitest';
import { FilesController, sendChunks, uploadMessage } from './files.service';
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
