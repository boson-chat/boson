import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { Tabs } from './Tabs';

const tabs = [
  { id: 'login', label: 'Login' },
  { id: 'signup', label: 'Signup' },
];

describe('Tabs', () => {
  it('marks the active tab via aria-selected', () => {
    render(<Tabs tabs={tabs} active="login" onChange={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Login' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Signup' }).getAttribute('aria-selected')).toBe('false');
  });

  it('fires onChange with the clicked tab id', async () => {
    const onChange = vi.fn();
    render(<Tabs tabs={tabs} active="login" onChange={onChange} />);
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Signup' }));
    expect(onChange).toHaveBeenCalledWith('signup');
  });
});
