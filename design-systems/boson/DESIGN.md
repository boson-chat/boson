# Boson design system

Terminal-modern: near-black surfaces, one amber accent, JetBrains Mono for
labels and UI, Inter for body text, sharp corners, 1px lines. Tokens live in
`tokens.css` (this folder; the app loads the identical
`packages/shared/src/design-system/tokens.css`). Components live in
`packages/shared/src/design-system/` and are imported from `@boson/shared`.

**One component per kind of thing.** If a screen needs a button, a count, an
avatar, a row, a toast… it uses the one below. A screen's own CSS does
layout (where things go), never a second look for the same thing. If the
component can't do what a screen needs, extend the component.

## Rules

- **Radii: only the three tokens.** `--radius-sm` (2px) badges, counts,
  chips, a switch's knob · `--radius-md` (4px) controls: buttons, inputs,
  segmented controls, switches, menu items, small avatars · `--radius-lg`
  (6px) surfaces: cards, toasts, menus, sheets, dialogs, big avatars, the
  72px call buttons. Never write a pixel radius. **Themes can't change
  shape**: a theme sets colours, fonts and backgrounds; its `radius` is
  ignored, so corners are the same on every network.
- **No circles and no pills**, except status / presence dots (`StatusDot`)
  and spinners. Avatars are rounded squares everywhere.
- **No thick accent bars** down a card's or banner's edge (they bend around
  the rounded corner). A card is a 1px border; its kind shows in its header
  (site name, Spotify mark, an icon), and a state in its icon colour.
- **Borders are 1px** (`--border`, or `--border-soft` for dividers inside a
  surface). A selected item may use a 2px accent edge (nav rows, tabs).
- **Touch targets: 44px minimum on phones** (`size="lg"` on Button,
  Segmented, ListRow, SwitchRow, MenuItem; `--control-lg`).
- **Reduced motion:** `tokens.css` flattens every duration to 0 under
  `prefers-reduced-motion`. Anything that loops (a ringing glow, the Accept
  pulse, a live dot) stops and shows a steady equivalent instead (a solid
  ring, a solid border), so the state still reads.
- **Colour:** accent `--accent` for "selected / yours / act here";
  `--success` live, accept, call; `--danger` decline, destructive, missed;
  red *text* uses `--danger-fg` (readable on dark). Text on a filled danger /
  success button: `--on-danger` / `--on-success`.
- **Type:** mono (`--font-mono`) for names, labels, buttons, counts, meta;
  `--font-body` for sentences (message bodies, descriptions, hints). Section
  labels: 11px mono, uppercase, `letter-spacing: .1em`, `--fg-3`.
- **Elevation:** `--shadow-menu` (menus, popovers), `--shadow-toast`
  (toasts, banners), `--shadow-dialog` (full-screen call card, dialogs).
- **Focus:** `box-shadow: var(--focus-ring)` on `:focus-visible`; never
  remove it without a replacement.

## Components

| Kind | Use | Variants / props | Tokens |
|---|---|---|---|
| Button, icon button | `Button` | `variant` primary · secondary · ghost · danger · success; `size` sm 28 · md 34 · lg 44 (phones) · xl 72 (full-screen call); `icon` (+ no children = square icon-only, `aria-label` required by the type); `tone` success · danger · accent (colours a neutral button's icon/label); `pressed` (toggles: mute, camera); `attention` (pulse: Accept); `shape` square (default) · round (only the full-screen call, see below); `fullWidth`, `loading` | `--radius-md` (xl: `--radius-lg`), `--control-*`, mono 600 |
| Count (unread, mentions, missed) | `Count` | `tone` accent · danger · neutral; `size` md 18 · sm 16; `overlay` (pinned over a tile: ring in `--count-ring`); `max` (99+) | `--radius-sm`, mono 700 10px |
| Label badge (OPS, GUEST, BOT) | `Badge` | `tone` | `--radius-sm`, mono 9px uppercase |
| Status / presence dot | `StatusDot` | `status` online · live · dnd · error · away · offline · unread · accent; `size` 6 · 8 · 10 · 12; `ring`; `pulse` | circle (the only one) |
| Avatar, placeholder tile | `Avatar` (app: `shared/Avatar`, which adds the nick's colour/initial and finds the picture itself) | `size`; `status` (presence dot); `ringing` (green pulsing ring); `dim` | radius by size: ≤20 sm, ≤48 md, else lg; never a circle |
| One-of-a-few choice | `Segmented` | `size` md 34 · lg 44; `fill` | `--radius-md` outer corners, accent when on |
| Tabs (switch the view) | `Tabs` | — | 2px accent indicator |
| On / off | `Switch` (`Toggle`), `SwitchRow` (title + description + switch, the row toggles) | `size` md · lg | track `--radius-md`, knob `--radius-sm` |
| List row | `ListRow` | `variant` item (avatar · title + meta / subtitle · actions, divider under) · nav (sidebar entry: 2px accent edge when selected); `size` md · lg (phones: 16px inset, 14px title); `onClick` (the body is one button); `titleTone` danger · success; `unread`, `selected` | mono 700 13px title, 12px `--fg-2` subtitle |
| Page header | `PageHeader` | `layout` desktop (64px, 20px title) · phone (54px, 16px title, 44px back button); `actions`; children (tabs) | `--border` underneath |
| Toast, banner, status pop-up | `Toast` | `surface` desktop (card, slides in) · phone (banner, drops from the top); `layout` stack (buttons under the text) · row (one line: the incoming-call banner); `onOpen`, `onDismiss`, `timerMs` + `paused` (time-left bar), `ringing` (green glow), `status` (centred text only) | `--radius-lg`, `--shadow-toast` |
| Empty state | `EmptyState` | `icon`, `title`, `action` | centred, 13px `--fg-3` |
| Menu (right-click, "…") | `Menu`, `MenuItem`, `MenuLabel`, `MenuSeparator` | item `danger`, `checked`, `icon` + `iconTone`, `size` md 32 · lg 44 | `--radius-lg` surface, `--radius-md` items, `--shadow-menu` |
| Dropdown (one of a list) | `Select` — never a native `<select>` (a test fails on one) | `options` (`label`, `description`, `disabled`); `size` sm · md (the Input's); `label` or `labelledBy`; `placeholder`; `presentation` auto (a popover; a Sheet below the phone breakpoint) · popover · sheet | trigger: the Input's `--radius-md`; list: the Menu's surface and items |
| Phone sheet | `Sheet` (app: `BottomSheet`, which portals it) | header, body, `actions` (MenuItems, 44px) | `--radius-lg` top corners |
| Dialog | `Modal` | `size` default · wide | `--radius-lg` |
| Text input | `Input`, `Field` | — | `--radius-md` |
| Card / section | `Card` | flat · raised | `--radius-lg` |

### Calls

- The **incoming-call banner** (phones when "Incoming calls: Banner", and
  desktop's corner card) is one `Toast` with `layout="row"`: avatar, name,
  "video call" / "voice call", then 44px icon buttons Decline (danger),
  Voice only (secondary, video calls only), Accept (success, `attention`).
  Tapping the body opens the call full screen.
- The **full-screen incoming call** uses `Button size="xl"` for Decline /
  Voice only / Accept. They're square (`--radius-lg`) like everything else;
  `CALL_BUTTON_SHAPE` in `client/src/renderer/src/screens/Friends/CallOverlays.tsx`
  flips them to round in one line if that's preferred.
