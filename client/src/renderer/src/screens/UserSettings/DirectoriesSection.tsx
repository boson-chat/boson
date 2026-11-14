import { useEffect, useState } from 'preact/hooks';
import { Badge, Button, Card, Field, Input, Toggle } from '@boson/shared';
import {
  DirectoryCheckError,
  getDirectorySources,
  MAX_DIRECTORIES,
  type DirectorySource,
  type DirectorySources,
} from '../../modules/directory/sources';

// Settings → Directories: the network directories the server browser lists
// from. The default one (directory.boson.chat) can be switched off but not
// removed; others are added by address and checked first.
export function DirectoriesSection({ sources = getDirectorySources() }: { sources?: DirectorySources }) {
  const [list, setList] = useState<DirectorySource[]>(() => sources.list());
  useEffect(() => {
    setList(sources.list());
    return sources.subscribe((l) => setList([...l]));
  }, [sources]);

  const [address, setAddress] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const full = list.length >= MAX_DIRECTORIES;

  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (checking || !address.trim()) return;
    setChecking(true);
    setError(null);
    setAdded(null);
    try {
      const src = await sources.add(address);
      setAddress('');
      setAdded(src.name);
    } catch (err) {
      setError(err instanceof DirectoryCheckError ? err.message : 'Couldn’t add that directory.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <section class="user-settings-section">
      <div class="user-settings-section-head">
        <h2 class="user-settings-section-title">Directories</h2>
        <p class="user-settings-section-desc">
          The server browser lists networks from these directories and merges them, one card per
          server. Add a community’s or your own stack’s directory by its address.
        </p>
      </div>
      <div class="user-settings-section-body">
        <Card>
          <ul class="directories-list" aria-label="Your directories">
            {list.map((d) => (
              <li key={d.url} class={`directories-row ${d.enabled ? '' : 'directories-row-off'}`}>
                <div class="directories-row-titles">
                  <span class="directories-row-name">
                    {d.name}
                    {d.isDefault && <Badge tone="info">Default</Badge>}
                  </span>
                  <span class="directories-row-host">{new URL(d.url).host}</span>
                  {d.operator && <span class="directories-row-operator">Run by {d.operator}</span>}
                </div>
                <div class="directories-row-actions">
                  <Toggle
                    checked={d.enabled}
                    onChange={(v) => sources.setEnabled(d.url, v)}
                    label={d.enabled ? 'On' : 'Off'}
                  />
                  {!d.isDefault && (
                    <Button variant="ghost" onClick={() => sources.remove(d.url)} aria-label={`Remove ${d.name}`}>
                      Remove
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <form class="user-settings-card-body user-settings-form" onSubmit={(e) => { void submit(e); }}>
            <Field
              label="Add a directory"
              hint="Its address, like directory.example.org. Boson checks it’s a directory before adding it."
            >
              <Input
                value={address}
                onInput={(e) => { setAddress((e.target as HTMLInputElement).value); setError(null); }}
                placeholder="directory.example.org"
                autoComplete="off"
                spellcheck={false}
                disabled={full}
                invalid={!!error}
              />
            </Field>
            {error && <p class="user-settings-error" role="alert">{error}</p>}
            {full && <p class="user-settings-hint">You’ve reached {MAX_DIRECTORIES} directories. Remove one to add another.</p>}
            <div class="user-settings-form-actions">
              {added && <span class="user-settings-saved">Added {added}</span>}
              <Button type="submit" variant="primary" disabled={full || checking || !address.trim()} loading={checking}>
                {checking ? 'Checking…' : 'Add directory'}
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </section>
  );
}
