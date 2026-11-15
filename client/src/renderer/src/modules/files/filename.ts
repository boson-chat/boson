// The filename the user gives an upload: it's the X-Filename sent and the
// last part of the file's URL, so it's cleaned up first.
//
//   - no path: only what follows the last / or \
//   - no control characters or <>:"|?* (unsafe on some systems, or in URLs)
//   - runs of whitespace become one space; no leading dots (hidden files) and
//     no trailing dots or spaces (Windows drops them)
//   - the extension is kept: a name typed without one gets the original's
//     (renaming "IMG_0042.jpg" to "beach" uploads "beach.jpg"); a different
//     extension the user typed is theirs
//   - Windows' reserved device names (CON, NUL, COM1…) get a leading "_"
//   - at most MAX_NAME characters, cut from the stem, never the extension
//   - nothing left: the original name, cleaned the same way, else "file"

export const MAX_NAME = 120;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f<>:"|?*]/g;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

// "photo.tar.gz" → ["photo.tar", ".gz"]; ".bashrc" and "README" have none.
export function splitExt(name: string): [string, string] {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return [name, ''];
  const ext = name.slice(i);
  if (!/^\.[\p{L}\p{N}_-]{1,12}$/u.test(ext)) return [name, ''];
  return [name.slice(0, i), ext];
}

function clean(raw: string): string {
  let s = raw.replace(/^.*[/\\]/, '');
  s = s.replace(UNSAFE, '').replace(/\s+/g, ' ');
  s = s.trim().replace(/^\.+/, '').replace(/[. ]+$/, '').trim();
  return s;
}

export function sanitizeFilename(input: string, original = ''): string {
  const fallback = clean(original);
  let name = clean(input);
  if (!name) name = fallback || 'file';
  let [stem, ext] = splitExt(name);
  if (!ext) {
    const [, origExt] = splitExt(fallback);
    ext = origExt;
  }
  if (RESERVED.test(stem)) stem = `_${stem}`;
  const room = Math.max(1, MAX_NAME - ext.length);
  const chars = Array.from(stem);
  if (chars.length > room) stem = chars.slice(0, room).join('').trimEnd();
  return `${stem}${ext}`;
}
