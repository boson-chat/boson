// @vitest-environment jsdom
// jsdom, not happy-dom: happy-dom elements lack ondragenter/ondragover/…,
// so Preact would listen for "DragOver" and never see a real "dragover".
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { ServerSettings, type DirectoryEntryProfile } from './ServerSettings';
import { HttpError } from '../../shared/http/http.client';
import { drag, dropFiles } from '../../shared/FileDrop/drag-test-utils';

// Server icon + banner pickers on the owner's Edit tab: drag and drop takes
// the same path as choosing a file.

const entry: DirectoryEntryProfile = {
  serverId: 'net-1', name: 'Boson HQ', description: '', tags: [], languages: [], isNsfw: false,
};

function renderEdit(onSaveServerImage: (kind: 'icon' | 'banner', image: Blob | null) => Promise<void>) {
  render(
    <ServerSettings
      serverDisplayName="Boson HQ" myNick="alice" serverInfo={{}} serverLog={[]}
      onClearServerLog={vi.fn()} onClose={vi.fn()} serverId="net-1" servicesFramework={null}
      onTriggerAutoIdentify={vi.fn()} onRunCommand={vi.fn()}
      directoryEntry={entry} onSaveProfile={vi.fn(async () => {})} onSaveServerImage={onSaveServerImage}
    />,
  );
  fireEvent.click(screen.getByRole('tab', { name: /^Edit/ }));
  const area = (hint: string) => screen.getByText(hint).closest('.file-drop')!;
  return {
    icon: area('Square. Shown in the directory grid + server rail.'),
    banner: area('Wide (3:1). Shown atop the listing.'),
  };
}

const png = () => new File(['x'], 'icon.png', { type: 'image/png' });

describe('ServerSettings — icon / banner drop', () => {
  it('uploads a dropped icon and a dropped banner', async () => {
    const save = vi.fn(async () => {});
    const { icon, banner } = renderEdit(save);
    drag(icon, 'dragenter');
    expect(icon).toHaveTextContent('Drop to upload');
    expect(banner).not.toHaveTextContent('Drop to upload');
    const f = png();
    dropFiles(icon, [f]);
    expect(save).toHaveBeenCalledWith('icon', f);
    await waitFor(() => expect(icon.querySelector('button')).toHaveTextContent('Upload'));
    const b = new File(['x'], 'banner.webp', { type: 'image/webp' });
    dropFiles(banner, [b]);
    expect(save).toHaveBeenLastCalledWith('banner', b);
  });

  it('rejects a non-image with the inline error', () => {
    const save = vi.fn(async () => {});
    const { icon } = renderEdit(save);
    dropFiles(icon, [new File(['hi'], 'notes.txt', { type: 'text/plain' })]);
    expect(icon).toHaveTextContent('Please choose an image file.');
    expect(save).not.toHaveBeenCalled();
  });

  it('surfaces the same upload errors as the picker', async () => {
    const { icon } = renderEdit(vi.fn(async () => { throw new HttpError(400, 'bad'); }));
    dropFiles(icon, [png()]);
    await waitFor(() => expect(icon).toHaveTextContent('That file isn’t a supported image.'));
  });

  it('ignores a drop while the control is busy', async () => {
    let finish!: () => void;
    const save = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    const { icon } = renderEdit(save);
    dropFiles(icon, [png()]);
    await waitFor(() => expect(icon).toHaveTextContent('Working…'));
    dropFiles(icon, [png()]);
    expect(save).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(icon).not.toHaveTextContent('Working…'));
  });

  it('describes each picker button with the drop hint', () => {
    renderEdit(vi.fn(async () => {}));
    for (const b of screen.getAllByRole('button', { name: 'Upload' })) {
      expect(b).toHaveAccessibleDescription('or drop an image here');
    }
  });
});
