import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/preact';
import { AppearancePanel } from './AppearancePanel';
import { ThemeStore, setThemeStore, type ThemeFilesBridge } from '../../modules/ui/theme';

let root: HTMLElement;
let files: Record<string, string>;

function bridge(): ThemeFilesBridge {
  return {
    list: async () => Object.entries(files).map(([id, text]) => ({ id, text })),
    write: async (id, text) => { files[id] = text; },
    remove: async (id) => { delete files[id]; },
    openFolder: async () => {},
    onChange: () => () => {},
  };
}

beforeEach(async () => {
  localStorage.clear();
  files = {};
  root = document.createElement('div');
  const store = new ThemeStore(bridge(), root);
  await store.init();
  setThemeStore(store);
});
afterEach(() => setThemeStore(null));

const tile = (name: string) => screen.getByRole('radio', { name: new RegExp(`^${name}`) });
const accent = () => root.style.getPropertyValue('--accent');

describe('AppearancePanel', () => {
  it('lists the built-ins with Terminal selected, and switches on click', () => {
    render(<AppearancePanel />);
    for (const n of ['Terminal', 'Daylight', 'Nord', 'Solarized', 'Phosphor']) expect(tile(n)).toBeInTheDocument();
    expect(tile('Terminal')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(tile('Nord'));
    expect(tile('Nord')).toHaveAttribute('aria-checked', 'true');
    expect(accent()).toBe('#88C0D0');
    expect(screen.getByRole('button', { name: 'Open themes folder' })).toBeInTheDocument();
  });

  it('lists built-ins and your own themes under separate headings', async () => {
    render(<AppearancePanel />);
    expect(within(screen.getByRole('group', { name: 'Built-in' })).getAllByRole('radio')).toHaveLength(5);
    expect(screen.queryByRole('group', { name: 'Yours' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Customize Terminal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save as new theme' }));
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'Yours' })).getAllByRole('radio')).toHaveLength(1));
  });

  it('the editor sets corners and font', async () => {
    render(<AppearancePanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Customize Terminal' }));
    fireEvent.input(screen.getByRole('slider', { name: 'Corner radius' }), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('radio', { name: 'System font' }));
    expect(root.style.getPropertyValue('--radius-md')).toBe('16px');
    fireEvent.click(screen.getByRole('button', { name: 'Save as new theme' }));
    await waitFor(() => expect(files['terminal-custom']).toBeDefined());
    expect(JSON.parse(files['terminal-custom']!)).toMatchObject({ radius: 8, font: 'system' });
    expect(screen.getByRole('group', { name: 'Yours' })).toBeInTheDocument();
  });

  it('customizing previews live and saves a new theme file', async () => {
    render(<AppearancePanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Customize Terminal' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Terminal (custom)');
    fireEvent.input(screen.getByRole('textbox', { name: 'Accent' }), { target: { value: '#ff0066' } });
    expect(accent()).toBe('#ff0066');

    fireEvent.input(screen.getByRole('textbox', { name: 'Danger' }), { target: { value: 'not-a-colour!' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Not a colour: Danger');
    expect(screen.getByRole('button', { name: 'Save as new theme' })).toBeDisabled();
    fireEvent.input(screen.getByRole('textbox', { name: 'Danger' }), { target: { value: 'crimson' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save as new theme' }));
    await waitFor(() => expect(tile('Terminal \\(custom\\)')).toHaveAttribute('aria-checked', 'true'));
    const saved = JSON.parse(files['terminal-custom']!);
    expect(saved.colors.accent).toBe('#ff0066');
    expect(saved.colors.danger).toBe('crimson');
    expect(screen.getByRole('button', { name: 'Edit Terminal (custom)' })).toBeInTheDocument();
  });

  it('Cancel throws the preview away', () => {
    render(<AppearancePanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Customize Terminal' }));
    fireEvent.input(screen.getByRole('textbox', { name: 'Accent' }), { target: { value: '#123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(accent()).toBe('#D97706');
    expect(Object.keys(files)).toEqual([]);
  });

  it('imports a JSON file, and explains a broken one', async () => {
    render(<AppearancePanel />);
    const input = screen.getByTestId('theme-import') as HTMLInputElement;
    const good = new File([JSON.stringify({ name: 'Sunset', base: 'light', colors: { accent: '#e8590c' } })], 'sunset.json');
    fireEvent.change(input, { target: { files: [good] } });
    await waitFor(() => expect(tile('Sunset')).toHaveAttribute('aria-checked', 'true'));
    expect(accent()).toBe('#e8590c');
    expect(root.dataset['themeBase']).toBe('light');

    const bad = new File(['{oops'], 'oops.json');
    fireEvent.change(input, { target: { files: [bad] } });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("Couldn't import oops.json: Not valid JSON"));
  });

  it('Delete removes the active custom theme and falls back to Terminal', async () => {
    render(<AppearancePanel />);
    const input = screen.getByTestId('theme-import') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['{"name":"Gone"}'], 'gone.json')] } });
    await waitFor(() => expect(tile('Gone')).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(files).toEqual({ gone: expect.any(String) });
    fireEvent.click(screen.getByRole('button', { name: 'Delete theme' }));
    await waitFor(() => expect(tile('Terminal')).toHaveAttribute('aria-checked', 'true'));
    expect(files).toEqual({});
  });
});
