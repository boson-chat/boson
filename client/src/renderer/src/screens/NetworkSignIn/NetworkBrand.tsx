import type { JSX } from 'preact';
import { cssUrl, type NetworkBranding } from '../../modules/ui/theme';

// A network's branding on its sign-in screens (network themes): its logo
// and login background. Nothing when the network has none, or the user
// turned network themes off.

// The band at the top of "Sign in to <network>": the login background
// (dimmed) with the logo over it.
export function NetworkBrandHero({ brand, name }: { brand: NetworkBranding | null; name: string }) {
  if (!brand?.applied || (!brand.logo && !brand.loginBackground)) return null;
  return (
    <div
      class={`netauth-hero${brand.loginBackground ? ' netauth-hero-image' : ''}`}
      data-testid="network-brand-hero"
      style={brand.loginBackground ? { '--netauth-hero-image': `url("${cssUrl(brand.loginBackground)}")` } as JSX.CSSProperties : undefined}
    >
      {brand.logo && <img class="netauth-hero-logo" src={brand.logo} alt={`${name} logo`} draggable={false} />}
    </div>
  );
}

// The login screen's backdrop: the network's login background behind the
// form. Spread onto the .login-screen element.
export function loginBackdrop(brand: NetworkBranding | null): { class: string; style?: JSX.CSSProperties } {
  if (!brand?.applied || !brand.loginBackground) return { class: 'login-screen' };
  return {
    class: 'login-screen login-screen-branded',
    style: { '--login-bg-image': `url("${cssUrl(brand.loginBackground)}")` } as JSX.CSSProperties,
  };
}

// The network's logo in place of Boson's on the login screen.
export function NetworkLoginLogo({ brand, name }: { brand: NetworkBranding | null; name: string }) {
  if (!brand?.applied || !(brand.logoWide || brand.logo)) return null;
  return (
    <div class="login-network-logo">
      <img src={brand.logoWide ?? brand.logo} alt={`${name} logo`} draggable={false} />
    </div>
  );
}
