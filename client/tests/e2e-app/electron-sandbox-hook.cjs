// Preloaded into the Electron MAIN process with `-r` on every e2e launch
// (fixtures.ts), ahead of the app's own main bundle. Never part of the app
// build.
//
// Keeps a test app from changing the developer's OS: an unpackaged launch
// registers itself as the boson:// handler (setAsDefaultProtocolClient),
// which on macOS points the user's real boson:// links at the stock
// Electron.app. Tests deliver deep links themselves (deliverDeepLink), so the
// registration is a no-op here.
'use strict';
const { app } = require('electron');

app.setAsDefaultProtocolClient = () => true;
app.removeAsDefaultProtocolClient = () => true;

// BOSON_E2E_HOST_MAP="name=1.2.3.4[,name2=…]" (launchApp({ env })): resolve
// those hostnames to the given IPv4 address in the main process — a test-only
// /etc/hosts. Lets a spec serve a page from a local HTTP server under a
// non-loopback NAME (the link unfurler refuses loopback hostnames). Node's
// net/fetch resolve through dns.lookup at connect time.
const hostMap = new Map(
  (process.env.BOSON_E2E_HOST_MAP || '')
    .split(',')
    .map((kv) => kv.trim().split('='))
    .filter((kv) => kv.length === 2 && kv[0] && kv[1])
    .map(([name, ip]) => [name.toLowerCase(), ip]),
);
if (hostMap.size > 0) {
  const dns = require('node:dns');
  const lookup = dns.lookup;
  dns.lookup = function e2eLookup(hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' || options == null ? {} : (typeof options === 'number' ? { family: options } : options);
    const ip = typeof hostname === 'string' ? hostMap.get(hostname.toLowerCase()) : undefined;
    if (!ip) return lookup.apply(this, arguments);
    process.nextTick(() => (opts.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4)));
    return {};
  };
}
