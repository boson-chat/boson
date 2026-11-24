import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import { ServerDetails } from './DirectoryScreen';
import type { Server } from '../../modules/directory';

const server = (over: Partial<Server> = {}): Server => ({
  id: 's1', hostname: 'irc.example.org', port: 6697, tls: true, name: 'Example',
  tags: [], languages: ['en'], is_nsfw: false, is_featured: false,
  verification_status: 'verified', health_status: 'up', registered_at: '2026-01-01',
  channels: ['#help'], ...over,
});

describe('ServerDetails', () => {
  it('Connect, and Join a channel (connects and joins it)', () => {
    const onConnect = vi.fn();
    const s = server();
    render(<ServerDetails server={s} connected={false} canConnect onConnect={onConnect} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Join #help' }));
    expect(onConnect).toHaveBeenCalledWith(s, '#help');
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(onConnect).toHaveBeenLastCalledWith(s);
  });

  it('an offline server offers no Connect or Join', () => {
    render(<ServerDetails server={server({ health_status: 'down' })} connected={false} canConnect onConnect={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Offline' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Join #help' })).toBeNull();
  });
});
