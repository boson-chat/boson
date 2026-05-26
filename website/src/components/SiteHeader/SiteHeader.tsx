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
  { href: '/docs', label: 'Docs' },
  { href: '/about', label: 'About' },
  { href: 'https://github.com', label: 'GitHub', external: true },
];

export function SiteHeader() {
  const { path } = useLocation();
  return (
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
          class="btn btn-primary btn-sm"
          href="/download"
          aria-current={path === '/download' ? 'page' : undefined}
        >
          Download
        </a>
      </div>
    </header>
  );
}
