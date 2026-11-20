import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from './Menu';

describe('Menu', () => {
  it('items: plain, danger, checked; clicks fire', async () => {
    const a = vi.fn();
    render(
      <Menu label="mira">
        <MenuLabel>mira</MenuLabel>
        <MenuItem onClick={a}>Message</MenuItem>
        <MenuSeparator />
        <MenuItem danger onClick={() => {}}>Block</MenuItem>
        <MenuItem checked onClick={() => {}}>All</MenuItem>
      </Menu>,
    );
    expect(screen.getByRole('menu', { name: 'mira' })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Message' }));
    expect(a).toHaveBeenCalledOnce();
    expect(screen.getByRole('menuitem', { name: 'Block' }).className).toContain('bds-menu-item-danger');
    expect(screen.getByRole('menuitemradio', { name: /All/ }).getAttribute('aria-checked')).toBe('true');
  });
  it('a checkbox item is a menuitemcheckbox', () => {
    render(<Menu><MenuItem checkbox checked={false} onClick={() => {}}>Use theme</MenuItem></Menu>);
    expect(screen.getByRole('menuitemcheckbox', { name: /Use theme/ }).getAttribute('aria-checked')).toBe('false');
  });
  it('closes on an outside press and on Escape, not on an inside press', () => {
    const onClose = vi.fn();
    render(<div><span>outside</span><Menu onClose={onClose} x={10} y={20}><MenuItem onClick={() => {}}>In</MenuItem></Menu></div>);
    fireEvent.mouseDown(screen.getByRole('menuitem', { name: 'In' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByText('outside'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('menu').getAttribute('style')).toContain('left: 10px');
  });
});
