import { Card, Badge } from '@boson/shared';
import { ScreenshotFrame } from '../components/ScreenshotFrame/ScreenshotFrame';
import { Terminal, Line, C } from '../components/Terminal/Terminal';
import { useScrollSpy } from '../hooks/useScrollSpy';
import './DocsPage.css';

// Sidebar IDs in document order. The scrollspy uses these to figure out
// which link to highlight as you scroll. Keep this in sync with the
// element ids on each <article class="doc-section">.
const DOC_SECTION_IDS = [
  'install',
  'join-directory',
  'add-manual',
  'channels',
  'commands',
  'themes',
  'host-start',
  'host-daemon',
  'host-verify',
  'host-register',
  'host-stack',
  'host-own',
  'host-health',
  'ref-sasl',
  'ref-tls',
  'ref-delist',
] as const;

export function DocsPage() {
  const active = useScrollSpy(DOC_SECTION_IDS);
  const linkClass = (id: string) => (active === id ? 'active' : undefined);
  return (
    <>
      <section class="section docs-hero">
        <div class="container">
          <p class="eyebrow">Docs</p>
          <h1 style="max-width: 22ch;">How to use Boson — and how to plug your server in.</h1>
          <p class="lead" style="margin-top: 20px;">
            Two parts: using the desktop client day-to-day, and listing your own IRC daemon in the
            network directory at directory.boson.chat — or running a directory of your own.
          </p>
        </div>
      </section>

      <section class="section docs-content">
        <div class="container">
          <div class="docs-grid">
            <aside class="docs-sidebar">
              <h4>Using Boson</h4>
              <ul>
                <li><a href="#install"        class={linkClass('install')}>Install &amp; sign in</a></li>
                <li><a href="#join-directory" class={linkClass('join-directory')}>Join from the directory</a></li>
                <li><a href="#add-manual"     class={linkClass('add-manual')}>Add a server manually</a></li>
                <li><a href="#channels"       class={linkClass('channels')}>Channels &amp; DMs</a></li>
                <li><a href="#commands"       class={linkClass('commands')}>Slash commands</a></li>
                <li><a href="#themes"         class={linkClass('themes')}>Themes &amp; customization</a></li>
              </ul>
              <h4>List in the directory</h4>
              <ul>
                <li><a href="#host-start"    class={linkClass('host-start')}>Before you start</a></li>
                <li><a href="#host-daemon"   class={linkClass('host-daemon')}>Pick an IRCd</a></li>
                <li><a href="#host-verify"   class={linkClass('host-verify')}>DNS TXT verification</a></li>
                <li><a href="#host-register" class={linkClass('host-register')}>Submit to the directory</a></li>
                <li><a href="#host-stack"    class={linkClass('host-stack')}>Boson stack fast path</a></li>
                <li><a href="#host-own"      class={linkClass('host-own')}>Run your own directory</a></li>
                <li><a href="#host-health"   class={linkClass('host-health')}>Health &amp; re-verification</a></li>
              </ul>
              <h4>Reference</h4>
              <ul>
                <li><a href="#ref-sasl"   class={linkClass('ref-sasl')}>SASL requirements</a></li>
                <li><a href="#ref-tls"    class={linkClass('ref-tls')}>TLS &amp; port choices</a></li>
                <li><a href="#ref-delist" class={linkClass('ref-delist')}>Removal &amp; appeals</a></li>
              </ul>
            </aside>

            <div class="docs-body">
              {/* --------------- USING BOSON --------------- */}

              <header class="docs-group-header">
                <p class="eyebrow">Part 1</p>
                <h2>Using Boson.</h2>
                <p class="muted">
                  Everything in this group works in the build you can download today. If something
                  doesn't behave the way it's described here, that's a bug — file it.
                </p>
              </header>

              <article class="doc-section" id="install">
                <p class="eyebrow">01</p>
                <h2>Install &amp; sign in.</h2>
                <p>
                  Grab the app for your platform from the <a href="/download" class="docs-link">downloads page</a>:
                  a <span class="num">.dmg</span> for macOS, a <span class="num">.zip</span> for
                  Windows, a <span class="num">.tar.gz</span> for Linux. The desktop client has
                  the IRC engine built in — Go code that handles all network I/O.
                </p>
                <p>
                  On first launch, you have two paths:
                </p>
                <ul>
                  <li>
                    <strong>Sign in (or sign up).</strong> Creates a Boson account. Your identity
                    secret is generated locally and stored encrypted with a key derived from your
                    password; the directory only ever sees ciphertext.
                  </li>
                  <li>
                    <strong>Continue as guest.</strong> Skip the account. You can still join
                    servers from the directory — they're keyed to a one-time guest identity
                    that disappears when you sign out. You can promote a guest session to a full
                    account later without losing your joined servers.
                  </li>
                </ul>
                <div class="doc-callout">
                  <strong>On macOS:</strong> since v0.32.1 Boson is signed with an Apple Developer
                  ID and notarized, so it opens without Gatekeeper warnings. Upgrading from an
                  older build? See the{' '}
                  <a href="/download#first-launch-macos" class="docs-link">download page</a> — you
                  need to download the new version once by hand.
                </div>
              </article>

              <article class="doc-section" id="join-directory">
                <p class="eyebrow">02</p>
                <h2>Join a server from the directory.</h2>
                <p>
                  Click <strong>Directory</strong> in the left rail. You'll see the public IRC
                  networks listed in the Boson directory. Search by name, filter by language or
                  topic, sort by size or activity; more load as you scroll. Click a card →{' '}
                  <strong>Connect</strong> and the engine connects, registers a nick over SASL, and
                  joins any auto-join channels the server advertises.
                </p>
                <p>
                  The list comes from <span class="num">directory.boson.chat</span> by default. To
                  browse another directory too — a community's, or your own stack's — open{' '}
                  <strong>User settings → Directories</strong> and add it by address. Boson merges
                  them into one list, one card per server, and labels where each one is listed.
                  You can switch the default directory off there as well.
                </p>
              </article>

              <article class="doc-section" id="add-manual">
                <p class="eyebrow">03</p>
                <h2>Add a server manually <Badge tone="info">Advanced mode</Badge></h2>
                <p>
                  If the server you want to connect to isn't in the directory — your own private
                  network, a friend's daemon, a local <span class="num">ergo</span> you're testing
                  against — use Advanced mode. The server is stored locally on your machine only;
                  nothing about it is sent to the Boson backend.
                </p>
                <ol class="step-list">
                  <li>
                    <h3>Open the Directory screen.</h3>
                    <p class="muted">
                      Click <strong>Directory</strong> in the left rail.
                    </p>
                  </li>
                  <li>
                    <h3>Toggle Advanced mode.</h3>
                    <p class="muted">
                      In the top-right of the Directory header, click the{' '}
                      <strong>Advanced</strong> toggle. A new <strong>Add server</strong> button
                      appears, and any locally-added servers are marked with a{' '}
                      <span class="num">LOCAL</span> chip + a Remove control.
                    </p>
                    <ScreenshotFrame
                      src="/screenshots/06-directory-advanced.png"
                      alt="Directory screen with Advanced toggle highlighted and an Add server button visible in the header."
                      caption="DIRECTORY · Advanced toggle"
                      width={1280}
                      height={720}
                    />
                  </li>
                  <li>
                    <h3>Fill in hostname, port, and (optionally) a display name.</h3>
                    <p class="muted">
                      Defaults are <span class="num">6697</span> + TLS on. Both are sensible for
                      virtually every modern IRCd. Display name defaults to the hostname if you
                      leave it blank.
                    </p>
                    <ScreenshotFrame
                      src="/screenshots/07-directory-add-server.png"
                      alt="Add server form with hostname, port, display name fields and a TLS toggle."
                      caption="DIRECTORY · Add server form"
                      width={1280}
                      height={720}
                    />
                  </li>
                  <li>
                    <h3>Click Add server, then Connect on the new card.</h3>
                    <p class="muted">
                      The server appears in the merged directory list immediately. Connecting uses
                      the same path as a directory server — SASL PLAIN over TLS, auto-join
                      whatever the server's auto-join is, the works.
                    </p>
                  </li>
                </ol>
                <div class="doc-callout">
                  <strong>LAN / local addresses work.</strong> The form accepts hostnames or IPs,
                  so you can point at <span class="num">192.168.1.42</span> or{' '}
                  <span class="num">localhost</span> for a daemon you're running on the same
                  machine.
                </div>
              </article>

              <article class="doc-section" id="channels">
                <p class="eyebrow">04</p>
                <h2>Channels and DMs.</h2>
                <p>
                  Once you're connected, the channel rail on the left lists every channel you're
                  in. Click + at the top to join a new one (just type the channel name; Boson adds
                  the <span class="num">#</span> if you forget). The member panel on the right
                  shows everyone in the current channel, sorted by role with presence dots — green
                  for online, amber for away, grey for unknown.
                </p>
                <p>
                  Direct messages work the same way. Right-click any nick → <strong>Send
                  message</strong> opens a DM thread. Hovering a nick shows a hover card with
                  their realname, host, and account if the server provides them.
                </p>
              </article>

              <article class="doc-section" id="commands">
                <p class="eyebrow">05</p>
                <h2>Slash commands.</h2>
                <p>
                  Boson handles the day-to-day chat surface without commands, but the classic IRC
                  verbs still work in the message input. Tab-complete lists the available ones.
                </p>
                <ul>
                  <li><span class="num">/join #channel</span> — join a channel.</li>
                  <li><span class="num">/part [reason]</span> — leave the current channel.</li>
                  <li><span class="num">/msg nick text</span> — send a DM. With no text, just opens the DM thread.</li>
                  <li><span class="num">/me action</span> — send a CTCP ACTION ("emote").</li>
                  <li><span class="num">/away message</span> — mark yourself as away with a reason.</li>
                  <li><span class="num">/back</span> — clear your away status.</li>
                  <li><span class="num">/clear</span> — clear the current channel's message buffer.</li>
                  <li><span class="num">/help</span> — list every command Boson knows.</li>
                </ul>
                <p class="muted">
                  Anything starting with <span class="num">//</span> sends the rest of the line as
                  literal text — useful if your message happens to start with a slash.
                </p>
              </article>

              <article class="doc-section" id="themes">
                <p class="eyebrow">06</p>
                <h2>Themes and customization.</h2>
                <p>
                  Every colour in Boson comes from its theme, so one choice restyles the whole app.
                  Open <strong>Settings → Appearance</strong> and click a theme: it applies
                  instantly and is remembered. Five are built in — <strong>Terminal</strong> (the
                  default), <strong>Daylight</strong> (light), <strong>Nord</strong>,{' '}
                  <strong>Solarized</strong>, and <strong>Phosphor</strong>. Themes you make or
                  import are listed under <strong>Yours</strong>.
                </p>
                <ScreenshotFrame
                  src="/screenshots/theme-gallery.png"
                  alt="Settings → Appearance with the built-in themes; Nord is selected"
                  caption="Settings → Appearance. Nord is selected."
                  maxWidth={768}
                />

                <h3>Make your own.</h3>
                <p>
                  Select a built-in theme and click <strong>Customize</strong> to open the editor
                  with a copy of it (<strong>Edit</strong> on one of your own themes changes it in
                  place). Everything you change previews live across the app;{' '}
                  <strong>Save</strong> keeps it, <strong>Cancel</strong> throws it away.
                </p>
                <ul>
                  <li>
                    <strong>Colours</strong> — click a swatch for the colour picker: drag in the
                    square for saturation and brightness, use the strips for hue and opacity, type a
                    hex value, reuse one of the theme's other colours from the row of chips, or pick
                    one off the screen with the eyedropper. Arrow keys move the picker too (hold
                    Shift for bigger steps). The text box beside each swatch takes any CSS colour:{' '}
                    <span class="num">#hex</span>, <span class="num">rgb()</span>,{' '}
                    <span class="num">hsl()</span>, <span class="num">oklch()</span>, or a name.
                  </li>
                  <li><strong>Base</strong> — dark or light. Anything a theme leaves out is filled in from Terminal or Daylight.</li>
                  <li><strong>Corners</strong> — from square (0px) to round (12px).</li>
                  <li><strong>Font</strong> — Boson's own (Inter + JetBrains Mono) or your system's UI font.</li>
                  <li><strong>Nick colours</strong> — each nick gets its own hue; saturation and lightness set how loud they are.</li>
                </ul>
                <ScreenshotFrame
                  src="/screenshots/theme-editor.png"
                  alt="The theme editor with the colour picker open on the Accent colour"
                  caption="The editor, with the colour picker open on Accent."
                  maxWidth={768}
                />
                <p>
                  The colours, grouped as in the editor:
                </p>
                <ul>
                  <li><strong>Surfaces</strong> — <span class="num">bg</span> (background), <span class="num">surface</span> (panels), <span class="num">surface-raised</span>, <span class="num">surface-hover</span>, <span class="num">border</span>, <span class="num">border-soft</span>.</li>
                  <li><strong>Text</strong> — <span class="num">fg</span>, <span class="num">fg-2</span>, <span class="num">fg-3</span> (primary to tertiary), <span class="num">muted</span>, <span class="num">meta</span> (faint).</li>
                  <li><strong>Accent</strong> — <span class="num">accent</span> and <span class="num">accent-on</span> (text drawn on the accent).</li>
                  <li><strong>Status</strong> — <span class="num">success</span>, <span class="num">warn</span>, <span class="num">danger</span>, <span class="num">info</span>.</li>
                </ul>

                <h3>Theme files.</h3>
                <p>
                  Each of your themes is a JSON file in Boson's themes folder —{' '}
                  <strong>Open themes folder</strong> in Appearance takes you there. Edit a file in
                  any editor and Boson re-applies it as soon as you save. Every field is optional;
                  a missing one comes from the built-in theme of the same base.
                </p>
                <Terminal>
                  <Line>{'{'}</Line>
                  <Line>&nbsp;&nbsp;<C tone="key">"name"</C>: <C tone="str">"Ember"</C>,</Line>
                  <Line>&nbsp;&nbsp;<C tone="key">"base"</C>: <C tone="str">"dark"</C>,</Line>
                  <Line>&nbsp;&nbsp;<C tone="key">"colors"</C>: {'{'} <C tone="key">"accent"</C>: <C tone="str">"#e8590c"</C>, <C tone="key">"bg"</C>: <C tone="str">"#0b0a09"</C> {'}'},</Line>
                  <Line>&nbsp;&nbsp;<C tone="key">"nick"</C>: {'{'} <C tone="key">"saturation"</C>: <C tone="acc">62</C>, <C tone="key">"lightness"</C>: <C tone="acc">64</C> {'}'},</Line>
                  <Line>&nbsp;&nbsp;<C tone="key">"radius"</C>: <C tone="acc">4</C>,</Line>
                  <Line>&nbsp;&nbsp;<C tone="key">"font"</C>: <C tone="str">"system"</C></Line>
                  <Line>{'}'}</Line>
                </Terminal>
                <p>
                  The folder is <span class="num">~/Library/Application Support/boson-client/themes</span>{' '}
                  on macOS, <span class="num">%APPDATA%\boson-client\themes</span> on Windows, and{' '}
                  <span class="num">~/.config/boson-client/themes</span> on Linux. A file that
                  can't be read as a theme is listed in Appearance with the reason.
                </p>
                <h3>Share a theme.</h3>
                <p>
                  With one of your themes selected, <strong>Copy JSON</strong> puts it on your
                  clipboard to paste to a friend. <strong>Import JSON</strong> adds a theme from a
                  file someone sent you. Colours in a theme file must be plain CSS colours —
                  anything else (an image, a variable) is ignored, and the import says so.{' '}
                  <strong>Delete</strong> removes one of your themes, file included.
                </p>
                <ScreenshotFrame
                  src="/screenshots/theme-chat-daylight.png"
                  alt="A Boson channel in the light Daylight theme"
                  caption="The same channel in Daylight."
                  maxWidth={768}
                />
              </article>

              {/* --------------- LIST IN THE DIRECTORY (planned) --------------- */}

              <header class="docs-group-header">
                <p class="eyebrow">Part 2</p>
                <h2>List your server in the directory.</h2>
                <p class="muted" style="margin-top: 16px;">
                  Run an IRC server? Register it in the directory yourself at{' '}
                  <a href="https://directory.boson.chat" class="docs-link">directory.boson.chat</a>{' '}
                  or from the client, verified by a DNS TXT record, no human reviewer in the loop.
                  The directory is federated: anyone running the Boson stack can run their own, and
                  directories import each other's listings. Questions?{' '}
                  <a href="mailto:hi@boson.chat" class="docs-link">drop us a line</a>.
                </p>
              </header>

              <article class="doc-section" id="host-start">
                <p class="eyebrow">01</p>
                <h2>Before you start.</h2>
                <p>
                  The directory only lists servers that meet four bars. None of them are about
                  hardware — they're about being a reachable, identifiable host that the Boson
                  client can SASL into without surprises.
                </p>
                <ul>
                  <li>A hostname (no IP-only servers — they'll be rejected).</li>
                  <li>TLS on a reachable port. Default is <span class="num">6697</span>, but any port works.</li>
                  <li>SASL PLAIN over TLS. Anonymous-only servers can't list.</li>
                  <li>Control of the DNS record for the hostname you want to register.</li>
                </ul>
                <div class="doc-callout">
                  <strong>About anonymity:</strong> the directory does not require server operators
                  to identify themselves to us. It requires a DNS-verifiable hostname and a
                  contact address for moderation reports — neither of which need to point to a
                  real name.
                </div>
              </article>

              <article class="doc-section" id="host-daemon">
                <p class="eyebrow">02</p>
                <h2>Pick an IRCd.</h2>
                <p>Any daemon that speaks SASL over TLS will work. Three good starting points:</p>
                <div class="daemon-grid">
                  <Card>
                    <div class="daemon-card rec">
                      <h4>
                        ergo <Badge tone="info">Recommended</Badge>
                      </h4>
                      <p>
                        Single Go binary. Built-in SASL, channel persistence, history. Modern
                        default for new self-hosts.
                      </p>
                    </div>
                  </Card>
                  <Card>
                    <div class="daemon-card">
                      <h4>InspIRCd</h4>
                      <p>
                        Mature, modular, C++. Use this if you want a deep configuration story and a
                        wide module ecosystem.
                      </p>
                    </div>
                  </Card>
                  <Card>
                    <div class="daemon-card">
                      <h4>UnrealIRCd</h4>
                      <p>
                        Battle-tested, opinionated. Strong default ban/spam protection if you're
                        inheriting an established community.
                      </p>
                    </div>
                  </Card>
                </div>
                <p class="muted">
                  If you already run something else and it supports SASL — including older
                  Charybdis, Solanum, ircu derivatives — it'll work. The Boson client connects
                  with the same handshake regardless.
                </p>
              </article>

              <article class="doc-section" id="host-verify">
                <p class="eyebrow">03</p>
                <h2>DNS TXT verification.</h2>
                <p>
                  When you submit a server, the directory hands you a one-time verification
                  token. You add it as a TXT record under <span class="num">_boson</span> on the
                  hostname you're registering, then click verify.
                </p>

                <ol class="step-list">
                  <li>
                    <h3>Get a verification token.</h3>
                    <p class="muted">
                      Go to <a href="https://directory.boson.chat" class="docs-link">directory.boson.chat</a>{' '}
                      and sign in with your Boson account (SSO works too), then register your
                      server. Or, in the app, open the <strong>Directory</strong> and click{' '}
                      <strong>Add your server to the community → Add a server</strong>. Either way
                      you get a one-time token bound to your account. It's good for 72 hours; you
                      can issue a new one at any time.
                    </p>
                  </li>
                  <li>
                    <h3>Add the TXT record.</h3>
                    <p class="muted">
                      For a server at <span class="num">irc.northwind.studio</span>, the record looks
                      like:
                    </p>
                    <Terminal>
                      <Line><C tone="cmt">; in your DNS zone, under _boson.irc.northwind.studio</C></Line>
                      <Line>
                        _boson.irc.northwind.studio. &nbsp;&nbsp;300 &nbsp;&nbsp;IN &nbsp;&nbsp;TXT
                        &nbsp;&nbsp;<C tone="str">"boson-verify=8f3a2c…b714"</C>
                      </Line>
                    </Terminal>
                  </li>
                  <li>
                    <h3>Wait for propagation, then verify.</h3>
                    <p class="muted">
                      Click verify on the website or in the app. The directory asks three public
                      resolvers and lists you once all three return the exact record.
                    </p>
                    <Terminal>
                      <Line prompt>dig +short TXT _boson.irc.northwind.studio</Line>
                      <Line><C tone="str">"boson-verify=8f3a2c…b714"</C></Line>
                    </Terminal>
                  </li>
                </ol>
                <div class="doc-callout">
                  Leave the TXT record in place once you're verified. The directory re-checks it
                  every day; if it goes missing for 14 days the listing lapses and hides, and it
                  comes back by itself once the record does.
                </div>
              </article>

              <article class="doc-section" id="host-register">
                <p class="eyebrow">04</p>
                <h2>Submit to the directory.</h2>
                <p>
                  The registration form (on the website, or the <strong>Add a server</strong> step
                  in the app) captures the server profile in one go. You can edit it, set an icon
                  and banner, or remove the listing later from the same place. The four fields
                  that matter:
                </p>
                <ul>
                  <li><strong>Name</strong> — short, human-readable. Shown in the directory list.</li>
                  <li><strong>Description</strong> — one paragraph. What's the community for? Who's it not for?</li>
                  <li><strong>Tags</strong> — pick from existing tags or propose new ones. Autocomplete will help.</li>
                  <li><strong>Languages</strong> — at least one. Drives the language filter for users.</li>
                </ul>
                <p>
                  NSFW servers must check the NSFW flag. The directory excludes them from
                  default search; users opt in via a toggle.
                </p>
              </article>

              <article class="doc-section" id="host-stack">
                <p class="eyebrow">05</p>
                <h2>Boson stack fast path.</h2>
                <p>
                  If your network runs on the Boson stack, you don't need a Boson account to list
                  it. The stack's admin panel registers the network with its own network key:
                  open <strong>Directory</strong> in the admin panel, check the details, and add
                  the TXT record it shows you. The verification is the same DNS check as above.
                </p>
                <p class="muted">
                  The stack points at <span class="num">directory.boson.chat</span> by default. Set{' '}
                  <span class="num">DIRECTORY_API_URL</span> to register somewhere else, or{' '}
                  <span class="num">DIRECTORY_REGISTRATION=false</span> to turn registration off.
                </p>
              </article>

              <article class="doc-section" id="host-own">
                <p class="eyebrow">06</p>
                <h2>Run your own directory.</h2>
                <p>
                  The directory is part of the Boson stack. Turn on its{' '}
                  <span class="num">directory</span> profile and it serves the same website and API
                  at <span class="num">directory.&lt;your domain&gt;</span>. Your members add it in
                  the app under <strong>User settings → Directories</strong>.
                </p>
                <p>
                  <strong>The main directory is included by default.</strong> A new directory
                  imports everything listed on <span class="num">directory.boson.chat</span>, so
                  your users see the whole network plus your own listings. Imported listings only
                  show as verified after your directory has checked each server's{' '}
                  <span class="num">_boson</span> TXT record itself. To run an independent
                  directory, set <span class="num">DIRECTORY_INCLUDE_MAIN=false</span>, or switch
                  the main directory off on the Peers page or in the admin panel. You can add
                  other directories as peers there too.
                </p>
                <div class="doc-callout">
                  When two directories list the same server, a listing registered on your own
                  directory wins over an imported one. Blocks you add apply to imported listings
                  as well.
                </div>
              </article>

              <article class="doc-section" id="host-health">
                <p class="eyebrow">07</p>
                <h2>Health and re-verification.</h2>
                <p>
                  The directory keeps listings honest on its own, with no cron jobs for you to run:
                </p>
                <ul>
                  <li>
                    <strong>Health check</strong> — every 15 minutes, a TLS connect to your listed
                    port. Offline servers stay listed but show as offline. The same check reads{' '}
                    <span class="num">LUSERS</span>, which is where the user count comes from.
                  </li>
                  <li>
                    <strong>Re-verification</strong> — the TXT record is re-checked daily, and two
                    of the three resolvers have to agree. After 14 days without a successful check
                    the listing lapses and hides.
                  </li>
                  <li>
                    <strong>Recovery</strong> — lapsed listings are re-checked weekly and list
                    again as soon as the record is back.
                  </li>
                </ul>
              </article>

              {/* --------------- REFERENCE --------------- */}

              <header class="docs-group-header">
                <p class="eyebrow">Reference</p>
                <h2>Protocol &amp; policy.</h2>
                <p class="muted">
                  Details that apply across both halves of the docs — what the client speaks on
                  the wire, what's expected of a daemon, and how a directory listing can come off.
                </p>
              </header>

              <article class="doc-section" id="ref-sasl">
                <p class="eyebrow">Reference</p>
                <h2>SASL requirements.</h2>
                <p>
                  Boson registers nicks for users automatically over SASL. Today the client
                  negotiates <span class="num">PLAIN</span> over TLS — the simplest mechanism, and
                  the one virtually every modern IRCd supports out of the box. Plaintext-on-wire
                  isn't a concern because the channel itself is encrypted.
                </p>
                <p>
                  There is no fallback to non-SASL nick registration — by design. If your daemon
                  doesn't speak SASL at all, Boson won't connect.
                </p>
                <div class="doc-callout">
                  <strong>Planned:</strong> <span class="num">SCRAM-SHA-256</span> and{' '}
                  <span class="num">EXTERNAL</span> (TLS client-cert) are on the roadmap. We're
                  shipping PLAIN-only first so we can finish identity hardening before adding
                  mechanism complexity.
                </div>
              </article>

              <article class="doc-section" id="ref-tls">
                <p class="eyebrow">Reference</p>
                <h2>TLS &amp; port choices.</h2>
                <p>
                  <strong>Port:</strong> the directory accepts any port.{' '}
                  <span class="num">6697</span> is the convention; <span class="num">7000</span>{' '}
                  and <span class="num">9999</span> are common alternatives. Avoid{' '}
                  <span class="num">6667</span> — that's plaintext IRC, and the directory
                  rejects non-TLS hostnames.
                </p>
                <p>
                  <strong>Certificate:</strong> standard public-CA certs are fine (Let's Encrypt is
                  the typical path). Self-signed certs aren't supported — the Boson client
                  validates them strictly.
                </p>
                <p>
                  <strong>SNI:</strong> required. The hostname in the cert SAN must match the
                  hostname users see in the directory (or, for Advanced-mode manual servers, the
                  hostname they typed in the form).
                </p>
              </article>

              <article class="doc-section" id="ref-delist">
                <p class="eyebrow">Reference</p>
                <h2>Removal and appeals.</h2>
                <p>
                  Listings can come off the directory for one of three reasons. The directory does
                  not police speech on your server — it polices presence on the directory.
                </p>
                <ul>
                  <li><strong>Operator request.</strong> Remove the listing yourself on directory.boson.chat, in the app, or from the stack's admin panel.</li>
                  <li><strong>Lapsed verification.</strong> TXT record missing for &gt; 14 days. Add it back and the listing returns at the next weekly check.</li>
                  <li><strong>Abuse.</strong> Repeated unreviewed reports tied to your server. We notify the contact address. Restoration is via the contact form.</li>
                </ul>
                <p>
                  The full moderation policy and appeals flow will live in{' '}
                  <a href="/about" class="docs-link">About → moderation</a> once it's drafted.
                </p>
              </article>
            </div>
          </div>
        </div>
      </section>

      <section class="section cta-strip docs-cta">
        <div class="container">
          <h2 style="margin-bottom: 16px;">The desktop client is live — and so is directory listing.</h2>
          <p class="lead">
            Install Boson, browse the directory, or register your own server at
            directory.boson.chat.
          </p>
          <div class="hero-cta" style="justify-content: center;">
            <a class="btn btn-primary" href="/download">Download Boson</a>
            <a class="btn btn-secondary" href="https://directory.boson.chat">List your server</a>
          </div>
        </div>
      </section>
    </>
  );
}
