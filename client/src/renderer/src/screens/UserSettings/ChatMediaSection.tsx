import { useEffect, useState } from 'preact/hooks';
import { Button, Select, SwitchRow } from '@boson/shared';
import { getEmbedSettings, setEmbedSettings, type EmbedSettings } from '../../modules/ui/embeds.store';
import { forgetDims, imagesBridge, type ImageCacheStats } from '../../shared/image-cache';
import { formatBytes } from '../../modules/files';
import { NestedSettings, SectionFrame, SettingRow, SettingsGroup } from './SettingsFrame';

// Settings → Chat & media: link previews (local-only, privacy-first: with
// auto-load off nothing remote loads until clicked) and the image cache.
export function ChatMediaSection() {
  const [s, setS] = useState<EmbedSettings>(() => getEmbedSettings());
  const update = (patch: Partial<EmbedSettings>): void => { setEmbedSettings(patch); setS(getEmbedSettings()); };
  const off = !s.enabled;
  const kind = (title: string, key: 'images' | 'videos' | 'youtube' | 'spotify' | 'websites', description: string) => (
    <SwitchRow title={title} description={description} checked={s[key]} disabled={off} onChange={(v) => update({ [key]: v })} />
  );
  return (
    <SectionFrame title="Chat & media" description="How links and images show in chat.">
      <SettingsGroup title="Link previews">
        <SwitchRow
          title="Show link previews"
          description="Images, videos, players and website cards under messages with links."
          checked={s.enabled}
          onChange={(v) => update({ enabled: v })}
        />
        <NestedSettings disabled={off}>
          <SwitchRow
            title="Load automatically"
            description="Off: a preview loads when you click it, so nothing remote is fetched (or sees your IP) until then."
            checked={s.loadMode === 'auto'}
            disabled={off}
            onChange={(v) => update({ loadMode: v ? 'auto' : 'click' })}
          />
          {kind('Images', 'images', 'Pictures linked in chat.')}
          {kind('Videos', 'videos', 'Video files linked in chat.')}
          {kind('YouTube', 'youtube', 'A YouTube player for YouTube links.')}
          {kind('Spotify', 'spotify', 'A Spotify player for Spotify links.')}
          {kind('Website cards', 'websites', 'Title, summary and image of other pages.')}
        </NestedSettings>
      </SettingsGroup>
      <ImageCache />
    </SectionFrame>
  );
}

// Images seen before load from this device (desktop/imagecache.go). Only in
// the desktop app.
const IMAGE_CACHE_SIZES_MB = [250, 500, 1000, 2000];

function ImageCache() {
  const bridge = imagesBridge();
  const [stats, setStats] = useState<ImageCacheStats | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    void bridge.stats().then((st) => { if (alive) setStats(st); }, () => {});
    return () => { alive = false; };
  }, [bridge]);
  if (!bridge) return null;
  const limitMB = stats ? Math.round(stats.limitBytes / 1048576) : 500;
  const sizes = IMAGE_CACHE_SIZES_MB.includes(limitMB) ? IMAGE_CACHE_SIZES_MB : [...IMAGE_CACHE_SIZES_MB, limitMB].sort((a, b) => a - b);
  return (
    <SettingsGroup title="Image cache">
      <SettingRow
        title="Keep up to"
        description={<>
          Images you’ve seen stay on this device, so they show at once next time.
          {stats && !stats.error && <> Using <strong>{formatBytes(stats.usedBytes)}</strong> of {formatBytes(stats.limitBytes)}.</>}
        </>}
      >
        <Select
          size="sm"
          class="user-settings-image-cache-select"
          label="Image cache size"
          value={String(limitMB)}
          options={sizes.map((mb) => ({ value: String(mb), label: mb >= 1000 ? `${mb / 1000} GB` : `${mb} MB` }))}
          onChange={(v) => { void bridge.setLimitMB(Number(v)).then(setStats); }}
        />
      </SettingRow>
      <SettingRow title="Cached images" description="Remove every cached image. They download again when next shown.">
        <Button
          variant="secondary"
          size="sm"
          aria-label="Clear image cache"
          onClick={() => { forgetDims(); void bridge.clear().then(setStats); }}
        >
          Clear
        </Button>
      </SettingRow>
    </SettingsGroup>
  );
}
