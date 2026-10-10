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
