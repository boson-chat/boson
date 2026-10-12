import { useEffect, useRef, useState } from 'preact/hooks';
import { Badge, Button, Card, Input, useTransientFlag } from '@boson/shared';
import {
  THEME_TOKENS, getThemeStore, isThemeColor, parseTheme, serializeTheme,
  type Theme, type ThemeEntry, type ThemeState, type ThemeToken,
} from '../../modules/ui/theme';
import { nickColor } from '../../modules/chat/nick-color';
import './AppearancePanel.css';

// Settings → Appearance: pick a theme, or make / edit your own with live
// preview. In the desktop app custom themes are also plain JSON files in the
// themes folder (Open themes folder), re-applied as soon as they're saved.

function useThemeState(): ThemeState {
  const store = getThemeStore();
  const [state, setState] = useState<ThemeState>(() => store.getState());
  useEffect(() => store.subscribe(() => setState(store.getState())), [store]);
  return state;
}

interface Editing {
  // The custom theme being edited; undefined for a new one.
  id?: string;
  draft: Theme;
}

export function AppearancePanel() {
  const store = getThemeStore();
  const state = useThemeState();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [notice, setNotice] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [copied, flashCopied] = useTransientFlag();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const active = state.themes.find((t) => t.id === state.activeId) ?? state.themes[0]!;

  // Leaving the panel mid-edit (closing settings) drops the preview.
  useEffect(() => () => store.setPreview(null), [store]);

  const customize = (entry: ThemeEntry): void => {
    setNotice(null);
    setEditing(entry.builtin
      ? { draft: { ...entry.theme, name: `${entry.theme.name} (custom)`, colors: { ...entry.theme.colors } } }
      : { id: entry.id, draft: { ...entry.theme, colors: { ...entry.theme.colors } } });
  };

  const importFile = async (file: File): Promise<void> => {
    const r = parseTheme(await file.text(), file.name.replace(/\.json$/i, ''));
    if (!r.ok) {
      setNotice({ tone: 'error', text: `Couldn't import ${file.name}: ${r.error}` });
      return;
    }
    try {
      await store.save(r.theme);
      setNotice(r.warnings.length
        ? { tone: 'info', text: `Imported "${r.theme.name}". ${r.warnings.join(' ')}` }
        : { tone: 'info', text: `Imported "${r.theme.name}".` });
    } catch (err) {
      setNotice({ tone: 'error', text: `Couldn't save the theme: ${(err as Error).message}` });
    }
  };

  if (editing) {
    return (
      <ThemeEditor
        editing={editing}
        onCancel={() => { store.setPreview(null); setEditing(null); }}
        onSaved={() => setEditing(null)}
      />
    );
  }

  return (
    <div class="appearance">
      <Card>
        <div class="user-settings-card-body">
          <div class="appearance-grid" role="radiogroup" aria-label="Theme">
            {state.themes.map((entry) => (
              <ThemeTile
                key={entry.id}
                entry={entry}
                selected={entry.id === state.activeId}
                onSelect={() => { setConfirmDelete(false); store.setActive(entry.id); }}
              />
            ))}
          </div>
          <div class="appearance-actions">
            <Button size="sm" variant="secondary" onClick={() => customize(active)}>
              {active.builtin ? `Customize ${active.theme.name}` : `Edit ${active.theme.name}`}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => fileInput.current?.click()}>Import JSON…</Button>
            {state.hasFolder && (
              <Button size="sm" variant="ghost" onClick={() => {
                store.openFolder().catch((err: Error) => setNotice({ tone: 'error', text: `Couldn't open the themes folder: ${err.message}` }));
              }}>
                Open themes folder
              </Button>
            )}
            {!active.builtin && (
              <>
                <Button size="sm" variant="ghost" onClick={() => {
                  void navigator.clipboard?.writeText(serializeTheme(active.theme)).then(flashCopied);
                }}>
                  {copied ? 'Copied' : 'Copy JSON'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
                  Delete
                </Button>
              </>
            )}
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              hidden
              data-testid="theme-import"
              onChange={(e) => {
                const input = e.currentTarget;
                const file = input.files?.[0];
                input.value = '';
                if (file) void importFile(file);
              }}
            />
          </div>
          {confirmDelete && !active.builtin && (
            <div class="appearance-confirm" role="alertdialog" aria-label="Delete theme">
              <span>Delete "{active.theme.name}"? {state.hasFolder ? 'Its file is removed from the themes folder.' : ''}</span>
              <Button size="sm" variant="secondary" onClick={() => {
                setConfirmDelete(false);
                store.remove(active.id).catch((err: Error) => setNotice({ tone: 'error', text: `Couldn't delete: ${err.message}` }));
              }}>
                Delete theme
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>Keep</Button>
            </div>
          )}
          {notice && (
            <p class={`appearance-notice appearance-notice-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
              {notice.text}
            </p>
          )}
          {state.fileErrors.length > 0 && (
            <ul class="appearance-file-errors" aria-label="Theme files with errors">
              {state.fileErrors.map((e) => (
                <li key={e.id}><code>{e.id}.json</code> — {e.error}</li>
              ))}
            </ul>
          )}
          {state.hasFolder && (
            <p class="appearance-hint">
              Custom themes are JSON files in the themes folder. Edit one in any editor and it updates here as soon as you save.
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}

function ThemeTile({ entry, selected, onSelect }: { entry: ThemeEntry; selected: boolean; onSelect: () => void }) {
  const c = entry.theme.colors;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      class={`appearance-tile ${selected ? 'appearance-tile-selected' : ''}`}
      onClick={onSelect}
    >
      <span class="appearance-swatch" style={{ background: c.bg, borderColor: c.border }} aria-hidden="true">
        <span class="appearance-swatch-side" style={{ background: c.surface, borderColor: c['border-soft'] }}>
          <span style={{ background: c['fg-3'] }} />
          <span style={{ background: c.accent }} />
          <span style={{ background: c['fg-3'] }} />
        </span>
        <span class="appearance-swatch-main">
          <span style={{ background: c.fg, width: '70%' }} />
          <span style={{ background: c['fg-2'], width: '50%' }} />
          <span style={{ background: c['fg-2'], width: '62%' }} />
          <span class="appearance-swatch-input" style={{ background: c['surface-raised'], borderColor: c.border }} />
        </span>
      </span>
      <span class="appearance-tile-label">
        <span class="appearance-tile-name">{entry.theme.name}</span>
        {!entry.builtin && <Badge tone="info">Custom</Badge>}
      </span>
    </button>
  );
}

// A colour input only takes #rrggbb; turn any CSS colour into that for the
// swatch (the text box keeps whatever the user wrote).
function toHex(value: string): string {
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${[...v.slice(1)].map((ch) => ch + ch).join('')}`.toLowerCase();
  if (/^#[0-9a-f]{8}$/i.test(v)) return v.slice(0, 7).toLowerCase();
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#000000';
      ctx.fillStyle = v;
      const out = String(ctx.fillStyle);
      if (/^#[0-9a-f]{6}$/i.test(out)) return out;
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(out);
      if (m) return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
    }
  } catch { /* no canvas */ }
  return '#000000';
}

const GROUPS = [...new Set(THEME_TOKENS.map((t) => t.group))];

function ThemeEditor({ editing, onCancel, onSaved }: { editing: Editing; onCancel: () => void; onSaved: () => void }) {
  const store = getThemeStore();
  const [draft, setDraft] = useState<Theme>(editing.draft);
  // What's typed in each colour box, valid or not; only valid values reach the draft.
  const [text, setText] = useState<Record<ThemeToken, string>>(() => ({ ...editing.draft.colors }));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { store.setPreview(draft); }, [store, draft]);

  const setColor = (key: ThemeToken, value: string): void => {
    setText((t) => ({ ...t, [key]: value }));
    if (isThemeColor(value)) setDraft((d) => ({ ...d, colors: { ...d.colors, [key]: value.trim() } }));
  };

  const invalid = THEME_TOKENS.filter((t) => !isThemeColor(text[t.key]));
  const name = draft.name.trim();

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await store.save({ ...draft, name }, editing.id);
      onSaved();
    } catch (err) {
      setError(`Couldn't save: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="appearance">
      <Card>
        <form
          class="user-settings-card-body appearance-editor"
          onSubmit={(e) => { e.preventDefault(); void save(); }}
          aria-label="Theme editor"
        >
          <div class="appearance-editor-head">
            <label class="appearance-field">
              <span>Name</span>
              <Input
                inputSize="sm"
                value={draft.name}
                maxLength={60}
                onInput={(e) => setDraft((d) => ({ ...d, name: e.currentTarget.value }))}
                invalid={!name}
              />
            </label>
            <fieldset class="appearance-base">
              <legend>Base</legend>
              {(['dark', 'light'] as const).map((b) => (
                <label key={b}>
                  <input
                    type="radio"
                    name="theme-base"
                    checked={draft.base === b}
                    onChange={() => setDraft((d) => ({ ...d, base: b }))}
                  />
                  {b === 'dark' ? 'Dark' : 'Light'}
                </label>
              ))}
            </fieldset>
          </div>

          {GROUPS.map((group) => (
            <fieldset key={group} class="appearance-group">
              <legend>{group}</legend>
              {THEME_TOKENS.filter((t) => t.group === group).map((t) => {
                const bad = !isThemeColor(text[t.key]);
                return (
                  <div key={t.key} class="appearance-color">
                    <input
                      type="color"
                      class="appearance-color-swatch"
                      aria-label={`${t.label} colour picker`}
                      value={toHex(draft.colors[t.key])}
                      onInput={(e) => setColor(t.key, e.currentTarget.value)}
                    />
                    <span class="appearance-color-label">{t.label}</span>
                    <Input
                      inputSize="sm"
                      aria-label={t.label}
                      value={text[t.key]}
                      invalid={bad}
                      spellcheck={false}
                      onInput={(e) => setColor(t.key, e.currentTarget.value)}
                    />
                  </div>
                );
              })}
            </fieldset>
          ))}

          <fieldset class="appearance-group">
            <legend>Nick colours</legend>
            {(['saturation', 'lightness'] as const).map((k) => (
              <label key={k} class="appearance-range">
                <span>{k === 'saturation' ? 'Saturation' : 'Lightness'}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={draft.nick[k]}
                  onInput={(e) => {
                    const v = Number(e.currentTarget.value);
                    setDraft((d) => ({ ...d, nick: { ...d.nick, [k]: v } }));
                  }}
                />
                <span class="appearance-range-value">{draft.nick[k]}%</span>
              </label>
            ))}
            <div class="appearance-nicks" aria-hidden="true">
              {['alice', 'bob', 'carol', 'dmitri', 'eve'].map((n) => (
                // The draft is previewed on <html>, so nickColor's vars are the draft's.
                <span key={n} style={{ color: nickColor(n) }}>{n}</span>
              ))}
            </div>
          </fieldset>

          {invalid.length > 0 && (
            <p class="appearance-notice appearance-notice-error" role="alert">
              Not a colour: {invalid.map((t) => t.label).join(', ')}. Use #hex, rgb(), hsl(), oklch() or a colour name.
            </p>
          )}
          {error && <p class="appearance-notice appearance-notice-error" role="alert">{error}</p>}

          <div class="appearance-actions">
            <Button size="sm" type="submit" disabled={!name || invalid.length > 0} loading={saving}>
              {editing.id ? 'Save theme' : 'Save as new theme'}
            </Button>
            <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
