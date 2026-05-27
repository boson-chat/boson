import { useEffect, useState } from 'preact/hooks';
import { Card, Badge } from '@boson/shared';
import { Terminal, Line, C } from '../components/Terminal/Terminal';
import { useLatestRelease } from '../hooks/useLatestRelease';
import './DownloadPage.css';

type DetectedOS = 'mac' | 'windows' | 'linux' | null;

/**
 * Best-effort OS detection from navigator. Runs after hydration so the
 * initial paint shows no "Recommended" badge anywhere — better to skip
 * the highlight for one frame than to highlight the wrong card on every
 * visit. Modern browsers expose userAgentData with a structured platform
 * field; older ones still hand us a userAgent string we can sniff.
 */
function detectOS(): DetectedOS {
  if (typeof navigator === 'undefined') return null;
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const platform = (uaData?.platform ?? navigator.platform ?? '').toLowerCase();
  const ua = (navigator.userAgent ?? '').toLowerCase();
  if (platform.includes('mac') || ua.includes('mac os')) return 'mac';
  if (platform.includes('win') || ua.includes('windows')) return 'windows';
  if (platform.includes('linux') || ua.includes('linux')) return 'linux';
  return null;
}

// Repo + download URL templates. Versionless paths (releases/latest/...)
// are what we hand visitors so each link keeps working across every
// future release; the eyebrow / changelog row pull the actual
// version+date from the live GitHub Releases API via useLatestRelease.
const REPO_URL = 'https://github.com/boson-chat/boson';
const LATEST_URL = `${REPO_URL}/releases/latest`;
const CHANGELOG_URL = `${REPO_URL}/blob/main/CHANGELOG.md`;
const DL = (name: string) => `${REPO_URL}/releases/latest/download/${name}`;

