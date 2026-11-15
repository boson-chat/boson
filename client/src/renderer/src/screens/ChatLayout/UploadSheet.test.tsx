import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';
import { UploadSheet } from './UploadSheet';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const img = () => new File([new Uint8Array(2_400_000)], 'IMG_0042.jpg', { type: 'image/jpeg' });
const doc = () => new File(['hello'], 'notes.txt', { type: 'text/plain' });

beforeEach(() => {
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = vi.fn(() => 'blob:thumb');
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = vi.fn();
});
afterEach(cleanup);

function setup(over: Partial<Parameters<typeof UploadSheet>[0]> = {}) {
  const onSend = vi.fn();
  const onCancel = vi.fn();
  render(
    <UploadSheet
      open
      files={[img(), doc()]}
      target="#general"
      limits={{ max_file_bytes: 100e6 }}
      usage={{ used: 1.2e9, quota: 5e9, window_seconds: 259_200, max_file: 100e6, frees: [{ bytes: 1e9, at: new Date(NOW + 20 * 3_600_000).toISOString() }] }}
      now={NOW}
      onSend={onSend}
      onCancel={onCancel}
      {...over}
    />,
  );
  return { onSend, onCancel };
}

describe('UploadSheet', () => {
  it('lists each file with its filename, a thumbnail for images, its size, and the usage meter', () => {
    setup();
    expect(screen.getByRole('dialog', { name: 'Upload 2 files to #general' })).toBeTruthy();
    expect((screen.getByLabelText('Filename for IMG_0042.jpg') as HTMLInputElement).value).toBe('IMG_0042.jpg');
    expect((screen.getByLabelText('Filename for notes.txt') as HTMLInputElement).value).toBe('notes.txt');
    const items = screen.getAllByTestId('upload-item');
    expect(items[0]!.querySelector('img')?.getAttribute('src')).toBe('blob:thumb');
    expect(items[1]!.querySelector('img')).toBeNull();
    expect(items[0]!.textContent).toContain('2.4 MB');
    expect(screen.getByTestId('upload-usage').textContent).toContain('1.2 GB of 5 GB used · 1 GB frees in 20 h');
  });

  it('sends the renamed (sanitised) names, extension kept, and one caption for the batch', () => {
    const { onSend } = setup();
    fireEvent.input(screen.getByLabelText('Filename for IMG_0042.jpg'), { target: { value: 'beach/../day' } });
    expect(screen.getAllByTestId('upload-item')[0]!.textContent).toContain('Uploads as day.jpg');
    expect(screen.queryByLabelText('Caption for IMG_0042.jpg')).toBeNull();
    fireEvent.input(screen.getByLabelText('Caption for these files'), { target: { value: ' Sunset ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send 2 files' }));
    expect(onSend).toHaveBeenCalledTimes(1);
    const [items, caption] = onSend.mock.calls[0]! as [Array<{ name: string; file: File }>, string];
    expect(items.map((i) => [i.name, i.file.name])).toEqual([['day.jpg', 'IMG_0042.jpg'], ['notes.txt', 'notes.txt']]);
    expect(caption).toBe('Sunset');
  });

  it('a single file keeps its caption beside it', () => {
    const { onSend } = setup({ files: [doc()] });
    fireEvent.input(screen.getByLabelText('Caption for notes.txt'), { target: { value: 'notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend.mock.calls[0]![1]).toBe('notes');
  });

  it('shows the total of all files', () => {
    setup();
    expect(screen.getByTestId('upload-total').textContent).toBe('2 files · 2.4 MB');
  });

  it('checks the total against what is left: how many fit, when space frees up; removing one lets the rest go', () => {
    const big = () => new File([new Uint8Array(10)], 'big.bin');
    const files = [img(), doc(), big()];
    // 2.4 MB + 5 B fit in the 2.5 MB left; big.bin (10 B more) doesn't.
    const usage = { used: 5e9 - 2_400_008, quota: 5e9, window_seconds: 259_200, max_file: 100e6, frees: [{ bytes: 1e9, at: new Date(NOW + 20 * 3_600_000).toISOString() }] };
    const onRemove = vi.fn();
    const { onSend } = setup({ files, usage, onRemove });
    expect(screen.getByRole('alert').textContent).toBe('Only 2 of 3 files fit in the 2.4 MB left · 1 GB frees up in 20 h');
    const send = screen.getByRole('button', { name: 'Send 3 files' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove big.bin' }));
    expect(onRemove).toHaveBeenCalledWith(files[2]);
    cleanup();
    setup({ files: files.slice(0, 2), usage });
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button', { name: 'Send 2 files' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('adds files to the open sheet, keeping names typed so far', () => {
    const a = doc();
    const onAdd = vi.fn();
    const { rerender } = render(
      <UploadSheet open files={[a]} target="#general" limits={null} usage={null} onSend={vi.fn()} onCancel={vi.fn()} onAdd={onAdd} />,
    );
    fireEvent.input(screen.getByLabelText('Filename for notes.txt'), { target: { value: 'minutes.txt' } });
    const picker = screen.getByTestId('upload-sheet-add-input') as HTMLInputElement;
    const b = img();
    Object.defineProperty(picker, 'files', { value: [b], configurable: true });
    fireEvent.change(picker);
    expect(onAdd).toHaveBeenCalledWith([b]);
    rerender(<UploadSheet open files={[a, b]} target="#general" limits={null} usage={null} onSend={vi.fn()} onCancel={vi.fn()} onAdd={onAdd} />);
    expect(screen.getAllByTestId('upload-item')).toHaveLength(2);
    expect((screen.getByLabelText('Filename for notes.txt') as HTMLInputElement).value).toBe('minutes.txt');
    expect(screen.getByRole('dialog', { name: 'Upload 2 files to #general' })).toBeTruthy();
  });

  it('says where the files go when it is the home files host, and shows a notice', () => {
    setup({ files: [doc()], homeLabel: 'boson.chat', notice: "You can send up to 20 files at once; 3 files weren't added." });
    expect(screen.getByTestId('upload-home').textContent).toContain('Uploads to boson.chat');
    expect(screen.getByRole('status').textContent).toBe("You can send up to 20 files at once; 3 files weren't added.");
  });

  it('Enter sends, Escape cancels', () => {
    const { onSend, onCancel } = setup({ files: [doc()] });
    fireEvent.keyDown(screen.getByLabelText('Caption for notes.txt'), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });

  it('Cancel, and removing the last file, cancel', () => {
    const { onCancel } = setup({ files: [doc()] });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Remove notes.txt' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('a file over the limit says so and blocks Send', () => {
    const { onSend } = setup({ files: [img()], limits: { max_file_bytes: 1e6 } });
    expect(screen.getByRole('alert').textContent).toBe('IMG_0042.jpg is 2.4 MB; the limit is 1 MB per file.');
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.keyDown(screen.getByLabelText('Caption for IMG_0042.jpg'), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('usage still loading, or unavailable', () => {
    setup({ usage: undefined, files: [doc()] });
    expect(screen.getByText('Checking your storage…')).toBeTruthy();
    cleanup();
    setup({ usage: null, files: [doc()] });
    expect(screen.queryByTestId('upload-usage')).toBeNull();
  });
});
