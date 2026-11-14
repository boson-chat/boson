import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { DirectoriesSection } from './DirectoriesSection';
import { DirectorySources } from '../../modules/directory/sources';
import { fakeDirectory, fakeTransport } from '../../modules/directory/test-directory-server';

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
}

describe('DirectoriesSection', () => {
  it('lists the default, adds and removes a directory', async () => {
    const friends = fakeDirectory('https://dir.friends.example', 'Friends Net', [], { operator: 'Friends e.V.' });
    const sources = new DirectorySources({ storage: memStorage(), transport: fakeTransport([friends]) });
    render(<DirectoriesSection sources={sources} />);
    expect(screen.getByText('Boson directory')).toBeTruthy();
    expect(screen.getByText('Default')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Remove Boson/ })).toBeNull();

    await userEvent.type(screen.getByPlaceholderText('directory.example.org'), 'http://dir.friends.example');
    await userEvent.click(screen.getByRole('button', { name: 'Add directory' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Directories must use https://.');

    const input = screen.getByPlaceholderText('directory.example.org') as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, 'dir.friends.example');
    await userEvent.click(screen.getByRole('button', { name: 'Add directory' }));
    expect(await screen.findByText('Friends Net')).toBeTruthy();
    expect(screen.getByText('Run by Friends e.V.')).toBeTruthy();
    expect(screen.getByText('Added Friends Net')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Remove Friends Net' }));
    await waitFor(() => expect(screen.queryByText('Friends Net')).toBeNull());
    expect(sources.list()).toHaveLength(1);
  });
});