export function DownloadPage() {
  // useState seeded with null so SSR / first-paint HTML has no card
  // marked "Recommended". useEffect kicks in on the client only and
  // re-renders with the detected OS so the matching card lights up.
  const [os, setOS] = useState<DetectedOS>(null);
  useEffect(() => { setOS(detectOS()); }, []);
  const release = useLatestRelease();
  const releaseUrl = release.source === 'github'
    ? release.url
    : `${REPO_URL}/releases/tag/v${release.version}`;
  const wrapClass = (target: DetectedOS) =>
    `dl-card-wrap${os === target ? ' featured' : ''}`;
  const cardVariant = (target: DetectedOS) => (os === target ? 'raised' : undefined);
  const recommended = (target: DetectedOS) =>
    os === target ? <Badge tone="info">Recommended for your OS</Badge> : null;
  return (
    <>
      <section class="section hero download-hero">
        <div class="container" style="max-width: 720px;">
          <p class="eyebrow">
            Download · v{release.version}{release.releaseDate ? ` · ${release.releaseDate}` : ''}
          </p>
          <h1>Get the Boson desktop client.</h1>
          <p class="lead" style="margin-top: 20px;">
            Native installers for macOS, Windows, and Linux — Electron UI with the local Go IRC
            bridge bundled in. Pick your platform; assets live on the GitHub release page.
          </p>
        </div>
      </section>

      <section class="section download-grid-section">
        <div class="container">
          <div class="dl-grid">
            <article class={wrapClass('mac')}>
              <Card variant={cardVariant('mac')}>
                <div class="dl-card">
                  <MacIcon />
                  {recommended('mac')}
                  <h3>macOS</h3>
                  <span class="dl-arch">12.0+ · Apple Silicon or Intel</span>
                  <div class="dl-actions">
                    <a class="btn btn-primary" href={DL('Boson-mac-arm64.dmg')} rel="noopener">
                      Apple Silicon (.dmg)
                    </a>
                    <a class="btn btn-secondary btn-sm" href={DL('Boson-mac-x64.dmg')} rel="noopener">
                      Intel (.dmg)
                    </a>
                  </div>
                  <span class="dl-bytes">
                    Unverified developer · see{' '}
                    <a href="#first-launch-macos">first-launch notes</a>
                  </span>
                </div>
              </Card>
            </article>

            <article class={wrapClass('windows')}>
              <Card variant={cardVariant('windows')}>
                <div class="dl-card">
                  <WinIcon />
                  {recommended('windows')}
                  <h3>Windows</h3>
                  <span class="dl-arch">x64 · Windows 10 / 11</span>
                  <div class="dl-actions">
                    <a class="btn btn-primary" href={DL('Boson-Setup.exe')} rel="noopener">
                      Installer (.exe)
                    </a>
                  </div>
                  <span class="dl-bytes">Unsigned for v0.0.x · SmartScreen will warn on first launch</span>
                </div>
              </Card>
            </article>

            <article class={wrapClass('linux')}>
              <Card variant={cardVariant('linux')}>
                <div class="dl-card">
                  <LinuxIcon />
                  {recommended('linux')}
                  <h3>Linux</h3>
                  <span class="dl-arch">x64 · AppImage or Debian/Ubuntu</span>
                  <div class="dl-actions">
                    <a class="btn btn-primary" href={DL('Boson-linux-x86_64.AppImage')} rel="noopener">
                      AppImage
                    </a>
                    <a class="btn btn-secondary btn-sm" href={DL('Boson-linux-amd64.deb')} rel="noopener">
                      .deb (Debian/Ubuntu)
                    </a>
                  </div>
                  <span class="dl-bytes">AppImage is self-contained; .deb installs system-wide</span>
                </div>
              </Card>
            </article>
          </div>
          <p class="meta dl-meta-row">
            Source:{' '}
            <a href={REPO_URL} rel="noopener" class="dl-source-link">
              github.com/boson-chat/boson
            </a>{' '}
            · <a class="num" href={releaseUrl} rel="noopener">v{release.version}</a>
            {release.releaseDate ? ` tagged ${release.releaseDate}` : ''} · MIT
          </p>
        </div>
      </section>

      <section class="section">
        <div class="container stack" style="gap: 40px;">
          <div style="max-width: 38ch;">
            <p class="eyebrow">System requirements</p>
            <h2>Minimums, not aspirations.</h2>
          </div>
          <div class="reqs-grid">
            <div>
              <h3>macOS</h3>
              <ul>
                <li>macOS 12 Monterey or newer</li>
                <li>250 MB free disk</li>
                <li>Keychain access for credential storage</li>
                <li>Outbound TCP/TLS to your servers (port 6697 by default)</li>
              </ul>
            </div>
            <div>
              <h3>Windows</h3>
              <ul>
                <li>Windows 10 (build 19041+) or Windows 11</li>
                <li>250 MB free disk</li>
                <li>Credential Manager available (default)</li>
                <li>No extra runtime — Chromium ships inside the installer</li>
              </ul>
            </div>
            <div>
              <h3>Linux</h3>
              <ul>
                <li>glibc 2.31+ (Ubuntu 20.04+, Fedora 33+, Debian 11+)</li>
                <li>libsecret + Secret Service backend (GNOME Keyring, KWallet)</li>
                <li>Wayland or X11 supported</li>
                <li>Optional: <span class="num">libfuse2</span> for the AppImage build</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="container stack" style="gap: 40px;">
          <div style="max-width: 38ch;">
            <p class="eyebrow">Verify your download</p>
            <h2>Three commands, one minute.</h2>
          </div>
          <div class="grid-2" style="gap: 48px; align-items: start;">
            <div>
              <h3 style="margin-bottom: 12px; font-size: 16px;">macOS · Linux</h3>
              <Terminal>
                <Line><C tone="cmt"># 1. compute the SHA-256 of the package you downloaded</C></Line>
                <Line prompt>shasum -a 256 Boson-mac-arm64.dmg</Line>
                <Line><C tone="ok">…</C> &nbsp;Boson-mac-arm64.dmg</Line>
                <Line />
                <Line><C tone="cmt"># 2. compare against the checksum on the release page</C></Line>
                <Line><C tone="cmt">#    {LATEST_URL}</C></Line>
                <Line />
                <Line><C tone="cmt"># 3. v0.0.x ships unsigned — Gatekeeper will prompt</C></Line>
                <Line><C tone="cmt">#    right-click → Open the first time to bypass</C></Line>
              </Terminal>
            </div>
            <div>
              <h3 style="margin-bottom: 12px; font-size: 16px;">Windows (PowerShell)</h3>
              <Terminal>
                <Line><C tone="cmt"># 1. compute the SHA-256 hash</C></Line>
                <Line prompt>Get-FileHash Boson-Setup.exe -Algorithm SHA256</Line>
                <Line />
                <Line><C tone="cmt"># 2. compare against the checksum on the release page</C></Line>
                <Line><C tone="cmt">#    {LATEST_URL}</C></Line>
                <Line />
                <Line><C tone="cmt"># 3. v0.0.x ships unsigned — SmartScreen will warn</C></Line>
                <Line><C tone="cmt">#    "More info" → "Run anyway" the first time</C></Line>
              </Terminal>
            </div>
          </div>
          <Card>
            <div class="checksum-block">
              <h4>Checksums</h4>
              <p style="margin: 0;">
                SHA-256 checksums and the full asset list are published on the GitHub release page:{' '}
                <a href={LATEST_URL} rel="noopener">{LATEST_URL}</a>
              </p>
            </div>
          </Card>
        </div>
      </section>

      <section class="section" id="first-launch-macos">
        <div class="container stack" style="gap: 28px;">
          <div style="max-width: 42ch;">
            <p class="eyebrow">First launch on macOS</p>
            <h2>One extra step on Apple Silicon.</h2>
          </div>
          <p style="max-width: 72ch;">
            v0.0.x ships ad-hoc signed — enough for macOS to load the binary, but the app isn't
            registered with an Apple Developer ID yet, so Gatekeeper marks it as "unverified
            developer" on first launch. Two ways past that:
          </p>
          <div class="grid-2" style="gap: 32px; align-items: start;">
            <div>
              <h3 style="margin-bottom: 12px; font-size: 16px;">Easier: right-click → Open</h3>
              <p class="muted" style="margin-bottom: 12px;">
                In Finder, right-click <strong>Boson.app</strong> in /Applications, choose
                <strong> Open</strong>, then confirm in the dialog. macOS remembers the
                exception; from then on it launches normally.
              </p>
            </div>
            <div>
              <h3 style="margin-bottom: 12px; font-size: 16px;">Faster: strip the quarantine bit</h3>
              <p class="muted" style="margin-bottom: 12px;">
                Run this once in Terminal — drops the <span class="num">com.apple.quarantine</span>{' '}
                attribute Safari sets on downloaded apps:
              </p>
              <Terminal>
                <Line prompt>xattr -cr /Applications/Boson.app</Line>
              </Terminal>
            </div>
          </div>
          <p class="muted" style="max-width: 72ch;">
            On Windows, SmartScreen will show a "Windows protected your PC" prompt the first time —
            click <strong>More info</strong> then <strong>Run anyway</strong>. Linux installers
            don't need any of this.
          </p>
        </div>
      </section>

      <section class="section">
        <div class="container stack" style="gap: 40px;">
          <div class="row-between">
            <div style="max-width: 38ch;">
              <p class="eyebrow">Release notes</p>
              <h2>Recent builds.</h2>
            </div>
            <a class="btn btn-ghost btn-arrow" href={CHANGELOG_URL} rel="noopener">
              Full changelog
            </a>
          </div>
          <div>
            <ReleaseRow
              date={release.releaseDate || '—'}
              title={`v${release.version} — latest`}
              platforms="all platforms"
            >
              The current desktop build. Multi-server IRC chat, server directory, guest mode,
              local Go IRC bridge bundled as a sidecar. See the{' '}
              <a href={releaseUrl} rel="noopener">release page</a> for the full asset list and
              the changelog entry for what's new.
            </ReleaseRow>
          </div>
        </div>
      </section>

      <section class="section cta-strip download-cta">
        <div class="container">
          <h2 style="margin-bottom: 20px;">Ready when you are.</h2>
          <p class="lead" style="margin-bottom: 32px;">
            The desktop client is the same on every platform — pick whichever installer matches
            the machine you're on.
          </p>
          <div class="hero-cta" style="justify-content: center;">
            <a class="btn btn-primary" href={LATEST_URL} rel="noopener">
              See all platforms on GitHub
            </a>
            <a class="btn btn-secondary" href="/docs">Self-hosting guide</a>
          </div>
        </div>
      </section>
    </>
  );
}

