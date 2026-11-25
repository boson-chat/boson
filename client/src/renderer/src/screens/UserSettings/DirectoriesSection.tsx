import { useEffect, useState } from 'preact/hooks';
import { Badge, Button, Field, Input, ListRow, Toggle } from '@boson/shared';
import {
  DirectoryCheckError,
  getDirectorySources,
  MAX_DIRECTORIES,
  type DirectorySource,
  type DirectorySources,
} from '../../modules/directory/sources';
import { SectionFrame, SettingsGroup } from './SettingsFrame';

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
    <SectionFrame
      title="Directories"
      description="The server browser lists networks from these directories, merged into one card per server."
    >
      <SettingsGroup title="Your directories">
        <ul class="settings-rows settings-rows-switch" aria-label="Your directories">
          {list.map((d) => (
            <ListRow
              key={d.url}
              as="li"
              class={d.enabled ? undefined : 'settings-row-off'}
              title={d.name}
              meta={d.isDefault ? <Badge tone="info">Default</Badge> : undefined}
              subtitle={new URL(d.url).host}
              // The switch is always last, so the switches line up whether
              // or not a row can be removed.
              trailing={<>
                {!d.isDefault && (
                  <Button variant="ghost" size="sm" onClick={() => sources.remove(d.url)} aria-label={`Remove ${d.name}`}>
                    Remove
                  </Button>
                )}
                <Toggle
                  checked={d.enabled}
                  onChange={(v) => sources.setEnabled(d.url, v)}
                  ariaLabel={`List servers from ${d.name}`}
                />
              </>}
            >
              {d.operator && <span class="settings-row-note">Run by {d.operator}</span>}
            </ListRow>
          ))}
        </ul>
      </SettingsGroup>
      <SettingsGroup>
        <form class="user-settings-form" onSubmit={(e) => { void submit(e); }}>
          <Field
            label="Add a directory"
            hint="Its address, like directory.example.org: a community’s or your own stack’s. Boson checks it’s a directory before adding it."
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
      </SettingsGroup>
    </SectionFrame>
  );
}
