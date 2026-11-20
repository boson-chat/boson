import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { Segmented } from './Segmented';

const opts = [{ id: 'a', label: 'Nobody' }, { id: 'b', label: 'Friends' }, { id: 'c', label: 'Everyone' }] as const;

describe('Segmented', () => {
  it('is a named radio group with the value checked', () => {
    render(<Segmented label="Who can call me" value="b" options={opts} onChange={() => {}} />);
    expect(screen.getByRole('radiogroup', { name: 'Who can call me' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Friends' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Nobody' }).getAttribute('aria-checked')).toBe('false');
  });
  it('clicking picks; arrow keys move the choice', async () => {
    const onChange = vi.fn();
    render(<Segmented label="x" value="a" options={opts} onChange={onChange} size="lg" />);
    const u = userEvent.setup();
    await u.click(screen.getByRole('radio', { name: 'Everyone' }));
    expect(onChange).toHaveBeenLastCalledWith('c');
    screen.getByRole('radio', { name: 'Nobody' }).focus();
    await u.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('b');
    await u.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenLastCalledWith('a');
  });
});
