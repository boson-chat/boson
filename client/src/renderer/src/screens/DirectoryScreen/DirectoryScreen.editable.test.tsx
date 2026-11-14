import { describe, it, expect } from 'vitest';
import { buildEditableProps, resolveServerImages } from './DirectoryScreen';
import type { Server, User } from '../../modules/directory';
import type { SavedServer } from '../../modules/session';
import type { DirectoryBloc, DirectoryConnection } from './DirectoryBloc';

// buildEditableProps gates the owner-only Edit tab (directory profile +
// icon/banner upload). The tricky case it must handle: a connection that
// holds a SavedServer cold-start snapshot (no profile fields) for a server
// the signed-in user owns — it should resolve the full directory row by id
// from the loaded list so the owner still gets the Edit tab.

const OWNER_ID = 'b2f6ac8d-377f-4ce6-88b9-57fd357c2700';

const fullServer: Server = {
  id: 'srv-boson',
  hostname: 'irc.boson.chat',
  port: 6697,
  tls: true,
  name: 'boson',
  tags: ['general'],
  languages: ['en'],
  is_nsfw: false,
  is_featured: false,
  verification_status: 'verified',
  health_status: 'up',
  registered_by: OWNER_ID,
  registered_at: '2026-01-01T00:00:00Z',
};

const savedSnapshot: SavedServer = {
  id: 'srv-boson',
  name: 'boson',
  hostname: 'irc.boson.chat',
  port: 6697,
  tls: true,
};

const owner: User = {
  id: OWNER_ID,
  handle: 'Nyan2',
  is_discoverable: true,
  encrypted_user_secret: '',
  created_at: '2026-01-01T00:00:00Z',
};

const stranger: User = { ...owner, id: 'someone-else' };

// buildEditableProps only reads the bloc inside the returned closures, which
// these tests never invoke — a bare cast is enough.
const bloc = {} as DirectoryBloc;

describe('buildEditableProps', () => {
  it('returns editable props for an owner connected via the full directory Server', () => {
    const props = buildEditableProps(fullServer, owner, bloc, [fullServer]);
    expect(props.directoryEntry?.serverId).toBe('srv-boson');
    expect(props.onSaveProfile).toBeTypeOf('function');
    expect(props.onSaveServerImage).toBeTypeOf('function');
  });

  it('resolves a SavedServer snapshot to the full row so the owner still gets the Edit tab', () => {
    const props = buildEditableProps(savedSnapshot, owner, bloc, [fullServer]);
    expect(props.directoryEntry?.serverId).toBe('srv-boson');
    expect(props.onSaveServerImage).toBeTypeOf('function');
  });

  it('returns {} when a SavedServer cannot be resolved from the directory list', () => {
    expect(buildEditableProps(savedSnapshot, owner, bloc, null)).toEqual({});
    expect(buildEditableProps(savedSnapshot, owner, bloc, [])).toEqual({});
  });

  it('returns {} for a non-owner', () => {
    expect(buildEditableProps(fullServer, stranger, bloc, [fullServer])).toEqual({});
    expect(buildEditableProps(savedSnapshot, stranger, bloc, [fullServer])).toEqual({});
  });

  it('returns {} for a guest / signed-out user', () => {
    const guest: User = { ...owner, id: '__guest__' };
    expect(buildEditableProps(fullServer, guest, bloc, [fullServer])).toEqual({});
    expect(buildEditableProps(fullServer, null, bloc, [fullServer])).toEqual({});
    expect(buildEditableProps(fullServer, undefined, bloc, [fullServer])).toEqual({});
  });
});

describe('resolveServerImages', () => {
  const withImages: Server = {
    ...fullServer,
    icon_url: 'https://cdn.boson.chat/server-icons/srv-boson.png',
    banner_url: 'https://cdn.boson.chat/server-banners/srv-boson.png',
  };
  const conn = (server: Server | SavedServer): DirectoryConnection =>
    ({ serverId: 'srv-boson', server } as DirectoryConnection);

  it('reads icon/banner straight off a full Server connection', () => {
    expect(resolveServerImages(conn(withImages), null)).toEqual({
      iconUrl: withImages.icon_url,
      bannerUrl: withImages.banner_url,
    });
  });

  it('resolves a SavedServer snapshot via the directory list by id', () => {
    expect(resolveServerImages(conn(savedSnapshot), [withImages])).toEqual({
      iconUrl: withImages.icon_url,
      bannerUrl: withImages.banner_url,
    });
  });

  it('returns undefined urls when unresolved or unset', () => {
    expect(resolveServerImages(conn(savedSnapshot), null)).toEqual({ iconUrl: undefined, bannerUrl: undefined });
    expect(resolveServerImages(conn(fullServer), null)).toEqual({ iconUrl: undefined, bannerUrl: undefined });
  });
});

// The directory moved to /v1: listings now have `net_…` ids, while sessions
// saved before keep the legacy uuid as the server id. The images and the Edit
// tab must still resolve (regression: v0.48 lost every icon and banner).
describe('saved servers from before the /v1 directory', () => {
  const LEGACY = '398464ce-c861-4244-a16c-b26c046a1bd4';
  const legacySaved: SavedServer = { ...savedSnapshot, id: LEGACY };
  const v1Row: Server = {
    ...fullServer,
    id: 'net_01M7D62QNPD4WD8VYTAS6WRD71',
    icon_url: 'https://directory.boson.chat/media/server-icons/b.png',
    banner_url: 'https://directory.boson.chat/media/server-banners/b.png',
    owned: true,
    registered_by: undefined,
  };
  const conn = { serverId: LEGACY, server: legacySaved } as DirectoryConnection;

  it('resolves the images by legacy_id', () => {
    expect(resolveServerImages(conn, [{ ...v1Row, legacy_id: LEGACY }])).toEqual({
      iconUrl: v1Row.icon_url, bannerUrl: v1Row.banner_url,
    });
  });

  it('resolves the images by hostname + port when there is no legacy_id', () => {
    expect(resolveServerImages(conn, [v1Row])).toEqual({ iconUrl: v1Row.icon_url, bannerUrl: v1Row.banner_url });
  });

  it('falls back to the bloc-provided listing when the page lacks the row', () => {
    expect(resolveServerImages(conn, [], v1Row)).toEqual({ iconUrl: v1Row.icon_url, bannerUrl: v1Row.banner_url });
  });

  it('gives the owner the Edit tab on the listing id, not the saved one', () => {
    const props = buildEditableProps(legacySaved, owner, bloc, [v1Row]);
    expect(props.directoryEntry?.serverId).toBe(v1Row.id);
    expect(props.directoryEntry?.iconUrl).toBe(v1Row.icon_url);
  });

  it('does not match another network', () => {
    const other: Server = { ...v1Row, id: 'net_other', hostname: 'irc.other.example' };
    expect(resolveServerImages(conn, [other])).toEqual({ iconUrl: undefined, bannerUrl: undefined });
  });
});
