import { Card } from '@boson/shared';
import './AboutPage.css';

interface TocEntry {
  id: string;
  label: string;
  index: string;
}

const TOC: TocEntry[] = [
  { id: 'problem', index: '01', label: 'The problem' },
  { id: 'design', index: '02', label: 'Design decisions' },
  { id: 'security', index: '03', label: 'Security model' },
  { id: 'not-doing', index: '04', label: "What we won't build" },
  { id: 'free', index: '05', label: 'On being free' },
  { id: 'roadmap', index: '06', label: 'Where we are' },
  { id: 'who', index: '07', label: 'Who made this' },
];

export function AboutPage() {
  return (
    <>
      <section class="section essay-section">
        <div class="container">
          <div class="essay-grid">
            <aside class="essay-toc">
              <h4>In this piece</h4>
              <ul>
                {TOC.map((entry) => (
                  <li key={entry.id}>
                    <a href={`#${entry.id}`}>
                      <span class="toc-counter">{entry.index}</span>
                      {entry.label}
                    </a>
                  </li>
                ))}
              </ul>
            </aside>

            <article class="essay">
              <div class="essay-meta">
                <span>About</span>
                <span>·</span>
                <span>2026-05-24</span>
                <span>·</span>
                <span>4 min read</span>
              </div>
              <h1>Why build a Discord clone on top of IRC in 2026?</h1>
              <p class="essay-lead">
                Because the protocol is good and the clients are bad. Most people don't want IRC —
                they want chat. We want both, and we don't see why anyone should have to choose.
              </p>

              <h2 id="problem">The problem we're solving.</h2>
              <p>
                IRC has been carrying group chat reliably since 1988. It is small, well-specified,
                federated, self-hostable, and supported by a dozen independent server
                implementations. None of that has changed.
              </p>
              <p>
                What changed is that the people you most want to talk to no longer use it. They use
                Slack and Discord — products that demand an account on a single vendor's server,
                that go down when the vendor goes down, and that gate access to the conversation
                behind that vendor's continued goodwill.
              </p>
              <p>
                The reason isn't that Discord is technically better. It's that Discord has a usable
                client and IRC has 30 years of clients that ship with a config file.{' '}
                <strong>The protocol is fine. The product is the problem.</strong>
              </p>

              <div class="pull-quote">
                Boson is what happens when you accept that IRC is the right substrate, and that the
                substrate isn't enough.
              </div>

              <h2 id="design">Design decisions, in plain words.</h2>

              <h3>1. Hide IRC.</h3>
              <p>
                If you're a normal user, you should never see the letters <span class="num">SASL</span>.
                You shouldn't have to pick a nick separate from your username. You shouldn't have to
                know that <span class="num">/msg NickServ identify</span> is a thing. The app
                handles all of that on your behalf, every time it connects.
              </p>
              <p>
                If you're a power user, you can still connect with weechat. That isn't an escape
                hatch — it's a load-bearing feature. The day Boson stops being the best IRC client
                is the day you can leave without losing your identity, your channels, or your
                servers.
              </p>

              <h3>2. Keep identity client-side.</h3>
              <p>
                The directory holds a list of servers and an encrypted bag of bytes for each user.
                We can't read the bag. We can't help you recover it. Your platform password derives
                a key that unlocks it, locally, on your machine. That key produces a unique
                credential for every server you join.
              </p>
              <p>
                The honest part: there's no recovery. If you lose your password, the bag is gone.
                We provide guided per-server reclaim via NickServ — but that's the recovery, not us
                re-deriving anything.
              </p>

              <h3>3. Build a directory, not a network.</h3>
              <p>
                We don't run IRC servers. We index them. Self-hosters add a TXT record and they're
                on the directory. If we vanish tomorrow, the network keeps running and your{' '}
                <span class="num">weechat</span> setup keeps working — because the directory was
                the only piece that depended on us.
              </p>
              <p>
                This is the part that took the longest to get right. The temptation is always to
                hold more — host the daemons, run a "platform server," become the thing instead of
                the thing-finder. We resisted, and we're going to keep resisting.
              </p>

              <h2 id="security">The security model in one diagram.</h2>
              <p>
                Two things have to stay true for this to be honest. First, the directory cannot
                recover your <span class="num">user_secret</span>. Second, a breach of one IRC
                server cannot help an attacker on another. Both fall out of the same construction:
              </p>

              <div class="security-grid">
                <Card>
                  <div class="sec-card-inner">
                    <h4>What we hold</h4>
                    <p>
                      An <strong>encrypted</strong> 32-byte secret per user. Encrypted with a key
                      we don't possess and can't derive. Your handle, server links, and reports —
                      also stored, also under per-table auth.
                    </p>
                  </div>
                </Card>
                <Card>
                  <div class="sec-card-inner">
                    <h4>What you hold</h4>
                    <p>
                      A platform password. From it, the local Go process derives the key that
                      unlocks the secret. From the secret, we HMAC a unique password per server.{' '}
                      <strong>Nothing crosses the network in the clear.</strong>
                    </p>
                  </div>
                </Card>
              </div>
              <p class="essay-fine">
                The Boson client is open source. The derivation, the storage path, the keychain
                bindings — all readable, all auditable. If you're the kind of person who wants to
                read it before trusting it, that's exactly the kind of person we want reading it.
              </p>

              <h2 id="not-doing">What we're deliberately not doing.</h2>
              <ul>
                <li>
                  <strong>Voice, video, threads, reactions, slash-commands.</strong> IRC doesn't
                  carry these. We are not going to build a parallel metadata layer that secretly
                  turns Boson into a non-IRC service that happens to use IRC for text transport.
                  That's a different product.
                </li>
                <li>
                  <strong>Hosted IRC servers.</strong> The directory only indexes. We've sketched a
                  hosted offering for later — it's deferred, deliberately, until the directory side
                  is solid.
                </li>
                <li>
                  <strong>Account recovery.</strong> The cryptography is one-way on purpose. The
                  guided per-server reclaim is the recovery; there is no other recovery, and there
                  isn't going to be one.
                </li>
                <li>
                  <strong>Friends lists and cross-server social graphs.</strong> Profiles, yes. A
                  search-engine-grade graph of who-talks-to-whom, no. Not in MVP, probably not
                  after.
                </li>
              </ul>

              <h2 id="free">On being free.</h2>
              <p>
                Boson is free right now, and we don't know what comes after. We don't want to lie
                about that. The likely path is a paid tier for self-hosters who'd rather have us
                run the IRC daemon for them — but that's months out, conditional on the directory
                side being healthy.
              </p>
              <p>
                What is <em>not</em> the plan: charging end users, monetizing identity, ads, "AI
                features," selling the directory data, or any other variation on extracting rent
                from people who showed up to chat with their friends.
              </p>

              <h2 id="roadmap">Where we are.</h2>
              <ol class="roadmap">
                <li class="shipped">
                  <span class="when">Shipped</span>
                  <span>
                    <strong>v0.4 series.</strong> Identity, directory, DNS verification, manual
                    mode, guided reclaim, macOS &amp; Windows &amp; Linux builds.
                  </span>
                </li>
                <li>
                  <span class="when">Next</span>
                  <span>
                    <strong>UI polish &amp; notifications.</strong> Mention highlighting,
                    system-tray presence, per-server mute, OS-level notifications with
                    click-through.
                  </span>
                </li>
                <li>
                  <span class="when">After</span>
                  <span>
                    <strong>Moderation tooling.</strong> Report queue, server-operator dashboards,
                    appeals flow — work begins once volume justifies it.
                  </span>
                </li>
                <li>
                  <span class="when">Later</span>
                  <span>
                    <strong>Hosted IRCds in k8s.</strong> The paid path. Conditional on the
                    directory being healthy, the protocol stays the same.
                  </span>
                </li>
              </ol>

              <h2 id="who">Who made this.</h2>
              <p>
                A small team that's been on Discord, Slack, IRC, Matrix, XMPP, and most of the
                things in between, and is tired of having to pick. If you want to help — read the
                code, run an IRCd, register it, tell us what we got wrong.
              </p>
              <p class="essay-signoff">
                — The Boson team ·{' '}
                <a class="num" href="https://github.com/boson-chat/boson" rel="noopener">
                  github.com/boson-chat/boson
                </a>{' '}
                · <a href="mailto:hi@boson.chat">hi@boson.chat</a>
              </p>
            </article>
          </div>
        </div>
      </section>

      <section class="section cta-strip about-cta">
        <div class="container">
          <h2 style="margin-bottom: 16px;">Try the desktop client.</h2>
          <p class="lead">
            A 110 MB download. About a minute from install to first message. Free, and if it ever
            isn't, we'll tell you on this page first.
          </p>
          <div class="hero-cta" style="justify-content: center;">
            <a class="btn btn-primary" href="/download">Download Boson</a>
            <a class="btn btn-secondary" href="/docs">Self-host a server</a>
          </div>
        </div>
      </section>
    </>
  );
}
