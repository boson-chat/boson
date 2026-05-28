import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { useState } from 'preact/hooks';
import { ChipInput } from './ChipInput';

// A tiny controlled wrapper so the tests can poke type/Enter/etc and
// observe both onChange + the rendered output without managing state
// in every test.
function Harness({
  initial = [],
  ...rest
}: { initial?: string[] } & Omit<Parameters<typeof ChipInput>[0], 'value' | 'onChange'>) {
  const [value, setValue] = useState<string[]>(initial);
  return <ChipInput value={value} onChange={setValue} {...rest} />;
}

describe('ChipInput', () => {
  it('Enter commits the buffer as a new chip', async () => {
    render(<Harness ariaLabel="tags" />);
    const user = userEvent.setup();
    const input = screen.getByLabelText('tags');
    await user.type(input, 'foss{Enter}');
    expect(screen.getByText('foss')).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('comma in the keystream is treated as Enter', async () => {
    render(<Harness ariaLabel="tags" />);
    const user = userEvent.setup();
    const input = screen.getByLabelText('tags');
    await user.type(input, 'a,b,c');
    // Each comma commits the buffer before being suppressed; the
    // trailing 'c' sits in the buffer until blur or Enter.
    expect(screen.getByText('a')).toBeInTheDocument();
    expect(screen.getByText('b')).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe('c');
  });

  it('pasting a CSV string commits every token in one keystroke', async () => {
    // Pasting "a,b,c" + Enter should land 3 chips, not 1.
    render(<Harness ariaLabel="tags" />);
    const user = userEvent.setup();
    const input = screen.getByLabelText('tags');
    await user.click(input);
    await user.paste('foo, bar , baz');
    await user.keyboard('{Enter}');
    for (const v of ['foo', 'bar', 'baz']) {
      expect(screen.getByText(v)).toBeInTheDocument();
    }
  });

  it('Backspace on empty buffer pops the last chip back into the buffer for editing', async () => {
    render(<Harness initial={['foo', 'bar']} ariaLabel="tags" />);
    const user = userEvent.setup();
    const input = screen.getByLabelText('tags') as HTMLInputElement;
    await user.click(input);
    await user.keyboard('{Backspace}');
    // 'bar' jumped from chip → buffer; 'foo' is still a chip.
    expect(input.value).toBe('bar');
    expect(screen.queryByText('bar')).toBeNull();
    expect(screen.getByText('foo')).toBeInTheDocument();
  });

  it('clicking the × removes that specific chip', async () => {
    render(<Harness initial={['a', 'b', 'c']} ariaLabel="tags" />);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Remove b'));
    expect(screen.queryByText('b')).toBeNull();
    expect(screen.getByText('a')).toBeInTheDocument();
    expect(screen.getByText('c')).toBeInTheDocument();
  });

  it('duplicate values are silently dropped', async () => {
    render(<Harness initial={['foss']} ariaLabel="tags" />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('tags'), 'foss{Enter}');
    expect(screen.getAllByText('foss')).toHaveLength(1);
  });

  it('lowercase=true (default) normalises chip text', async () => {
    render(<Harness ariaLabel="tags" />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('tags'), 'FOSS{Enter}');
    expect(screen.getByText('foss')).toBeInTheDocument();
    expect(screen.queryByText('FOSS')).toBeNull();
  });

  it('stripHash=true peels leading # off chip values', async () => {
    render(<Harness ariaLabel="tags" stripHash />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('tags'), '#gamedev{Enter}');
    expect(screen.getByText('gamedev')).toBeInTheDocument();
  });

  it('pattern rejects values silently — buffer just resets', async () => {
    render(<Harness ariaLabel="tags" pattern={/^[a-z]{2}$/} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('tags'), 'english{Enter}');
    // "english" doesn't match the 2-letter pattern, nothing committed
    expect(screen.queryByText('english')).toBeNull();
    await user.type(screen.getByLabelText('tags'), 'en{Enter}');
    expect(screen.getByText('en')).toBeInTheDocument();
  });

  it('max caps the number of chips', async () => {
    render(<Harness initial={['a', 'b']} ariaLabel="tags" max={2} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('tags'), 'c{Enter}');
    expect(screen.queryByText('c')).toBeNull();
    expect(screen.getAllByRole('button').length).toBe(2); // 2 remove buttons
  });

  it('disabled blocks add + remove', async () => {
    const onChange = vi.fn();
    render(
      <ChipInput value={['a']} onChange={onChange} disabled ariaLabel="tags" />,
    );
    const user = userEvent.setup();
    const input = screen.getByLabelText('tags') as HTMLInputElement;
    expect(input).toBeDisabled();
    await user.click(screen.getByLabelText('Remove a'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('committing on blur sweeps an unfinished buffer into the list', async () => {
    render(<Harness ariaLabel="tags" />);
    const user = userEvent.setup();
    const input = screen.getByLabelText('tags');
    await user.type(input, 'mid-typing');
    // user.tab() drives focus away naturally, which fires the
    // synthetic blur event Preact listens for. Calling input.blur()
    // directly skips that path in jsdom and the onBlur prop doesn't
    // fire.
    await user.tab();
    expect(screen.getByText('mid-typing')).toBeInTheDocument();
  });
});
