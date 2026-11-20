import { describe, it, expect } from 'vitest';
import { act, render } from '@testing-library/preact';
import { setAvatar } from '../../modules/chat/avatar-cache';
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

  it('without a url, finds the picture itself and updates when the cache fills', () => {
    const { container } = render(<Avatar nick="kestrel" size={36} />);
    expect(container.querySelector('img')).toBeNull();
    act(() => setAvatar('srv-1', 'Kestrel', 'https://cdn.boson.chat/avatars/k.png'));
    expect(container.querySelector('.bds-avatar-has-image')).not.toBeNull();
    act(() => setAvatar('srv-1', 'Kestrel', null));
  });

  it('prefers the account picture, and the given server', () => {
    setAvatar('srv-a', 'mira', 'https://x/a.png');
    setAvatar('srv-b', 'mira', 'https://x/b.png');
    const one = render(<Avatar nick="mira" serverId="srv-b" />);
    expect(one.container.querySelector('img')!.getAttribute('src')).toBe('https://x/b.png');
    const two = render(<Avatar nick="mira" accountUrl="https://x/acct.png" />);
    expect(two.container.querySelector('img')!.getAttribute('src')).toBe('https://x/acct.png');
    setAvatar('srv-a', 'mira', null);
    setAvatar('srv-b', 'mira', null);
  });

  it('a url prop, even undefined, is the answer: no lookup', () => {
    setAvatar('srv-a', 'juno', 'https://x/j.png');
    const { container } = render(<Avatar nick="juno" url={undefined} />);
    expect(container.querySelector('img')).toBeNull();
    setAvatar('srv-a', 'juno', null);
  });
});
