import { describe, it, expect } from 'vitest';
import { ChatService } from './chat.service';
import type { BouncerUpstreamState, EventListener, IrcEvent, ServerSession } from '../engine';

// ZNC refusing the network's TLS certificate: the *status bot explains, dumps
// the certificate and asks for `/znc AddTrustedServerFingerprint <sha256>`,
// then retries every few seconds. The chat surfaces that as serverInfo.bouncerCert
// so the strip can offer Trust / Don't trust.

const FP = 'da:cb:07:eb:07:c9:34:7b:47:3e:95:a3:5e:85:b6:b2:aa:96:e2:f5:a7:4c:86:40:5e:4a:ee:5b:da:32:b4:d4';

function build() {
  let listener: EventListener | null = null;
  let upstream: ((u: BouncerUpstreamState) => void) | null = null;
  const raws: string[] = [];
  const calls: string[] = [];
  const session = {
    serverId: 'srv-test',
    join: () => {}, part: () => {}, privmsg: () => {}, names: () => {}, tagmsg: () => {},
    list: () => {}, away: () => {}, nick: () => {}, nickservIdentify: () => {},
    raw: (line: string) => { raws.push(line); },
    onEvent: (fn: EventListener) => { listener = fn; return () => { listener = null; }; },
    onChannelDirectory: () => () => {},
    onServicesFramework: () => () => {},
    servicesFramework: () => null,
    onBouncerUpstream: (fn: (u: BouncerUpstreamState) => void) => { upstream = fn; return () => { upstream = null; }; },
    bouncerConnect: () => { calls.push('connect'); },
    bouncerDisconnect: () => { calls.push('disconnect'); },
  };
  const chat = new ChatService(session as unknown as ServerSession, 'Nyan', undefined, { bouncer: true });
  chat.attach();
  const status = (Message: string, From = '*status') =>
    listener?.({ Kind: 'PRIVMSG', From, Target: 'Nyan', Message, Host: 'znc.in', Raw: '' } as IrcEvent);
  const prompt = (From = '*status') => {
    status("Disconnected from IRC (Invalid SSL certificate: hostname doesn't match). Reconnecting...", From);
    status('| X509v3 Subject Alternative Name:', From);
    status(`SHA-256: ${FP}`, From);
    status(`If you trust this certificate, do /znc AddTrustedServerFingerprint ${FP}`, From);
  };
  return { chat, raws, calls, status, prompt, upstream: (u: BouncerUpstreamState) => upstream?.(u) };
}

describe('ChatService — bouncer certificate prompt', () => {
  it('surfaces the fingerprint and reason from *status', () => {
    const { chat, prompt } = build();
    prompt();
    expect(chat.getState().serverInfo.bouncerCert).toEqual({ fingerprint: FP, reason: "hostname doesn't match" });
  });

  it('works without the (translatable) reason line', () => {
    const { chat, status } = build();
    status(`Wenn du diesem Zertifikat vertraust, mache /znc AddTrustedServerFingerprint ${FP.toUpperCase()}`);
    expect(chat.getState().serverInfo.bouncerCert).toEqual({ fingerprint: FP, reason: undefined });
  });

  it('ignores the same text from anyone but the status bot', () => {
    const { chat, status } = build();
    status(`do /znc AddTrustedServerFingerprint ${FP}`, 'mallory');
    expect(chat.getState().serverInfo.bouncerCert).toBeUndefined();
  });

  it('Trust pins the fingerprint via the status bot, then connects', () => {
    const { chat, raws, calls, prompt } = build();
    prompt('~status');
    chat.trustBouncerCert();
    expect(raws).toEqual([`PRIVMSG ~status :AddTrustedServerFingerprint ${FP}`]);
    expect(calls).toEqual(['connect']);
    expect(chat.getState().serverInfo.bouncerCert).toBeUndefined();
  });

  it("Don't trust stops the bouncer's reconnect loop", () => {
    const { chat, raws, calls, prompt } = build();
    prompt();
    chat.rejectBouncerCert();
    expect(raws).toEqual([]);
    expect(calls).toEqual(['disconnect']);
    expect(chat.getState().serverInfo.bouncerCert).toBeUndefined();
  });

  it('clears once the upstream connects', () => {
    const { chat, prompt, upstream } = build();
    prompt();
    upstream('connecting');
    expect(chat.getState().serverInfo.bouncerCert).toBeDefined();
    upstream('connected');
    expect(chat.getState().serverInfo.bouncerCert).toBeUndefined();
  });
});
