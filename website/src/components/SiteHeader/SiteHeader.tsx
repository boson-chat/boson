import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { BosonGlyph } from '@boson/shared';
import './SiteHeader.css';

interface NavLink {
  href: string;
  label: string;
  external?: boolean;
}

const NAV_LINKS: NavLink[] = [
  { href: '/', label: 'Overview' },
  { href: '/features', label: 'Features' },
  { href: '/discover', label: 'Discover' },
  { href: '/docs', label: 'Docs' },
  { href: '/about', label: 'About' },
  { href: 'https://github.com/boson-chat/boson', label: 'GitHub', external: true },
];

export function SiteHeader() {
  const { path } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  // Close the mobile menu on every route change. preact-iso re-renders
  // this component when `path` changes, so we just react to that. Also
  // close on Escape and lock body scroll while open — anything that
  // doesn't would let the page underneath scroll behind the overlay.
  useEffect(() => {
    setMenuOpen(false);
  }, [path]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [menuOpen]);

  return (
    <>
      <header class="topnav">
        <div class="container topnav-inner">
          <a class="topnav-logo" href="/" aria-label="Boson — Home">
            <BosonGlyph size={18} class="topnav-logo-mark" />
            <span>Boson</span>
          </a>
          <nav class="topnav-nav">
            {NAV_LINKS.map((link) =>
              link.external ? (
                <a key={link.href} href={link.href} rel="noopener">
                  {link.label}
                </a>
              ) : (
                <a
                  key={link.href}
                  href={link.href}
                  aria-current={path === link.href ? 'page' : undefined}
                >
                  {link.label}
                </a>
              ),
            )}
          </nav>
          <a
            class="btn btn-primary btn-sm topnav-download"
            href="/download"
            aria-current={path === '/download' ? 'page' : undefined}
          >
            Download
          </a>
          <button
            type="button"
            class={`topnav-burger ${menuOpen ? 'is-open' : ''}`}
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            onClick={() => setMenuOpen((v) => !v)}
          >
            {/* Three lines that morph into an X via CSS when .is-open is set. */}
            <span class="topnav-burger-line" />
            <span class="topnav-burger-line" />
            <span class="topnav-burger-line" />
          </button>
        </div>
      </header>

      {/* The mobile drawer is always in the DOM so we can animate enter
         AND exit (display:none would skip the exit). Pointer events +
         visibility are controlled by the .is-open class instead. */}
      <div
        id="mobile-menu"
        class={`mobile-menu ${menuOpen ? 'is-open' : ''}`}
        aria-hidden={!menuOpen}
        onClick={(e) => {
          // Tap on the backdrop (anywhere not on an interactive child)
          // dismisses. The inner panel stops propagation below.
          if (e.target === e.currentTarget) setMenuOpen(false);
        }}
      >
        <div class="mobile-menu-panel" onClick={(e) => e.stopPropagation()}>
          <nav class="mobile-menu-nav">
            {NAV_LINKS.map((link, i) =>
              link.external ? (
                <a
                  key={link.href}
                  href={link.href}
                  rel="noopener"
                  style={`--i: ${i};`}
                >
                  {link.label}
                </a>
              ) : (
                <a
                  key={link.href}
                  href={link.href}
                  aria-current={path === link.href ? 'page' : undefined}
                  style={`--i: ${i};`}
                >
                  {link.label}
                </a>
              ),
            )}
          </nav>
          <a
            class="btn btn-primary mobile-menu-cta"
            href="/download"
            aria-current={path === '/download' ? 'page' : undefined}
            style={`--i: ${NAV_LINKS.length};`}
          >
            Download Boson
          </a>
        </div>
      </div>
    </>
  );
}
