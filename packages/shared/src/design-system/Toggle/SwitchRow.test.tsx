import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { SwitchRow } from './SwitchRow';

describe('SwitchRow', () => {
  it('names the switch by the title and describes it', () => {
    render(<SwitchRow title="Do not disturb" description="No calls ring." checked={false} onChange={() => {}} />);
    const sw = screen.getByRole('checkbox', { name: 'Do not disturb' });
    expect(sw.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText('No calls ring.')).toBeTruthy();
  });
  it('the switch and the text both toggle it, once', async () => {
    const onChange = vi.fn();
    render(<SwitchRow title="DND" checked={false} onChange={onChange} />);
    const u = userEvent.setup();
    await u.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(true);
    await u.click(screen.getByText('DND'));
    expect(onChange).toHaveBeenCalledTimes(2);
  });
  it('disabled does nothing', async () => {
    const onChange = vi.fn();
    render(<SwitchRow title="DND" checked={false} onChange={onChange} disabled />);
    await userEvent.setup().click(screen.getByText('DND'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
