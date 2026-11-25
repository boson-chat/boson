import { Fragment, type ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { ChevronRight, type LucideIcon } from 'lucide-preact';
import { Input, ListRow } from '@boson/shared';
import './settings.css';

// How every settings screen (User settings, Server settings) finds its way
// around, so they read as one system:
//
//   desktop  SettingsMenu: a left menu of the sections, under small group
//            headings (a group with no title sits under a rule)
//   phones   SettingsPhoneList: the same sections as a page, each row with
//            an icon, what it's set to now and a chevron; a row opens its
//            section full screen under a page header with "Back to settings"
//
// Both are built from one list of entries in their groups.

export interface SettingsEntry<Id extends string = string, Group extends string = string> {
  id: Id;
  label: string;
  group: Group;
  /** Words for the phone list's search: the section's settings. */
  keywords?: string;
}

/** The phone header's back button, on every settings section. */
export const BACK_TO_SETTINGS = 'Back to settings';

export function SettingsMenu<Id extends string, Group extends string>({
  entries, groupTitle, headings = true, selected, onSelect, class: extra, label = 'Settings sections',
}: {
  entries: ReadonlyArray<SettingsEntry<Id, Group>>;
  /** A group's heading; null puts the group under a rule instead. */
  groupTitle: (group: Group) => string | null;
  /** False: one plain run of entries (too few to group). */
  headings?: boolean;
  selected: Id;
  onSelect: (id: Id) => void;
  class?: string;
  label?: string;
}) {
  return (
    <nav class={extra} aria-label={label}>
      {entries.map((m, i) => {
        // A group's heading (or rule) before its first entry: siblings of
        // the entries, not wrappers.
        const first = i === 0 || entries[i - 1]!.group !== m.group;
        const heading = groupTitle(m.group);
        return (
          <Fragment key={m.id}>
            {first && headings && (heading
              ? <span class="settings-menu-heading" aria-hidden="true">{heading}</span>
              : <span class="settings-menu-rule" aria-hidden="true" />)}
            <ListRow
              variant="nav"
              title={m.label}
              selected={selected === m.id}
              onClick={() => onSelect(m.id)}
              mainProps={{ role: 'tab', 'aria-selected': selected === m.id }}
            />
          </Fragment>
        );
      })}
    </nav>
  );
}

export function SettingsPhoneList<Id extends string, Group extends string>({
  entries, groupTitle, icon, hint, onOpen, header, searchFrom = 5, searchLabel = 'Search settings', label = 'Settings sections', class: extra,
}: {
  entries: ReadonlyArray<SettingsEntry<Id, Group>>;
  groupTitle: (group: Group) => string | null;
  icon: (id: Id) => LucideIcon;
  /** What the section is set to now, in a few words ('' for nothing). */
  hint: (id: Id) => string;
  onOpen: (id: Id) => void;
  /** Above the rows while not searching (User settings' profile card). */
  header?: ComponentChildren;
  /** Show the search box from this many entries. */
  searchFrom?: number;
  searchLabel?: string;
  label?: string;
  class?: string;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = q
    ? entries.filter((m) => `${m.label} ${hint(m.id)} ${m.keywords ?? ''}`.toLowerCase().includes(q))
    : entries;
  return (
    <div class={`settings-phone-list${extra ? ` ${extra}` : ''}`}>
      {entries.length >= searchFrom && (
        <div class="settings-phone-search">
          <Input
            type="search"
            value={query}
            placeholder={searchLabel}
            aria-label={searchLabel}
            autoComplete="off"
            spellcheck={false}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
        </div>
      )}
      {!q && header}
      {shown.length === 0 && <p class="settings-phone-empty">No settings match “{query.trim()}”.</p>}
      <nav aria-label={label}>
        {shown.map((m, i) => {
          const first = i === 0 || shown[i - 1]!.group !== m.group;
          const heading = groupTitle(m.group);
          const Icon = icon(m.id);
          const sub = hint(m.id);
          return (
            <div key={m.id} class="settings-phone-item">
              {first && heading && entries.length > 2 && (
                <div class="settings-phone-heading" aria-hidden="true">{heading}</div>
              )}
              <SettingsPhoneRow
                leading={<Icon size={16} aria-hidden="true" />}
                title={m.label}
                subtitle={sub}
                onClick={() => onOpen(m.id)}
              />
            </div>
          );
        })}
      </nav>
    </div>
  );
}

// One row of the phone list: My space's phone nav row (lg, 56px+), the
// hint under the name, a chevron. Also the base of User settings' profile
// card and the Advanced section's command groups.
export function SettingsPhoneRow({ leading, title, subtitle, ariaLabel, onClick, class: extra }: {
  leading?: ComponentChildren;
  title: string;
  subtitle?: string;
  ariaLabel?: string;
  onClick: () => void;
  class?: string;
}) {
  return (
    <ListRow
      variant="nav"
      size="lg"
      class={`settings-phone-row${extra ? ` ${extra}` : ''}`}
      leading={leading}
      title={title}
      subtitle={subtitle || undefined}
      ariaLabel={ariaLabel ?? (subtitle ? `${title}: ${subtitle}` : title)}
      trailing={<ChevronRight size={16} aria-hidden="true" class="settings-phone-chevron" />}
      onClick={onClick}
    />
  );
}
