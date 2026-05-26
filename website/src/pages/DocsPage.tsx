import { Card, Badge } from '@boson/shared';
import { Terminal, Line, C } from '../components/Terminal/Terminal';
import './DocsPage.css';

export function DocsPage() {
  return (
    <>
      <section class="section docs-hero">
        <div class="container">
          <p class="eyebrow">Docs · for self-hosters</p>
          <h1 style="max-width: 22ch;">Register your IRC server with the directory.</h1>
          <p class="lead" style="margin-top: 20px;">
            If you run an IRC daemon — or you're about to — this is the short version of how to
            plug it into Boson's directory so users can discover and join it from the app.
          </p>
        </div>
      </section>

      <section class="section docs-content">
        <div class="container">
          <div class="docs-grid">
            <aside class="docs-sidebar">
              <h4>Self-host</h4>
              <ul>
                <li><a href="#start">Before you start</a></li>
                <li><a href="#daemon">Pick an IRCd</a></li>
                <li><a href="#verify">DNS TXT verification</a></li>
                <li><a href="#register">Submit to the directory</a></li>
                <li><a href="#health">Health &amp; re-verification</a></li>
              </ul>
              <h4>Reference</h4>
              <ul>
                <li><a href="#sasl">SASL requirements</a></li>
                <li><a href="#tls">TLS &amp; port choices</a></li>
                <li><a href="#delist">Removal &amp; appeals</a></li>
              </ul>
            </aside>

            <div class="docs-body">
              <article class="doc-section" id="start">
                <p class="eyebrow">01</p>
                <h2>Before you start.</h2>
                <p>
                  The directory only lists servers that meet four bars. None of them are about
                  hardware — they're about being a reachable, identifiable host that the Boson
                  client can SASL into without surprises.
                </p>
                <ul>
                  <li>A hostname (no IP-only servers — they're rejected).</li>
                  <li>TLS on a reachable port. Default is <span class="num">6697</span>, but any port works.</li>
                  <li>SASL PLAIN, EXTERNAL, or SCRAM-SHA-256. Anonymous-only servers can't list.</li>
                  <li>Control of the DNS record for the hostname you want to register.</li>
                </ul>
                <div class="doc-callout">
                  <strong>About anonymity:</strong> the directory does <em>not</em> require server
                  operators to identify themselves to us. It does require a DNS-verifiable hostname
                  and a contact address for moderation reports — neither of which need to point to
                  a real name.
                </div>
              </article>

              <article class="doc-section" id="daemon">
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
                  Charybdis, Solanum, ircu derivatives — it'll work. Open an issue if your daemon
                  needs documentation.
                </p>
              </article>

              <article class="doc-section" id="verify">
                <p class="eyebrow">03</p>
                <h2>DNS TXT verification.</h2>
                <p>
                  When you submit a server, the directory hands you a verification token. Add it as
                  a TXT record under <span class="num">_boson</span> on the hostname you're
                  registering, then click verify.
                </p>

                <ol class="step-list">
                  <li>
                    <h3>Get a verification token.</h3>
                    <p class="muted">
                      Sign in to Boson, go to{' '}
                      <strong>Settings → Server hosting → Register a server</strong>. You'll get a
                      one-time token bound to your account.
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
                  Once you're verified, you can <strong>leave the TXT record in place</strong>{' '}
                  (recommended) or remove it. The directory re-verifies weekly; if the record
                  disappears, you'll get a 14-day grace period before the listing is hidden.
                </div>
              </article>

              <article class="doc-section" id="register">
                <p class="eyebrow">04</p>
                <h2>Submit to the directory.</h2>
                <p>After verification, fill in the server profile. The four fields that matter:</p>
                <ul>
                  <li><strong>Name</strong> — short, human-readable. Shown in the directory list.</li>
                  <li><strong>Description</strong> — one paragraph. What's the community for? Who's it not for?</li>
                  <li><strong>Tags</strong> — pick from existing tags or propose new ones. Autocomplete helps.</li>
                  <li><strong>Languages</strong> — at least one. Drives the language filter for users.</li>
                </ul>
                <p>
                  NSFW servers must check the NSFW flag. The directory excludes them from default
                  search; users opt in via a toggle.
                </p>
              </article>

              <article class="doc-section" id="health">
                <p class="eyebrow">05</p>
                <h2>Health and re-verification.</h2>
                <p>Two automated checks run continuously:</p>
                <ul>
                  <li>
                    <strong>Health check</strong> — every 15 minutes. The directory connects to
                    your TLS port and reads the welcome banner. Offline servers stay listed but get
                    a <span class="num">"currently offline"</span> badge.
                  </li>
                  <li>
                    <strong>Re-verification</strong> — every 7 days. The TXT record is re-queried.
                    Lapsed records produce a hidden listing after a 14-day grace period; restoring
                    the record re-lists you immediately.
                  </li>
                </ul>
                <p>
                  Activity is sampled hourly via <span class="num">LUSERS</span>. The user count
                  you see in the directory is the median of the last six samples — a single empty
                  hour doesn't make your server look dead.
                </p>
              </article>

              <article class="doc-section" id="sasl">
                <p class="eyebrow">Reference</p>
                <h2>SASL requirements.</h2>
                <p>Boson registers nicks for users automatically over SASL. The client supports:</p>
                <ul>
                  <li><span class="num">PLAIN</span> — over TLS only. The simplest path; works on virtually every modern IRCd.</li>
                  <li><span class="num">SCRAM-SHA-256</span> — preferred when the daemon supports it. No plaintext password on the wire.</li>
                  <li><span class="num">EXTERNAL</span> — TLS client-cert auth. Useful for bots and operator handles, not the default for end users.</li>
                </ul>
                <p>
                  If your daemon offers all three, Boson will negotiate the strongest available.
                  There is no fallback to non-SASL nick registration — by design.
                </p>
              </article>

              <article class="doc-section" id="tls">
                <p class="eyebrow">Reference</p>
                <h2>TLS &amp; port choices.</h2>
                <p>
                  <strong>Port:</strong> the directory accepts any port. <span class="num">6697</span>{' '}
                  is the convention; <span class="num">7000</span> and <span class="num">9999</span>{' '}
                  are common alternatives. Avoid <span class="num">6667</span> — that's plaintext
                  IRC, and the directory rejects non-TLS hostnames.
                </p>
                <p>
                  <strong>Certificate:</strong> standard public-CA certs are fine (Let's Encrypt is
                  the typical path). Self-signed certs aren't supported — the Boson client
                  validates them strictly.
                </p>
                <p>
                  <strong>SNI:</strong> required. The hostname in the cert SAN must match the
                  hostname users see in the directory.
                </p>
              </article>

              <article class="doc-section" id="delist">
                <p class="eyebrow">Reference</p>
                <h2>Removal and appeals.</h2>
                <p>
                  Servers can be removed from the directory for one of three reasons. The directory
                  does not police speech on your server — it polices presence on the directory.
                </p>
                <ul>
                  <li><strong>Operator request.</strong> You ask. We remove. The hostname is freed up for re-registration after 30 days.</li>
                  <li><strong>Lapsed verification.</strong> TXT record missing for &gt; 14 days. Add it back to re-list automatically.</li>
                  <li><strong>Abuse.</strong> Repeated unreviewed reports tied to your server. We notify the contact address. Restoration is via the contact form.</li>
                </ul>
                <p>
                  The full moderation policy and appeals flow lives in{' '}
                  <a href="/about" class="docs-link">About → moderation</a>.
                </p>
              </article>
            </div>
          </div>
        </div>
      </section>

      <section class="section cta-strip docs-cta">
        <div class="container">
          <h2 style="margin-bottom: 16px;">Got your daemon running? Submit it.</h2>
          <p class="lead">
            Sign in to the desktop app, open Settings → Server hosting, and paste your hostname.
            The verification token is one click away.
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
