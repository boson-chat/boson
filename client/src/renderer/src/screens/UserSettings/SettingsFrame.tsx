import type { ComponentChildren } from 'preact';

// The building blocks every User settings section is made of, so they all
// read the same way:
//
//   SectionFrame   the section's title and one-line description
//   SettingsGroup  a small mono heading over a run of related rows
//   SettingRow     a row with a title + description on the left and an
//                  action (a button, a badge, a picker) on the right — the
//                  non-switch sibling of the design system's SwitchRow
//   DetailRow      a read-only "LABEL  value" line (About)
//
// Booleans are always SwitchRows; text a person types is saved with a
// button; everything else (switches, pickers) applies at once.

interface SectionFrameProps { title: string; description?: ComponentChildren; children: ComponentChildren }
export function SectionFrame({ title, description, children }: SectionFrameProps) {
  return (
    <section class="user-settings-section">
      <div class="user-settings-section-head">
        <h2 class="user-settings-section-title">{title}</h2>
        {description && <p class="user-settings-section-desc">{description}</p>}
      </div>
      <div class="user-settings-section-body">{children}</div>
    </section>
  );
}

interface SettingsGroupProps {
  title?: string;
  /** A line under the heading, before the rows. */
  description?: ComponentChildren;
  children: ComponentChildren;
  class?: string;
}
export function SettingsGroup({ title, description, children, class: extra }: SettingsGroupProps) {
  return (
    <div class={`user-settings-group${extra ? ` ${extra}` : ''}`}>
      {title && <h3 class="user-settings-group-title">{title}</h3>}
      {description && <p class="user-settings-group-desc">{description}</p>}
      <div class="user-settings-group-body">{children}</div>
    </div>
  );
}

// Rows that only make sense under another switch: indented under it, and
// switched off (dimmed, not clickable) while it's off.
export function NestedSettings({ disabled, children }: { disabled?: boolean; children: ComponentChildren }) {
  return (
    <div class={`user-settings-nested${disabled ? ' user-settings-nested-off' : ''}`}>{children}</div>
  );
}

interface SettingRowProps {
  title: ComponentChildren;
  /** A badge beside the title (Enabled, Not set up). */
  meta?: ComponentChildren;
  description?: ComponentChildren;
  /** The action on the right. */
  children?: ComponentChildren;
  class?: string;
}
export function SettingRow({ title, meta, description, children, class: extra }: SettingRowProps) {
  return (
    <div class={`user-settings-setting${extra ? ` ${extra}` : ''}`}>
      <span class="user-settings-setting-text">
        <span class="user-settings-setting-head">
          <span class="user-settings-setting-title">{title}</span>
          {meta}
        </span>
        {description && <span class="user-settings-setting-desc">{description}</span>}
      </span>
      {children != null && <span class="user-settings-setting-action">{children}</span>}
    </div>
  );
}

interface DetailRowProps { label: string; value?: string | null; customValue?: ComponentChildren }
export function DetailRow({ label, value, customValue }: DetailRowProps) {
  return (
    <div class="user-settings-row">
      <dt class="user-settings-label">{label}</dt>
      <dd class="user-settings-value">
        {customValue ?? (value ? <span>{value}</span> : <span class="user-settings-empty">—</span>)}
      </dd>
    </div>
  );
}