import type { ComponentChildren } from 'preact';

interface ReleaseRowProps {
  date: string;
  title: string;
  platforms: string;
  children: ComponentChildren;
}

function ReleaseRow({ date, title, platforms, children }: ReleaseRowProps) {
  return (
    <div class="release-row">
      <span class="meta">{date}</span>
      <div>
        <h3 class="release-title">{title}</h3>
        <p class="release-body">{children}</p>
      </div>
      <span class="meta release-platforms">{platforms}</span>
    </div>
  );
}

function MacIcon() {
  return (
    <svg class="os-mark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M16.4 1.2c0 1-.4 2-1 2.7-.7.8-1.8 1.4-2.9 1.3-.1-1 .4-2 1-2.7.7-.8 1.9-1.4 2.9-1.3zM20 17.6c-.6 1.4-1 2-1.7 3.2-1 1.7-2.4 3.7-4.1 3.7-1.5 0-1.9-.9-3.9-.9-2 0-2.5.9-3.9.9-1.7 0-3-1.9-4-3.6-2.7-4.4-3-9.5-1.3-12.2 1.2-1.9 3-3 4.8-3 1.7 0 2.8 1 4.3 1 1.4 0 2.2-1 4.3-1 1.6 0 3.2.9 4.4 2.4-3.8 2.1-3.2 7.6.1 9.5z" />
    </svg>
  );
}

function WinIcon() {
  return (
    <svg class="os-mark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M3 5.5l8-1.1v7.5H3V5.5zm0 13l8 1.1v-7.5H3v6.4zm9-14.3L22 3v8.9H12V4.2zm0 9.7v7.9l10 1.4v-9.3H12z" />
    </svg>
  );
}

function LinuxIcon() {
  return (
    <svg
      class="os-mark"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2c-2.5 0-4 2.2-4 5 0 1.5.4 2.6.4 3.6 0 1.1-.8 1.9-1.6 2.7C5.6 14.6 4 16 4 18c0 2 1.6 3 3 3h10c1.4 0 3-1 3-3 0-2-1.6-3.4-2.8-4.7-.8-.8-1.6-1.6-1.6-2.7 0-1 .4-2.1.4-3.6 0-2.8-1.5-5-4-5z" />
      <circle cx="10" cy="8" r="0.7" fill="currentColor" />
      <circle cx="14" cy="8" r="0.7" fill="currentColor" />
    </svg>
  );
}
