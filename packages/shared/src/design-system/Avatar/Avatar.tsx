import type { ComponentChildren } from 'preact';
import { StatusDot, type DotStatus } from '../StatusDot/StatusDot';
import './Avatar.css';

interface AvatarProps {
  /** Square edge in px. */
  size?: number;
  /** The letter shown when there's no image. */
  initial?: string;
  /** The tint behind the initial (a nick colour). */
  color?: string;
  /** The picture (an <img>); replaces the initial. */
  image?: ComponentChildren;
  /** A presence dot on the bottom-right corner. */
  status?: DotStatus;
  /** Ringing: a green ring that pulses (static under reduced motion). */
  ringing?: boolean;
  /** Faded (blocked people, offline). */
  dim?: boolean;
  /** Layout hook for the call site. */
  class?: string;
}

// Corner radius by size, from the three radius tokens: small tiles are
// sharper, big ones (the call screen) a little softer. Never a circle.
export function avatarRadius(size: number): 'sm' | 'md' | 'lg' {
  return size <= 20 ? 'sm' : size <= 48 ? 'md' : 'lg';
}

// Every avatar and placeholder tile: a rounded square with a picture or a
// tinted initial, and optionally a presence dot.
export function Avatar({ size = 24, initial, color, image, status, ringing = false, dim = false, class: extra }: AvatarProps) {
  const fontPx = Math.max(9, Math.round(size * 0.42));
  const dot = size >= 40 ? 12 : size >= 24 ? 10 : 8;
  const cls = [
    'bds-avatar',
    `bds-avatar-r-${avatarRadius(size)}`,
    image ? 'bds-avatar-has-image' : '',
    ringing ? 'bds-avatar-ringing' : '',
    size > 64 ? 'bds-avatar-lg' : '',
    dim ? 'bds-avatar-dim' : '',
    extra ?? '',
  ].filter(Boolean).join(' ');
  const style = `width:${size}px;height:${size}px;font-size:${fontPx}px${color && !image ? `;--nick-color:${color}` : ''}`;
  return (
    <span class={cls} style={style} aria-hidden="true">
      <span class="bds-avatar-tile">{image ?? initial}</span>
      {status && <StatusDot status={status} size={dot} ring class="bds-avatar-status" />}
    </span>
  );
}
