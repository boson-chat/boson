import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { Toggle } from './Toggle';

describe('Toggle', () => {
  it('reflects checked state', () => {
    render(<Toggle checked={true} onChange={() => {}} label="Notifications" />);
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Notifications')).toBeInTheDocument();
  });

  it('fires onChange with the next value when clicked', async () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="X" />);
    await userEvent.setup().click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('does not fire when disabled', async () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} disabled label="X" />);
    await userEvent.setup().click(screen.getByRole('checkbox'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
