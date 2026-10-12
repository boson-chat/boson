// Hosts YouTube's player for an inline video embed (see youtube-embed.html).
(function () {
  var q = new URLSearchParams(location.search);
  var v = q.get('v') || '';
  var t = q.get('t') || '';
  // A YouTube id is 11 characters of [A-Za-z0-9_-]; nothing else is accepted.
  if (!/^[A-Za-z0-9_-]{11}$/.test(v)) {
    document.body.textContent = 'Not a YouTube video.';
    return;
  }
  var src = 'https://www.youtube-nocookie.com/embed/' + v +
    '?autoplay=1&rel=0&modestbranding=1&origin=' + encodeURIComponent(location.origin);
  if (/^\d{1,6}$/.test(t)) src += '&start=' + t;
  var f = document.createElement('iframe');
  f.src = src;
  f.title = 'YouTube video player';
  f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  f.allowFullscreen = true;
  f.referrerPolicy = 'strict-origin-when-cross-origin';
  document.body.appendChild(f);
  // Tell the app the wrapper loaded, so it doesn't fall back to embedding
  // YouTube directly. Only the id goes out, and only to the parent.
  if (parent !== window) parent.postMessage({ type: 'boson-youtube-ready', v: v }, '*');
})();
