import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
import { Avatar } from './Avatar';

describe('Avatar', () => {
  it('renders the profile image when a url is given', () => {
    const { container } = render(<Avatar nick="alice" url="https://cdn.boson.chat/avatars/x.png" size={32} />);
    const img = container.querySelector('img.bds-avatar-image') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('https://cdn.boson.chat/avatars/x.png');
    expect(container.querySelector('.bds-avatar-has-image')).not.toBeNull();
  });

  it('falls back to the nick initial tile when no url', () => {
    const { container } = render(<Avatar nick="alice" size={32} />);
    expect(container.querySelector('img')).toBeNull();
    const tile = container.querySelector('.bds-avatar') as HTMLElement;
    expect(tile.textContent).toBe('A');
    // The nick-color hue is applied inline for the fallback.
    expect(tile.getAttribute('style')).toContain('--nick-color');
  });

  it('strips a status sigil for the initial', () => {
    const { container } = render(<Avatar nick="@bob" size={24} />);
    expect((container.querySelector('.bds-avatar') as HTMLElement).textContent).toBe('B');
  });
});
