// Parse ASCII-art framed banners, the way release and announcement bots draw
// them, one IRC line per row:
//
//    ______________________________
//   |   New TV Release: Some.Show  |
//    ¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯
//
// into the text each frame holds, so the renderer can show a card instead of
// art that a proportional font, or a narrow window, mangles. A block may hold
// several banners back to back. Returns null unless every non-blank line is a
// rule or a framed line and there is at least one framed line (the caller
// then falls back to monospace). Expects formatting codes already stripped.
// Pure.

export interface Banner {
  lines: string[];
}

const RULE_RE = /^([_¯=~*#-])\1{3,}$/;
const FRAMED_RE = /^\|(.*\S.*)\|$/;

export function parseBanners(text: string): Banner[] | null {
  const banners: Banner[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length) banners.push({ lines: current });
    current = [];
  };
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (!t) { flush(); continue; }
    if (RULE_RE.test(t)) { flush(); continue; }
    const m = FRAMED_RE.exec(t);
    if (!m) return null;
    current.push(m[1]!.trim());
  }
  flush();
  return banners.length ? banners : null;
}

// "New TV Release: Some.Show" → label + value, for a short leading label.
export function splitBannerLine(line: string): { label: string; value: string } | null {
  const m = /^([^:]{1,40}?):\s+(\S.*)$/.exec(line);
  return m ? { label: m[1]!.trim(), value: m[2]! } : null;
}
