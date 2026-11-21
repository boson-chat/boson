// The web app's SSO return page (platform/web/sso.ts): hands the auth
// service's one-time code (or error) back to the app tab and closes.
(function () {
  var q = new URLSearchParams(location.search);
  var msg = { s: q.get('s') || '', code: q.get('code') || undefined, error: q.get('error') || undefined, errorDescription: q.get('error_description') || undefined };
  try { new BroadcastChannel('boson-sso').postMessage(msg); } catch (e) { /* no BroadcastChannel */ }
  try { if (window.opener) window.opener.postMessage(msg, location.origin); } catch (e) { /* opener gone */ }
  setTimeout(function () {
    window.close();
    var el = document.getElementById('msg');
    if (el) el.textContent = 'You can close this window and go back to Boson.';
  }, 300);
})();
