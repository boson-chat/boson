import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, fireEvent } from '@testing-library/preact';
import { ChatArea } from './ChatArea';
import {
  LocalStorageServiceCredentialsStore,
  setServiceCredentialsStore,
  getServiceCredentialsStore,
} from '../../modules/chat/services-credentials';
import type { ChatChannel } from '../../modules/chat';

// Pending-confirmation banner sits between the chat header and the
// MessageList. It subscribes to the credentials store keyed by the
// active server id and renders only when status==='pending-
// confirmation'. These tests pin the visibility transitions + the
// Open-settings click path.

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
    clear: () => { m.clear(); },
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
  };
}

let saved: ReturnType<typeof getServiceCredentialsStore>;
beforeEach(() => {
  saved = getServiceCredentialsStore();
  setServiceCredentialsStore(new LocalStorageServiceCredentialsStore(memStorage()));
});
afterEach(() => {
  setServiceCredentialsStore(saved);
});

function activeChannel(): ChatChannel {
  return {
    name: '#general',
    joined: true,
    members: [],
    messages: [],
    typing: [],
    unread: 0,
    mentions: 0,
    topic: '',
  };
}

describe('ChatArea — pending-confirmation banner', () => {
  it('does NOT render when status is not pending-confirmation', () => {
    getServiceCredentialsStore().set('libera', {
      nickservPassword: 'pw',
      status: 'identified',
    });
    const { container } = render(
      <ChatArea
        channel={activeChannel()}
        myNick="alice"
        onSend={vi.fn()}
        activeServerId="libera"
        serverName="Libera"
      />,
    );
    expect(container.querySelector('.chat-pending-confirm-banner')).toBeNull();
  });

  it('renders when status === pending-confirmation, with server name in the copy', () => {
    getServiceCredentialsStore().set('libera', {
      status: 'pending-confirmation',
      email: 'alice@example.com',
    });
    const { container } = render(
      <ChatArea
        channel={activeChannel()}
        myNick="alice"
        onSend={vi.fn()}
        activeServerId="libera"
        serverName="Libera"
      />,
    );
    const banner = container.querySelector('.chat-pending-confirm-banner');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toMatch(/Confirm your registration on Libera/);
  });

  it('falls back to a server-name-less message when serverName is omitted', () => {
    getServiceCredentialsStore().set('libera', { status: 'pending-confirmation' });
    const { container } = render(
      <ChatArea
        channel={activeChannel()}
        myNick="alice"
        onSend={vi.fn()}
        activeServerId="libera"
      />,
    );
    const banner = container.querySelector('.chat-pending-confirm-banner');
    expect(banner?.textContent).toMatch(/Confirm your registration\./);
  });

  it('self-dismisses when status transitions away from pending-confirmation', () => {
    getServiceCredentialsStore().set('libera', { status: 'pending-confirmation' });
    const { container } = render(
      <ChatArea
        channel={activeChannel()}
        myNick="alice"
        onSend={vi.fn()}
        activeServerId="libera"
        serverName="Libera"
      />,
    );
    expect(container.querySelector('.chat-pending-confirm-banner')).not.toBeNull();
    // Simulate the ChatService classifier writing a confirmed status
    // after CONFIRM lands.
    act(() => {
      getServiceCredentialsStore().set('libera', { status: 'registered' });
    });
    expect(container.querySelector('.chat-pending-confirm-banner')).toBeNull();
  });

  it('Open settings button fires the onOpenServerSettings callback', () => {
    const onOpenServerSettings = vi.fn();
    getServiceCredentialsStore().set('libera', { status: 'pending-confirmation' });
    const { container } = render(
      <ChatArea
        channel={activeChannel()}
        myNick="alice"
        onSend={vi.fn()}
        activeServerId="libera"
        serverName="Libera"
        onOpenServerSettings={onOpenServerSettings}
      />,
    );
    const link = container.querySelector('.chat-pending-confirm-link') as HTMLButtonElement;
    expect(link).not.toBeNull();
    fireEvent.click(link);
    expect(onOpenServerSettings).toHaveBeenCalledOnce();
  });

  it('omits the Open settings button when no handler is wired', () => {
    getServiceCredentialsStore().set('libera', { status: 'pending-confirmation' });
    const { container } = render(
      <ChatArea
        channel={activeChannel()}
        myNick="alice"
        onSend={vi.fn()}
        activeServerId="libera"
        serverName="Libera"
      />,
    );
    expect(container.querySelector('.chat-pending-confirm-link')).toBeNull();
    // …but the banner text still shows.
    expect(container.querySelector('.chat-pending-confirm-banner')).not.toBeNull();
  });

  it('renders nothing when activeServerId is missing (legacy test fixtures)', () => {
    // No subscription is possible without a serverId; the banner
    // should be a silent no-op rather than crash.
    const { container } = render(
      <ChatArea
        channel={activeChannel()}
        myNick="alice"
        onSend={vi.fn()}
      />,
    );
    expect(container.querySelector('.chat-pending-confirm-banner')).toBeNull();
  });

  it('scopes per serverId — switching server changes which entry the banner reads', () => {
    getServiceCredentialsStore().set('libera', { status: 'pending-confirmation' });
    getServiceCredentialsStore().set('oftc', { status: 'identified' });
    const { container, rerender } = render(
      <ChatArea
        channel={activeChannel()}
        myNick="alice"
        onSend={vi.fn()}
        activeServerId="libera"
        serverName="Libera"
      />,
    );
    expect(container.querySelector('.chat-pending-confirm-banner')).not.toBeNull();
    rerender(
      <ChatArea
        channel={activeChannel()}
        myNick="alice"
        onSend={vi.fn()}
        activeServerId="oftc"
        serverName="OFTC"
      />,
    );
    expect(container.querySelector('.chat-pending-confirm-banner')).toBeNull();
  });
});
