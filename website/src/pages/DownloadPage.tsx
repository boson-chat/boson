import { Card, Badge } from '@boson/shared';
import { Terminal, Line, C } from '../components/Terminal/Terminal';
import './DownloadPage.css';

// Single source of truth for what the page advertises. Bump these two when
// publishing a new release; everything below derives from them. Download
// URLs are version-less — electron-builder emits stable filenames so the
// /releases/latest/download/<file> pattern works for every release.
const RELEASE_VERSION = '0.0.3';
const RELEASE_DATE = '2026-05-26';
const REPO_URL = 'https://github.com/boson-chat/boson';
const RELEASE_URL = `${REPO_URL}/releases/tag/v${RELEASE_VERSION}`;
const LATEST_URL = `${REPO_URL}/releases/latest`;
const CHANGELOG_URL = `${REPO_URL}/blob/main/CHANGELOG.md`;
const DL = (name: string) => `${REPO_URL}/releases/latest/download/${name}`;

export function DownloadPage() {
  return (
    <>
      <section class="section hero download-hero">
        <div class="container" style="max-width: 720px;">
          <p class="eyebrow">Download · v{RELEASE_VERSION} · {RELEASE_DATE}</p>
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
            <article class="dl-card-wrap featured">
              <Card variant="raised">
                <div class="dl-card">
                  <MacIcon />
                  <Badge tone="info">Recommended</Badge>
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
                  <span class="dl-bytes">Unsigned for v0.0.x · right-click → Open on first launch</span>
                </div>
              </Card>
            </article>

            <article class="dl-card-wrap">
              <Card>
                <div class="dl-card">
                  <WinIcon />
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

            <article class="dl-card-wrap">
              <Card>
                <div class="dl-card">
                  <LinuxIcon />
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
            · <a class="num" href={RELEASE_URL} rel="noopener">v{RELEASE_VERSION}</a>{' '}
            tagged {RELEASE_DATE} · MIT
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
                <li>WebView2 runtime (auto-installed if missing)</li>
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
                <Line prompt>shasum -a 256 Boson-{RELEASE_VERSION}.dmg</Line>
                <Line><C tone="ok">…</C> &nbsp;Boson-{RELEASE_VERSION}.dmg</Line>
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
                <Line prompt>Get-FileHash Boson-Setup-{RELEASE_VERSION}.exe -Algorithm SHA256</Line>
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
              date={RELEASE_DATE}
              title={`v${RELEASE_VERSION} — initial release`}
              platforms="all platforms"
            >
              First public build. Multi-server IRC chat, server directory, guest mode, local Go
              IRC bridge bundled as a sidecar. See the{' '}
              <a href={RELEASE_URL} rel="noopener">release page</a> for the asset list.
            </ReleaseRow>
          </div>
        </div>
      </section>

      <section class="section cta-strip download-cta">
        <div class="container">
          <h2 style="margin-bottom: 20px;">
            First time? Start with macOS or Windows — Linux works, but the keychain story is the
            loudest there.
          </h2>
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
