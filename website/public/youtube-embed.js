// Hosts YouTube's player for an inline video embed (see youtube-embed.html).
// The same two files are served by the app (the e2e build's loopback
// server) and by boson.chat (website/public/), which the desktop app
// frames: YouTube refuses to play inside a wails:// or local page.
(function () {
  var q = new URLSearchParams(location.search);
  var v = q.get('v') || '';
  var t = q.get('t') || '';
  // A YouTube id is 11 characters of [A-Za-z0-9_-]; nothing else is accepted.
  if (!/^[A-Za-z0-9_-]{11}$/.test(v)) {
    document.body.textContent = 'Not a YouTube video.';
    return;
  }
  var player = 'https://www.youtube-nocookie.com';
  // enablejsapi: the player reports its errors (embedding refused, 153, …),
  // which go to the app so it can offer the video on YouTube instead.
  var src = player + '/embed/' + v +
    '?autoplay=1&rel=0&modestbranding=1&enablejsapi=1&origin=' + encodeURIComponent(location.origin);
  if (/^\d{1,6}$/.test(t)) src += '&start=' + t;
  var f = document.createElement('iframe');
  f.src = src;
  f.title = 'YouTube video player';
  f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  f.allowFullscreen = true;
  f.referrerPolicy = 'strict-origin-when-cross-origin';
  document.body.appendChild(f);

  // Only the id and a numeric error code ever go out, and only to the parent.
  function tell(msg) {
    if (parent !== window) parent.postMessage(msg, '*');
  }
  // Subscribe to the player's events (the iframe API's handshake).
  f.addEventListener('load', function () {
    f.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), player);
  });
  window.addEventListener('message', function (e) {
    if (e.origin !== player || e.source !== f.contentWindow || typeof e.data !== 'string') return;
    var d;
    try { d = JSON.parse(e.data); } catch (err) { return; }
    if (!d) return;
    if (d.event === 'onError') tell({ type: 'boson-youtube-error', v: v, code: Number(d.info) || 0 });
    // Again once the player is up, in case the first one went unheard.
    if (d.event === 'onReady') tell({ type: 'boson-youtube-ready', v: v });
  });
  // Tell the app the wrapper loaded, so it doesn't fall back to embedding
  // YouTube directly.
  tell({ type: 'boson-youtube-ready', v: v });
})();
