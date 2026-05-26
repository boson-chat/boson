import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { TotpInput } from './TotpInput';

describe('TotpInput', () => {
  it('renders the requested number of inputs', () => {
    render(<TotpInput length={6} value="" onChange={() => {}} />);
    expect(screen.getAllByRole('textbox')).toHaveLength(6);
  });

  it('emits the typed character and advances focus', async () => {
    const onChange = vi.fn();
    render(<TotpInput length={4} value="" onChange={onChange} />);
    const inputs = screen.getAllByRole('textbox') as HTMLInputElement[];
    await userEvent.setup().type(inputs[0], '1');
    expect(onChange).toHaveBeenLastCalledWith('1');
    expect(document.activeElement).toBe(inputs[1]);
  });

  it('moves focus back on Backspace when current is empty', async () => {
    render(<TotpInput length={4} value="12" onChange={() => {}} />);
    const inputs = screen.getAllByRole('textbox') as HTMLInputElement[];
    inputs[2].focus();
    await userEvent.setup().keyboard('{Backspace}');
    expect(document.activeElement).toBe(inputs[1]);
  });

  it('ignores non-alphanumeric input', async () => {
    const onChange = vi.fn();
    render(<TotpInput length={4} value="" onChange={onChange} />);
    const inputs = screen.getAllByRole('textbox') as HTMLInputElement[];
    await userEvent.setup().type(inputs[0], '!');
    expect(onChange).toHaveBeenLastCalledWith('');
  });
});
