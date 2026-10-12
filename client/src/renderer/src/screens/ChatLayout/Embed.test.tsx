import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/preact';
import { MessageEmbeds, youtubeWrapperOrigin, YOUTUBE_EMBED_HOST, YOUTUBE_WRAPPER_TIMEOUT_MS } from './Embed';
import { YOUTUBE_EMBED_HOST as MAIN_YOUTUBE_EMBED_HOST } from '../../../../main/youtube-embed';
import { setEmbedSettings, __resetEmbedSettingsCache } from '../../modules/ui/embeds.store';

beforeEach(() => {
  localStorage.clear();
  __resetEmbedSettingsCache();
  // Default is auto-load; most of these tests exercise the click-to-load flow,
  // so opt into it explicitly. The auto-load test overrides this.
  setEmbedSettings({ loadMode: 'click' });
});

describe('MessageEmbeds', () => {
  it('auto-loads media by default (no chip click needed)', () => {
    setEmbedSettings({ loadMode: 'auto' });
    render(<MessageEmbeds text="https://i.imgur.com/a.png" />);
    expect((document.querySelector('img.embed-img') as HTMLImageElement)?.src).toContain('a.png');
    expect(screen.queryByRole('button', { name: /click to load/i })).toBeNull();
  });

  it('renders a click-to-load image chip (no <img> until clicked)', () => {
    render(<MessageEmbeds text="pic https://i.imgur.com/a.png" />);
    const chip = screen.getByRole('button', { name: /image · i\.imgur\.com — click to load/i });
    expect(document.querySelector('img.embed-img')).toBeNull(); // inert until clicked
    fireEvent.click(chip);
    expect((document.querySelector('img.embed-img') as HTMLImageElement)?.src).toContain('a.png');
  });

  it('opens an in-app lightbox when the loaded image is clicked', () => {
    render(<MessageEmbeds text="https://i.imgur.com/a.png" />);
    fireEvent.click(screen.getByRole('button', { name: /click to load/i }));
    expect(document.querySelector('.embed-lightbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open image' }));
    expect(document.querySelector('.embed-lightbox')).not.toBeNull();
    // Backdrop click closes it.
    fireEvent.click(document.querySelector('.embed-lightbox')!);
    expect(document.querySelector('.embed-lightbox')).toBeNull();
  });

  it('loads an inline <video> player on click for a video file', () => {
    render(<MessageEmbeds text="https://cdn.example.com/clip.mp4" />);
    expect(document.querySelector('video.embed-video-el')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /video · cdn\.example\.com — click to play/i }));
    const v = document.querySelector('video.embed-video-el') as HTMLVideoElement;
    expect(v).not.toBeNull();
    expect(v.getAttribute('src')).toContain('clip.mp4');
  });

  // The test page is http://localhost:<port>, like the app in dev.
  const wrapper = () => `http://${YOUTUBE_EMBED_HOST}:${location.port}`;
  const play = (url = 'https://youtu.be/dQw4w9WgXcQ'): HTMLIFrameElement => {
    render(<MessageEmbeds text={url} />);
    fireEvent.click(screen.getByRole('button', { name: /youtube · .* — click to load/i }));
    expect(document.querySelector('iframe.embed-yt-iframe')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Play video' }));
    return document.querySelector('iframe.embed-yt-iframe') as HTMLIFrameElement;
  };

  it('plays YouTube in-app: chip → thumbnail facade → the player, framed by the local wrapper', () => {
    const f = play();
    expect(f.getAttribute('src')).toBe(`${wrapper()}/youtube-embed.html?v=dQw4w9WgXcQ`);
    expect(f.getAttribute('allow')).toContain('fullscreen');
  });

  it('embeds YouTube directly if the wrapper never says it loaded', () => {
    vi.useFakeTimers();
    try {
      const f = play();
      act(() => { vi.advanceTimersByTime(YOUTUBE_WRAPPER_TIMEOUT_MS + 10); });
      expect(f.getAttribute('src')).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
      expect(f.getAttribute('src')).toContain(`origin=${encodeURIComponent(location.origin)}`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the wrapper once it says it loaded, and ignores look-alike messages', () => {
    vi.useFakeTimers();
    try {
      const f = play();
      const post = (data: unknown, origin: string, source: unknown) =>
        window.dispatchEvent(new MessageEvent('message', { data, origin, source: source as Window }));
      // Wrong sender, wrong origin, wrong video: none of these count.
      post({ type: 'boson-youtube-ready', v: 'dQw4w9WgXcQ' }, wrapper(), window);
      post({ type: 'boson-youtube-ready', v: 'dQw4w9WgXcQ' }, 'https://evil.example', f.contentWindow);
      post({ type: 'boson-youtube-ready', v: 'xxxxxxxxxxx' }, wrapper(), f.contentWindow);
      post({ type: 'boson-youtube-ready', v: 'dQw4w9WgXcQ' }, wrapper(), f.contentWindow);
      act(() => { vi.advanceTimersByTime(YOUTUBE_WRAPPER_TIMEOUT_MS + 10); });
      expect(f.getAttribute('src')).toBe(`${wrapper()}/youtube-embed.html?v=dQw4w9WgXcQ`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the wrapper only from a loopback http origin', () => {
    const at = (protocol: string, hostname: string, port: string) => youtubeWrapperOrigin({ protocol, hostname, port });
    expect(at('http:', '127.0.0.1', '43117')).toBe(`http://${YOUTUBE_EMBED_HOST}:43117`);
    expect(at('http:', 'localhost', '5173')).toBe(`http://${YOUTUBE_EMBED_HOST}:5173`);
    expect(at('https:', 'boson.chat', '')).toBeNull();
    expect(at('http:', 'example.com', '80')).toBeNull();
    expect(at('file:', '', '')).toBeNull();
    expect(at('http:', '127.0.0.1', '')).toBeNull();
    // The hostname main maps to 127.0.0.1 is the one embeds use.
    expect(YOUTUBE_EMBED_HOST).toBe(MAIN_YOUTUBE_EMBED_HOST);
  });

  it('dismisses an embed', () => {
    render(<MessageEmbeds text="https://i.imgur.com/a.png" />);
    expect(screen.queryByRole('button', { name: /click to load/ })).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss embed' }));
    expect(screen.queryByRole('button', { name: /click to load/ })).toBeNull();
  });

  it('renders a native Spotify playlist card + track list (no iframe)', async () => {
    const spotify = async () => ({
      url: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
      type: 'playlist',
      title: 'Today’s Top Hits',
      subtitle: 'Spotify',
      cover: 'https://i.scdn.co/image/cover.jpg',
      tracks: [
        { title: 'stupid song', artist: 'Olivia Rodrigo', durationMs: 209680, previewUrl: 'https://p.scdn.co/a.mp3' },
        { title: 'Man I Need', artist: 'Olivia Dean', durationMs: 184000 },
      ],
    });
    render(<MessageEmbeds text="https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M" spotify={spotify} />);
    // No Spotify iframe (avoids the Electron locale crash).
    expect(document.querySelector('iframe')).toBeNull();
    expect(await screen.findByText('Today’s Top Hits')).toBeInTheDocument();
    expect(screen.getByText('stupid song')).toBeInTheDocument();
    expect(screen.getByText('Man I Need')).toBeInTheDocument();
    // Duration is formatted mm:ss (184000ms → 3:04).
    expect(screen.getByText('3:04')).toBeInTheDocument();
    // The previewless track's play button is disabled; the other is playable.
    expect(screen.getByRole('button', { name: 'Play stupid song' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Man I Need' })).toBeDisabled();
  });

  it('renders nothing when embeds are disabled', () => {
    setEmbedSettings({ enabled: false });
    const { container } = render(<MessageEmbeds text="https://i.imgur.com/a.png" />);
    expect(container.querySelector('.msg-embeds')).toBeNull();
  });

  it('respects the per-type image toggle', () => {
    setEmbedSettings({ images: false });
    const { container } = render(<MessageEmbeds text="https://i.imgur.com/a.png" />);
    expect(container.querySelector('.msg-embeds')).toBeNull();
  });

  it('warns before opening an executable file link', () => {
    render(<MessageEmbeds text="grab https://host/setup.exe" />);
    fireEvent.click(screen.getByRole('button', { name: /\.exe file · host — download/ }));
    expect(screen.getByText('Download an executable?')).toBeInTheDocument();
    expect(screen.getByText(/could harm your computer|harm your computer or steal/i)).toBeInTheDocument();
  });

  it('renders a website link card that says "open" without an unfurl fetcher', () => {
    render(<MessageEmbeds text="https://example.com/post" />);
    const card = screen.getByRole('button', { name: /example\.com/ });
    expect(card).toHaveClass('embed-linkcard');
    expect(screen.getByText('Open in browser')).toBeInTheDocument();
  });

  it('renders a Discord-style OG card (site, title link, description, image) with a fetcher', async () => {
    const unfurl = async () => ({
      url: 'https://example.com/post',
      siteName: 'Example News',
      title: 'A Big Headline',
      description: 'Some summary text.',
      image: 'https://cdn.example.com/cover.jpg',
    });
    render(<MessageEmbeds text="https://example.com/post" unfurl={unfurl} />);
    fireEvent.click(screen.getByRole('button', { name: /example\.com/ }));
    const title = await screen.findByText('A Big Headline');
    expect(title.tagName).toBe('A'); // title is the clickable link
    expect(title.getAttribute('href')).toBe('https://example.com/post');
    expect(screen.getByText('Example News')).toBeInTheDocument();
    expect(screen.getByText('Some summary text.')).toBeInTheDocument();
    expect((document.querySelector('img.embed-card-img') as HTMLImageElement)?.src).toContain('cover.jpg');
  });
});
