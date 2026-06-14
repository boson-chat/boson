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
  'host-start',
  'host-daemon',
  'host-verify',
  'host-register',
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
            Two parts: using the desktop client day-to-day (live now) and registering your own IRC
            daemon with the public directory (the workers that automate this are still on the way).
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
              </ul>
              <h4>List in the directory</h4>
              <ul>
                <li><a href="#host-start"    class={linkClass('host-start')}>Before you start</a></li>
                <li><a href="#host-daemon"   class={linkClass('host-daemon')}>Pick an IRCd</a></li>
                <li><a href="#host-verify"   class={linkClass('host-verify')}>DNS TXT verification</a></li>
                <li><a href="#host-register" class={linkClass('host-register')}>Submit to the directory</a></li>
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
                  Grab the installer for your platform from the <a href="/download" class="docs-link">downloads page</a>.
                  Three flavours — <span class="num">.dmg</span> for macOS,{' '}
                  <span class="num">.exe</span> for Windows,{' '}
                  <span class="num">.AppImage</span> or <span class="num">.deb</span> for Linux. The
                  desktop client bundles a local Go process — the IRC engine — that handles all
                  network I/O.
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
                  <strong>On macOS first launch:</strong> Boson is ad-hoc signed but not registered
                  with an Apple Developer ID. Gatekeeper will show "unverified developer". See the{' '}
                  <a href="/download#first-launch-macos" class="docs-link">download page</a> for
                  the right-click → Open workaround.
                </div>
              </article>

              <article class="doc-section" id="join-directory">
                <p class="eyebrow">02</p>
                <h2>Join a server from the directory.</h2>
                <p>
                  Click <strong>Directory</strong> in the left rail. You'll see a list of public
                  IRC networks that have been added to the Boson directory. Filter by tag, search
                  by name. Click a card → <strong>Join</strong> and the engine connects, registers
                  a nick over SASL, and joins any auto-join channels the server advertises.
                </p>
                <p>
                  The directory is read-only from the client right now — what you see is what's
                  there. Submitting your own server for inclusion isn't shipped yet (see the
                  second half of these docs).
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

              {/* --------------- LIST IN THE DIRECTORY (planned) --------------- */}

              <header class="docs-group-header">
                <p class="eyebrow">Part 2</p>
                <h2>List your server in the directory.</h2>
                <p class="muted" style="margin-top: 16px;">
                  Run an IRC server? Register it in the directory yourself — from the client,
                  verified by a DNS TXT record, no human reviewer in the loop. Registration and DNS
                  verification ship today; the background <em>health</em> and <em>re-verification</em>
                  workers (which would auto-flag offline or lapsed listings) are still on the roadmap —
                  see the last section. Questions?{' '}
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
                      Sign in to Boson, open the <strong>Directory</strong> and click{' '}
                      <strong>Add your server to the community → Add a server</strong>. Fill in the
                      form and submit — you get a one-time token bound to your account.
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
                      Click verify in the app. The directory queries multiple resolvers and looks
                      for an exact-match record.
                    </p>
                    <Terminal>
                      <Line prompt>dig +short TXT _boson.irc.northwind.studio</Line>
                      <Line><C tone="str">"boson-verify=8f3a2c…b714"</C></Line>
                    </Terminal>
                  </li>
                </ol>
                <div class="doc-callout">
                  Once you're verified, you can leave the TXT record in place (recommended) or
                  remove it. The re-verification worker — once it ships — will recheck periodically;
                  if the record disappears, there'll be a grace window before the listing hides.
                </div>
              </article>

              <article class="doc-section" id="host-register">
                <p class="eyebrow">04</p>
                <h2>Submit to the directory.</h2>
                <p>
                  The registration form (the <strong>Add a server</strong> step above) captures the
                  server profile in one go. The four fields that matter:
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

              <article class="doc-section" id="host-health">
                <p class="eyebrow">05</p>
                <h2>Health and re-verification.</h2>
                <p>
                  The schema for periodic checks is already in place — every server record carries{' '}
                  <span class="num">verification_status</span> and{' '}
                  <span class="num">health_status</span> fields. The background workers that
                  actually run those checks are next on the roadmap.
                </p>
                <p>
                  <strong>What's coming.</strong> Three jobs we plan to ship together:
                </p>
                <ul>
                  <li>
                    <strong>Health check</strong> — periodic TLS connect + welcome-banner read.
                    Offline servers stay listed but get a{' '}
                    <span class="num">"currently offline"</span> badge.
                  </li>
                  <li>
                    <strong>Re-verification</strong> — the TXT record is re-queried on a schedule.
                    Lapsed records get hidden after a grace window; restoring the record re-lists
                    you on the next pass.
                  </li>
                  <li>
                    <strong>Activity sampling</strong> — <span class="num">LUSERS</span> at a
                    regular interval. The user count in the directory becomes a median, not a
                    spot-reading, so an empty hour doesn't make your server look dead.
                  </li>
                </ul>
                <p class="muted">
                  Exact intervals will live here once the workers ship. We'd rather underclaim now
                  than redesign the docs after the first iteration.
                </p>
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
                  <li><strong>Operator request.</strong> You ask. We remove. The hostname is freed up for re-registration after 30 days.</li>
                  <li><strong>Lapsed verification.</strong> TXT record missing for &gt; 14 days. Add it back to re-list — automatic once the re-verification worker ships.</li>
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
            Install Boson, browse the directory, or register your own server. The background health
            and re-verification workers are landing over the next few releases.
          </p>
          <div class="hero-cta" style="justify-content: center;">
            <a class="btn btn-primary" href="/download">Download Boson</a>
            <a class="btn btn-secondary" href="/about">Read the philosophy</a>
          </div>
        </div>
      </section>
    </>
  );
}
