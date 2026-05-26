import { Card, Badge } from '@boson/shared';
import { Terminal, Line, C } from '../components/Terminal/Terminal';
import './DownloadPage.css';

export function DownloadPage() {
  return (
    <>
      <section class="section hero download-hero">
        <div class="container" style="max-width: 720px;">
          <p class="eyebrow">Download · v0.4.2 · 2026-05-22</p>
          <h1>Get the Boson desktop client.</h1>
          <p class="lead" style="margin-top: 20px;">
            Native binaries for macOS, Windows, and Linux. The full app is about 110 MB and ships
            as a signed package — Electron UI, local Go process, OS keychain bindings.
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
                  <span class="dl-arch">Universal · Intel + Apple Silicon · 12.0+</span>
                  <div class="dl-actions">
                    <a class="btn btn-primary" href="#">Download Boson-0.4.2.dmg</a>
                    <a class="btn btn-secondary btn-sm" href="#">Homebrew cask</a>
                  </div>
                  <span class="dl-bytes">112 MB · SHA256 <span class="num">9f1c…3c4a</span></span>
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
                    <a class="btn btn-primary" href="#">Download Boson-0.4.2-Setup.exe</a>
                    <a class="btn btn-secondary btn-sm" href="#">winget install Boson</a>
                  </div>
                  <span class="dl-bytes">108 MB · signed by Boson Labs Ltd.</span>
                </div>
              </Card>
            </article>

            <article class="dl-card-wrap">
              <Card>
                <div class="dl-card">
                  <LinuxIcon />
                  <h3>Linux</h3>
                  <span class="dl-arch">x64 · AppImage · deb · rpm</span>
                  <div class="dl-actions">
                    <a class="btn btn-primary" href="#">Boson-0.4.2.AppImage</a>
                    <a class="btn btn-secondary btn-sm" href="#">.deb / .rpm packages</a>
                  </div>
                  <span class="dl-bytes">115 MB · GPG signed</span>
                </div>
              </Card>
            </article>
          </div>
          <p class="meta dl-meta-row">
            Need source?{' '}
            <a href="https://github.com" rel="noopener" class="dl-source-link">
              github.com/boson-chat/boson
            </a>{' '}
            · <span class="num">v0.4.2</span> tagged 2026-05-22 · MIT
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
                <Line prompt>shasum -a 256 Boson-0.4.2.dmg</Line>
                <Line><C tone="ok">9f1c0a4b…3c4a</C> &nbsp;Boson-0.4.2.dmg</Line>
                <Line />
                <Line><C tone="cmt"># 2. compare to the published checksum below</C></Line>
                <Line />
                <Line><C tone="cmt"># 3. verify the codesign / GPG signature</C></Line>
                <Line prompt>codesign --verify --deep --strict Boson.app</Line>
              </Terminal>
            </div>
            <div>
              <h3 style="margin-bottom: 12px; font-size: 16px;">Windows (PowerShell)</h3>
              <Terminal>
                <Line><C tone="cmt"># 1. compute the SHA-256 hash</C></Line>
                <Line prompt>Get-FileHash Boson-0.4.2-Setup.exe -Algorithm SHA256</Line>
                <Line />
                <Line><C tone="cmt"># 2. confirm publisher in the installer</C></Line>
                <Line>&nbsp;&nbsp;&nbsp;Right-click → Properties → Digital Signatures</Line>
                <Line>
                  &nbsp;&nbsp;&nbsp;Signer: <C tone="ok">Boson Labs Ltd.</C>
                </Line>
                <Line />
                <Line><C tone="cmt"># 3. SmartScreen may prompt on first launch — that's expected</C></Line>
                <Line><C tone="cmt">#    for new releases until the reputation builds.</C></Line>
              </Terminal>
            </div>
          </div>
          <Card>
            <div class="checksum-block">
              <h4>Published checksums · v0.4.2</h4>
              <pre>{`Boson-0.4.2.dmg                9f1c0a4b6f53e8f3a91d70b8e6cd2f44ab193e62b5a8e4c19e3d4d5f223c4a
Boson-0.4.2-Setup.exe          e08bd1a5fc7f4283c91ef1d4067b65c2a5e4f9b3d6f81720c4d3e1aa7f88b2c1
Boson-0.4.2.AppImage           74a3c2e5f1b8d069e3a4c2b91d57f8e0c6d4a9b2e3f5c1d7a8e6b94f0c2d3a5b`}</pre>
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
            <a class="btn btn-ghost btn-arrow" href="https://github.com" rel="noopener">
              Full changelog
            </a>
          </div>
          <div>
            <ReleaseRow
              date="2026-05-22"
              title="v0.4.2 — keychain re-bind on OS upgrade"
              platforms="all platforms"
            >
              macOS 14 → 15 upgrades no longer require re-entering the platform password. Fixes
              Linux libsecret silent-fail on missing collection.
            </ReleaseRow>
            <ReleaseRow
              date="2026-05-08"
              title="v0.4.1 — directory search relevance"
              platforms="all platforms"
            >
              Tag and language filters now combine with full-text search. Health-status freshness
              window dropped from 60 to 15 minutes.
            </ReleaseRow>
            <ReleaseRow
              date="2026-04-19"
              title="v0.4.0 — manual mode"
              platforms="all platforms"
            >
              Switch any server to manual credential mode. Boson stops deriving, you store the
              password yourself. Includes the NickServ <span class="num">SET PASSWORD</span>{' '}
              handoff.
            </ReleaseRow>
            <ReleaseRow
              date="2026-04-02"
              title="v0.3.7 — guided reclaim"
              platforms="all platforms"
            >
              When you lose your password, walk through per-server NickServ recovery without
              leaving the app. Email and admin-contact flows both supported.
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
            <a class="btn btn-primary" href="#">Download for your OS</a>
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
