import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import { ChatInputBar, autoResize } from './ChatInputBar';
import { ChatInputBloc } from './ChatInputBloc';

function setup(myNick?: string) {
  const sent: string[][] = [];
  const bloc = new ChatInputBloc({
    getMembers: () => [],
    getKnownChannels: () => [],
    onSend: (lines) => { sent.push([...lines]); },
  });
  render(
    <ChatInputBar state={bloc.getState()} bloc={bloc} placeholder="Message #x" myNick={myNick} />,
  );
  return { bloc };
}

describe('ChatInputBar', () => {
  it('shows the nick chip when myNick is provided', () => {
    setup('Nyan');
    expect(screen.getByText('Nyan')).toBeInTheDocument();
  });

  it('omits the nick chip when myNick is absent', () => {
    setup(undefined);
    expect(screen.queryByText('Nyan')).toBeNull();
  });

  it('opens the emoji picker and inserts the chosen emoji at the caret', () => {
    const { bloc } = setup('Nyan');
    fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' }));
    expect(screen.getByRole('dialog', { name: 'Emoji picker' })).toBeInTheDocument();
    // Pick the first emoji in the grid.
    const tada = screen.getByRole('button', { name: ':tada:' });
    fireEvent.click(tada);
    expect(bloc.getState().input).toBe('🎉');
  });

  it('filters emojis by shortcode search', () => {
    setup('Nyan');
    fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' }));
    fireEvent.input(screen.getByPlaceholderText('Search…'), { target: { value: 'fire' } });
    expect(screen.getByRole('button', { name: ':fire:' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ':tada:' })).toBeNull();
  });
});

describe('autoResize', () => {
  const textarea = (value: string, scrollHeight: number) => {
    const el = document.createElement('textarea');
    el.value = value;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    return el;
  };

  it('ignores the placeholder: an empty textarea falls back to its CSS min-height', () => {
    // A stale measurement taken while the column was still narrow (the
    // placeholder wrapped per character) must not stick.
    const el = textarea('', 378);
    el.style.height = '160px';
    autoResize(el);
    expect(el.style.height).toBe('');
  });

  it('sizes to the content, capped at 160px', () => {
    const el = textarea('hello\nworld', 48);
    autoResize(el);
    expect(el.style.height).toBe('48px');

    const tall = textarea('x\n'.repeat(40), 900);
    autoResize(tall);
    expect(tall.style.height).toBe('160px');
  });
});
