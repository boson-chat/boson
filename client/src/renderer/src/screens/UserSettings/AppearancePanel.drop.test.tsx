// @vitest-environment jsdom
// jsdom, not happy-dom: happy-dom elements lack ondragenter/ondragover/…,
// so Preact would listen for "DragOver" and never see a real "dragover".
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';
import { AppearancePanel } from './AppearancePanel';
import { ThemeStore, setThemeStore, type ThemeFilesBridge } from '../../modules/ui/theme';
import { drag, dropFiles } from '../../shared/FileDrop/drag-test-utils';

// Dropping a .json theme onto the theme picker imports it, like Import JSON….

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

// jsdom's File has no text(); the import path reads the file with it.
function jsonFile(text: string, name: string, type = 'application/json'): File {
  const f = new File([text], name, { type });
  Object.defineProperty(f, 'text', { value: async () => text });
  return f;
}

beforeEach(async () => {
  localStorage.clear();
  files = {};
  const store = new ThemeStore(bridge(), document.createElement('div'));
  await store.init();
  setThemeStore(store);
});
afterEach(() => setThemeStore(null));

const pickerArea = () => screen.getByRole('radiogroup', { name: 'Theme' }).closest('.file-drop')!;
const tile = (name: string) => screen.getByRole('radio', { name: new RegExp(`^${name}`) });

describe('AppearancePanel — theme drop', () => {
  it('imports a dropped .json theme', async () => {
    render(<AppearancePanel />);
    drag(pickerArea(), 'dragenter');
    expect(screen.getByText('Drop to upload')).toBeInTheDocument();
    dropFiles(pickerArea(), [jsonFile(JSON.stringify({ name: 'Sunset', base: 'light', colors: { accent: '#e8590c' } }), 'sunset.json', '')]);
    await waitFor(() => expect(tile('Sunset')).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByRole('status')).toHaveTextContent('Imported "Sunset".');
  });

  it('explains a broken one the same way as Import JSON…', async () => {
    render(<AppearancePanel />);
    dropFiles(pickerArea(), [jsonFile('{oops', 'oops.json')]);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("Couldn't import oops.json: Not valid JSON"));
  });

  it('rejects a file that is not .json', () => {
    render(<AppearancePanel />);
    dropFiles(pickerArea(), [new File(['hi'], 'notes.txt', { type: 'text/plain' })]);
    expect(screen.getByRole('alert')).toHaveTextContent('That’s not a .json theme file.');
    expect(files).toEqual({});
  });

  it('describes Import JSON… with the drop hint', () => {
    render(<AppearancePanel />);
    expect(screen.getByRole('button', { name: 'Import JSON…' })).toHaveAccessibleDescription('or drop a .json theme here');
  });
});
