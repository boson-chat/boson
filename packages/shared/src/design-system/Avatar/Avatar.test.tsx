import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
import { Avatar, avatarRadius } from './Avatar';

describe('Avatar', () => {
  it('shows the initial tinted by the colour', () => {
    const { container } = render(<Avatar size={32} initial="K" color="#ff0000" />);
    const el = container.querySelector('.bds-avatar') as HTMLElement;
    expect(el.textContent).toBe('K');
    expect(el.getAttribute('style')).toMatch(/--nick-color: ?#ff0000/);
    expect(el.getAttribute('style')).toMatch(/width: ?32px/);
  });
  it('shows the image instead, untinted', () => {
    const { container } = render(<Avatar size={32} initial="K" color="#f00" image={<img src="x.png" alt="" />} />);
    expect(container.querySelector('img')).toBeTruthy();
    expect(container.querySelector('.bds-avatar-has-image')).toBeTruthy();
    expect(container.querySelector('.bds-avatar')!.getAttribute('style')).not.toContain('--nick-color');
  });
  it('a status dot, ringing and dim', () => {
    const { container } = render(<Avatar size={40} initial="A" status="online" ringing dim />);
    expect(container.querySelector('.bds-avatar-status.bds-dot-online')).toBeTruthy();
    expect(container.querySelector('.bds-avatar-ringing')).toBeTruthy();
    expect(container.querySelector('.bds-avatar-dim')).toBeTruthy();
  });
  it('is never a circle: radius by size from the tokens', () => {
    expect(avatarRadius(18)).toBe('sm');
    expect(avatarRadius(36)).toBe('md');
    expect(avatarRadius(120)).toBe('lg');
  });
});
