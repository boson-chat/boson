import type { ComponentChildren } from 'preact';
import { FeatureCard } from '../components/FeatureCard/FeatureCard';
import './FeaturesPage.css';

// All-features overview. Grouped into themed sections, each a grid of
// FeatureCards. Icons are small 24×24 line marks matching the rest of the site.

export function FeaturesPage() {
  return (
    <>
      <section class="section hero features-hero">
        <div class="container" style="max-width: 760px;">
          <p class="eyebrow">Features</p>
          <h1>Everything Boson does.</h1>
          <p class="lead" style="margin-top: 20px;">
            A modern desktop client for self-hosted IRC — rich chat, media, moderation, and
            services automation on top of an open protocol. No walled garden, no lock-in.
          </p>
          <div class="hero-cta" style="margin-top: 28px;">
            <a class="btn btn-primary" href="/download">Download</a>
            <a class="btn btn-ghost btn-arrow" href="/docs">Read the docs</a>
          </div>
        </div>
      </section>

      <FeatureSection
        eyebrow="Messaging"
        title="Chat that reads like chat."
        blurb="The message view understands modern formatting instead of dumping raw text."
        image="/screenshots/02-chat-readable.png"
        imageAlt="Boson chat showing a rendered table, markdown, and link cards"
        features={[
          { icon: <MarkdownIcon />, title: 'Markdown & tables', body: 'Bold, italic, strikethrough, inline code, links, and real HTML tables — pasted box-drawing and pipe tables are reconstructed into clean, scrollable grids.' },
          { icon: <EyeOffIcon />, title: 'Spoilers & emoji', body: 'Hide spoilers behind a click, drop in emoji from a searchable picker, and see your own nick right in the composer.' },
          { icon: <CodeIcon />, title: 'Code & monospace', body: 'Fenced code and columnar bot output render in aligned monospace blocks instead of wrapping into noise.' },
        ]}
      />

      <FeatureSection
        eyebrow="Rich media"
        title="Links that come alive — on your terms."
        blurb="Images, video, music, and link previews render inline, with a privacy-first click-to-load mode you control."
        image="/screenshots/02-chat.png"
        imageAlt="Inline Spotify track list and YouTube card in a Boson channel"
        features={[
          { icon: <ImageIcon />, title: 'Images & video', body: 'Inline images open in a full-screen lightbox; direct video files get an in-app player — no bouncing out to a browser.' },
          { icon: <PlayIcon />, title: 'YouTube & Spotify', body: 'YouTube plays inline; Spotify shows a native card with the full track list and 30-second previews — no account or API keys needed.' },
          { icon: <LinkIcon />, title: 'Link previews & safe files', body: 'Website links unfurl into rich cards (title, description, image). File links warn before download. Toggle any of it off globally.' },
        ]}
      />

      <FeatureSection
        eyebrow="Moderation"
        title="Full channel-operator control."
        blurb="Everything a channel op needs, from a clean UI instead of memorized slash commands."
        image="/screenshots/feat-moderation.png"
        imageAlt="Channel Settings panel with mode toggles, topic, and ban list"
        features={[
          { icon: <ShieldIcon />, title: 'Channel modes', body: 'Toggle moderated, invite-only, topic-lock, secret, and more — set a key or user limit — from the Channel Settings panel.' },
          { icon: <GavelIcon />, title: 'Kick, ban & promote', body: 'Right-click any member to kick, ban, kick-ban, or grant op / halfop / voice / admin / owner — gated by your own rank.' },
          { icon: <ListIcon />, title: 'Ban list & topic', body: 'View and edit the live ban list and channel topic, with changes reflected the moment the server confirms them.' },
        ]}
      />

      <FeatureSection
        eyebrow="Services"
        title="NickServ, automated."
        blurb="Boson talks to network services for you — no /msg NickServ choreography."
        image="/screenshots/feat-services.png"
        imageAlt="Inbox showing MemoServ memos, a DM, and a NickServ auto-identify notice"
        features={[
          { icon: <KeyIcon />, title: 'Auto-identify', body: 'Saved per-server credentials identify you to NickServ on connect. Atheme, Anope, and Ergo are detected automatically.' },
          { icon: <InboxIcon />, title: 'MemoServ inbox', body: 'Memos surface in an in-app inbox with unread tracking, instead of scrolling past service notices.' },
          { icon: <UserCheckIcon />, title: 'Nick claims', body: 'Signed-in users get an automated nick-registration flow so your identity is yours across the network.' },
        ]}
      />

      <FeatureSection
        eyebrow="Connectivity"
        title="Many servers, always on."
        blurb="Connect to any self-hosted network, with or without a bouncer."
        image="/screenshots/03-directory.png"
        imageAlt="Server directory with searchable, verified self-hosted IRC servers"
        features={[
          { icon: <RelayIcon />, title: 'Bouncer (ZNC/BNC)', body: 'Route through your bouncer for always-on presence and server-side scrollback that loads as you scroll up.' },
          { icon: <ServersIcon />, title: 'Multi-server', body: 'Run several networks side by side; per-server identity, nicks, and credentials stay isolated.' },
          { icon: <GlobeIcon />, title: 'Server directory', body: 'Discover public self-hosted servers from an in-app directory, or add your own private one in seconds.' },
        ]}
      />

      <FeatureSection
        eyebrow="Desktop app"
        title="Built for the desktop."
        blurb="A native app, not a tab — with the polish you'd expect."
        image="/screenshots/feat-desktop.png"
        imageAlt="Notification settings: mentions, direct messages, and sound"
        features={[
          { icon: <BellIcon />, title: 'Desktop notifications', body: 'Native alerts for mentions and DMs when the window is in the background; click to jump straight to the conversation.' },
          { icon: <ResizeIcon />, title: 'Resizable, persistent layout', body: 'Drag to resize the channel and member lists; your layout, panel sizes, and session persist across restarts.' },
          { icon: <DesktopIcon />, title: 'Cross-platform + auto-update', body: 'macOS, Windows, and Linux (x64 & ARM64, AppImage or .deb), with built-in auto-updates.' },
        ]}
      />

      <FeatureSection
        eyebrow="Privacy & security"
        title="Your keys, your machine."
        blurb="Credentials never leave your control, and previews never leak your IP unasked."
        image="/screenshots/feat-privacy.png"
        imageAlt="Content settings with per-type embed toggles and click-to-load"
        features={[
          { icon: <LockIcon />, title: 'One account, every server', body: 'Sign in once; per-server IRC credentials are encrypted and stored in your OS keychain — never in plain text.' },
          { icon: <EyeOffIcon />, title: 'Privacy-first previews', body: 'Switch embeds to click-to-load so no remote content (or your IP) is fetched until you ask. Link unfurls are SSRF-guarded.' },
          { icon: <ProtocolIcon />, title: 'Open protocol, local engine', body: 'Plain IRC underneath, spoken by a local Go engine on your machine. No proprietary lock-in — leave whenever you like.' },
        ]}
      />

      <section class="section cta-strip">
        <div class="container">
          <div class="cta-row">
            <div>
              <h2>Ready to try it?</h2>
              <p class="lead" style="margin-top: 12px;">Free, open-source, and self-hostable.</p>
            </div>
            <div class="hero-cta">
              <a class="btn btn-primary" href="/download">Download Boson</a>
              <a class="btn btn-secondary" href="/discover">Browse servers</a>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function FeatureSection({
  eyebrow, title, blurb, features, image, imageAlt,
}: {
  eyebrow: string;
  title: string;
  blurb: string;
  features: { icon: ComponentChildren; title: string; body: string }[];
  image?: string;
  imageAlt?: string;
}) {
  return (
    <section class="section features-section">
      <div class="container stack" style="gap: 40px;">
        <div class="features-section-head">
          <p class="eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
          <p class="lead">{blurb}</p>
        </div>
        {image && (
          <figure class="features-shot">
            <img src={image} alt={imageAlt ?? title} loading="lazy" />
          </figure>
        )}
        <div class="grid-3">
          {features.map((f) => (
            <FeatureCard key={f.title} title={f.title} icon={f.icon}>{f.body}</FeatureCard>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---- icons (24×24 line marks, currentColor) ---- */
const svg = (children: ComponentChildren) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    {children}
  </svg>
);
const MarkdownIcon = () => svg(<><rect x="3" y="6" width="18" height="12" rx="1.5" /><path d="M6 14V9.5l2.2 2.2L10.4 9.5V14M14 9.5V14m0 0 2 -2m-2 2-2-2" /></>);
const EyeOffIcon = () => svg(<><path d="M3 3l18 18M10.6 6.1A9.5 9.5 0 0 1 21 12a10 10 0 0 1-3.3 3.9M6.3 6.3A10 10 0 0 0 3 12a9.6 9.6 0 0 0 11 4.7" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>);
const CodeIcon = () => svg(<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13 5l-2 14" />);
const ImageIcon = () => svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9.5" r="1.5" /><path d="M21 16l-5-5L5 21" /></>);
const PlayIcon = () => svg(<><circle cx="12" cy="12" r="9" /><path d="M10 8.5l6 3.5-6 3.5z" /></>);
const LinkIcon = () => svg(<><path d="M9.5 14.5l5-5" /><path d="M7 12l-2 2a3.5 3.5 0 0 0 5 5l2-2" /><path d="M17 12l2-2a3.5 3.5 0 0 0-5-5l-2 2" /></>);
const ShieldIcon = () => svg(<path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />);
const GavelIcon = () => svg(<><path d="M14 4l6 6-3 3-6-6z" /><path d="M11 7L4 14l3 3 7-7" /><path d="M3 21h9" /></>);
const ListIcon = () => svg(<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />);
const KeyIcon = () => svg(<><circle cx="7.5" cy="15.5" r="3.5" /><path d="M10 13l9-9M16 4l3 3M14 6l2 2" /></>);
const InboxIcon = () => svg(<><path d="M3 13l3-8h12l3 8v6H3z" /><path d="M3 13h5l1 2h6l1-2h5" /></>);
const UserCheckIcon = () => svg(<><circle cx="9" cy="8" r="3.5" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M16 12l2 2 4-4" /></>);
const RelayIcon = () => svg(<><path d="M3 8h12M12 5l3 3-3 3" /><path d="M21 16H9m3 3l-3-3 3-3" /></>);
const ServersIcon = () => svg(<><rect x="3" y="4" width="18" height="7" rx="1.5" /><rect x="3" y="13" width="18" height="7" rx="1.5" /><path d="M7 7.5h.01M7 16.5h.01" /></>);
const GlobeIcon = () => svg(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18" /></>);
const BellIcon = () => svg(<><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" /><path d="M10 19a2 2 0 0 0 4 0" /></>);
const ResizeIcon = () => svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M14 4v16M17.5 10l2 2-2 2M10.5 10l-2 2 2 2" /></>);
const DesktopIcon = () => svg(<><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>);
const LockIcon = () => svg(<><rect x="5" y="11" width="14" height="9" rx="1.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>);
const ProtocolIcon = () => svg(<><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="12" cy="18" r="2.5" /><path d="M6 8.5v3a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-3M12 13.5v2" /></>);
