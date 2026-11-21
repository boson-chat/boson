import { describe, expect, it } from 'vitest';
import { gatewayUrl } from './config';
import { joinUrlFromLocation } from './deep-link';

describe('web config', () => {
  it('turns the gateway URL into a WebSocket URL on this origin by default', () => {
    const loc = new URL('https://chat.example.org/some/path') as unknown as Location;
    expect(gatewayUrl({}, loc)).toBe('wss://chat.example.org/webirc/websocket/');
    expect(gatewayUrl({ gatewayUrl: 'https://gw.example.org/webirc/websocket/' }, loc)).toBe('wss://gw.example.org/webirc/websocket/');
    expect(gatewayUrl({ gatewayUrl: 'ws://127.0.0.1:18801/webirc/websocket/' }, loc)).toBe('ws://127.0.0.1:18801/webirc/websocket/');
    const plain = new URL('http://127.0.0.1:18800/') as unknown as Location;
    expect(gatewayUrl({}, plain)).toBe('ws://127.0.0.1:18800/webirc/websocket/');
  });
});

describe('web deep links', () => {
  it('reads a boson://join link from ?join= or /join?host=', () => {
    expect(joinUrlFromLocation({ pathname: '/', search: '?join=' + encodeURIComponent('boson://join?host=irc.x&port=6697&tls=1') }))
      .toBe('boson://join?host=irc.x&port=6697&tls=1');
    expect(joinUrlFromLocation({ pathname: '/join', search: '?host=irc.x&port=6697&tls=1&name=X&evil=1' }))
      .toBe('boson://join?host=irc.x&port=6697&tls=1&name=X');
    expect(joinUrlFromLocation({ pathname: '/', search: '?join=https://evil' })).toBeNull();
    expect(joinUrlFromLocation({ pathname: '/', search: '' })).toBeNull();
    expect(joinUrlFromLocation({ pathname: '/join', search: '' })).toBeNull();
  });
});
