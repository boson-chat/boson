// Tiny inline markdown tokenizer aimed at chat-message rendering.
// Supports: **bold**, __bold__, *italic*, _italic_, ~~strike~~, `code`,
// ```fenced code```, and bare http(s) URLs → links.
//
// Trade-offs vs a full markdown lib:
//   - No nesting (e.g. **bold *italic***); the outer pattern wins.
//   - Heuristic matching — `5 * 4 * 3` will get parsed as italic. Acceptable
//     for chat, where prose with literal asterisks is rare.
//   - Code spans/blocks are not mention-scanned (literal content).

export type MdToken =
  | { type: 'text'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'italic'; value: string }
  | { type: 'strike'; value: string }
  | { type: 'code'; value: string }
  | { type: 'codeblock'; value: string }
  | { type: 'link'; value: string }
  // `||spoiler||` — hidden until clicked. value = the hidden text.
  | { type: 'spoiler'; value: string }
  // `:shortcode:` — value is the shortcode; the renderer resolves it to an
  // emoji char (or renders it literally when unknown).
  | { type: 'emoji'; value: string };

export function tokenizeMarkdown(text: string): MdToken[] {
  const out: MdToken[] = [];
  let i = 0;

  while (i < text.length) {
    const rest = text.slice(i);

    // Fenced code block: ```...```  (DOTALL via [\s\S])
    const fence = /^```([\s\S]*?)```/.exec(rest);
    if (fence) {
      pushText(out);
      out.push({ type: 'codeblock', value: fence[1] ?? '' });
      i += fence[0].length;
      continue;
    }

    // Inline code: `...`
    const code = /^`([^`\n]+)`/.exec(rest);
    if (code) {
      pushText(out);
      out.push({ type: 'code', value: code[1] ?? '' });
      i += code[0].length;
      continue;
    }

    // Bold: **...** or __...__
    const bold = /^\*\*([^*\n]+)\*\*|^__([^_\n]+)__/.exec(rest);
    if (bold) {
      pushText(out);
      out.push({ type: 'bold', value: (bold[1] ?? bold[2]) as string });
      i += bold[0].length;
      continue;
    }

    // Italic: *...* or _..._
    const italic = /^\*([^*\n]+)\*|^_([^_\s][^_\n]*[^_\s]|[^_\s])_/.exec(rest);
    if (italic) {
      pushText(out);
      out.push({ type: 'italic', value: (italic[1] ?? italic[2]) as string });
      i += italic[0].length;
      continue;
    }

    // Strike: ~~...~~
    const strike = /^~~([^~\n]+)~~/.exec(rest);
    if (strike) {
      pushText(out);
      out.push({ type: 'strike', value: strike[1] ?? '' });
      i += strike[0].length;
      continue;
    }

    // Spoiler: ||...||
    const spoiler = /^\|\|([^\n]+?)\|\|/.exec(rest);
    if (spoiler) {
      pushText(out);
      out.push({ type: 'spoiler', value: spoiler[1] ?? '' });
      i += spoiler[0].length;
      continue;
    }

    // URL (checked before emoji so `https:` isn't mis-split on the colon).
    const url = /^https?:\/\/[^\s<>"')]+/i.exec(rest);
    if (url) {
      pushText(out);
      out.push({ type: 'link', value: url[0] });
      i += url[0].length;
      continue;
    }

    // Emoji shortcode: :smile: — require at least one letter so clock-style
    // times like 09:52:54 don't get eaten.
    const emoji = /^:([a-z0-9_+-]*[a-z][a-z0-9_+-]*):/i.exec(rest);
    if (emoji) {
      pushText(out);
      out.push({ type: 'emoji', value: (emoji[1] ?? '').toLowerCase() });
      i += emoji[0].length;
      continue;
    }

    // No special token at this position — consume one char into the pending text.
    // (We push to the last 'text' token if there is one, otherwise create one.)
    appendChar(out, rest[0]!);
    i += 1;
  }

  return out;

  // ---- helpers ----
  function pushText(_target: MdToken[]): void {
    /* no-op; text accumulation handled by appendChar */
  }
  function appendChar(target: MdToken[], ch: string): void {
    const last = target[target.length - 1];
    if (last && last.type === 'text') {
      last.value += ch;
    } else {
      target.push({ type: 'text', value: ch });
    }
  }
}

// Whether a whole message line should render as preformatted (monospace, with
// preserved whitespace) — box-drawing tables, markdown pipe-tables, and their
// separator rows. message-render groups consecutive such lines from the same
// sender into a single aligned block so a pasted table isn't broken up by
// timestamps or proportional-font misalignment.
const BOX_DRAWING_RE = /[─-╿]/; // ─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼ …
export function isPreformattedLine(text: string): boolean {
  if (BOX_DRAWING_RE.test(text)) return true;
  const t = text.trim();
  if (t.length < 3) return false;
  // Markdown table separator: |---|:--:|  (dashes + optional colons + pipes).
  if (/^\|?[\s:|-]*-{3,}[\s:|-]*\|?$/.test(t) && t.includes('-')) return true;
  // Pipe-table row: starts and ends with a pipe and has at least one interior pipe.
  if (/^\|.*\|.*\|$/.test(t)) return true;
  return false;
}
