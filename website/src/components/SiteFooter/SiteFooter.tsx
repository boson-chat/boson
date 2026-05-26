import { BosonGlyph } from '@boson/shared';
import './SiteFooter.css';

export function SiteFooter() {
  return (
    <footer class="pagefoot">
      <div class="container">
        <div class="foot-cols">
          <div class="foot-col foot-col-brand">
            <a class="foot-logo" href="/">
              <BosonGlyph size={18} class="foot-logo-mark" />
              <span>Boson</span>
            </a>
            <p class="foot-tag">
              Desktop chat for IRC servers. Identity in the client, plumbing in the open.
            </p>
          </div>
          <div class="foot-col">
            <h4>Product</h4>
            <ul>
              <li><a href="/download">Download</a></li>
              <li><a href="/#how-it-works">How it works</a></li>
              <li><a href="/#gallery">Screenshots</a></li>
            </ul>
          </div>
          <div class="foot-col">
            <h4>For self-hosters</h4>
            <ul>
              <li><a href="/docs#register">Register a server</a></li>
              <li><a href="/docs#daemon">Pick an IRCd</a></li>
              <li><a href="/docs#verify">DNS TXT verification</a></li>
            </ul>
          </div>
          <div class="foot-col">
            <h4>Project</h4>
            <ul>
              <li><a href="/about">About</a></li>
              <li><a href="/about#security">Security model</a></li>
              <li><a href="https://github.com" rel="noopener">GitHub</a></li>
            </ul>
          </div>
        </div>
        <div class="row-between foot-base">
          <span>© Boson · 2026 · A directory and a client.</span>
          <span class="meta">Built on IRC. RFC 1459 · RFC 2812 · IRCv3.</span>
        </div>
      </div>
    </footer>
  );
}
