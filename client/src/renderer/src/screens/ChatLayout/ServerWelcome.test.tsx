import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/preact';
import { ServerWelcome, welcomeChannels } from './ServerWelcome';

describe('welcomeChannels', () => {
  it('the listing\'s channels first, then the busiest of the server\'s list, no repeats', () => {
    const dir = [
      { name: '#quiet', userCount: 2, topic: '' },
      { name: '#Lobby', userCount: 9, topic: '\x02Hi\x02 all' },
      { name: '#busy', userCount: 80, topic: 'lots' },
    ];
    expect(welcomeChannels(['#lobby', '#news'], dir, 4)).toEqual([
      { name: '#Lobby', userCount: 9, topic: 'Hi all' },
      { name: '#news' },
      { name: '#busy', userCount: 80, topic: 'lots' },
      { name: '#quiet', userCount: 2, topic: '' },
    ]);
  });
});

describe('ServerWelcome', () => {
  it('describes the server and joins a channel or opens the browser', () => {
    const onJoin = vi.fn();
    const onBrowse = vi.fn();
    render(<ServerWelcome serverName="Boson" description="A friendly place" channels={[{ name: '#lobby', userCount: 3 }]} onJoin={onJoin} onBrowse={onBrowse} />);
    expect(screen.getByRole('region', { name: 'Welcome to Boson' })).toHaveTextContent('A friendly place');
    expect(screen.getByText('3 people')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Join #lobby' }));
    expect(onJoin).toHaveBeenCalledWith('#lobby');
    fireEvent.click(screen.getByRole('button', { name: 'Browse all channels' }));
    expect(onBrowse).toHaveBeenCalled();
  });
});
