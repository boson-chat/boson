// The voice server's room API (desktop/voice_rooms.go): GET /v1/rooms and
// POST/PATCH/DELETE for managing voice channels, over fetch (quicvoiced
// 1.15+ sends CORS for the web app's origin).
import type {
  VoiceRoom, VoiceRoomChange, VoiceRoomErrorCode, VoiceRoomInput, VoiceRoomsResult, VoiceRole,
} from '../../../modules/voice/voice.types';

const TIMEOUT_MS = 5000;

interface RoomWire {
  id: string;
  name?: string;
  kind?: string;
  parent?: string | null;
  owner?: { user_id: string; name: string } | null;
  position?: number;
  created_at?: string;
  min_role?: string;
  speak_role?: string;
  require_channel_membership?: boolean;
  can_manage?: boolean;
  can_join?: boolean;
  can_speak?: boolean;
  participants?: Array<{ session_id: number; user_id: string; name: string; muted?: boolean; deafened?: boolean; speaking?: boolean; guest?: boolean }>;
}

export function roomFromWire(r: RoomWire): VoiceRoom {
  return {
    id: r.id,
    name: r.name || r.id,
    kind: (r.kind || 'static') as VoiceRoom['kind'],
    parent: r.parent ?? '',
    owner: r.owner ? { userId: r.owner.user_id, name: r.owner.name } : null,
    position: r.position ?? 0,
    createdAt: r.created_at,
    minRole: (r.min_role || 'member') as VoiceRole,
    speakRole: (r.speak_role || 'member') as VoiceRole,
    requireChannelMembership: !!r.require_channel_membership,
    canManage: !!r.can_manage,
    canJoin: r.can_join ?? true,
    canSpeak: r.can_speak ?? true,
    participants: (r.participants ?? []).map((p) => ({
      sessionId: p.session_id, userId: p.user_id, name: p.name,
      muted: !!p.muted, deafened: !!p.deafened, speaking: !!p.speaking,
      guest: !!p.guest || p.user_id.startsWith('guest:'),
    })),
  };
}

async function call(fetchFn: typeof fetch, method: string, url: string, token: string, body?: unknown): Promise<Response | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return await fetchFn(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal, redirect: 'error' });
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function fetchRooms(fetchFn: typeof fetch, base: string, token: string): Promise<VoiceRoomsResult> {
  const r = await call(fetchFn, 'GET', `${base}/v1/rooms`, token);
  if (!r) return { rooms: null, error: "Couldn't reach the voice server.", errorKind: 'unreachable' };
  if (r.status === 401 || r.status === 403) return { rooms: null, error: "The voice server didn't accept your sign-in.", errorKind: 'token' };
  if (r.status === 404) return { rooms: null, error: "This voice server doesn't list its channels yet.", errorKind: 'unavailable' };
  if (!r.ok) return { rooms: null, error: `The voice server answered ${r.status}.`, errorKind: 'server' };
  let w: { rooms?: RoomWire[]; permissions?: { policy?: string; can_create?: boolean; create_scope?: string; founded_channels?: string[] | null } };
  try { w = await r.json(); } catch { return { rooms: null, error: 'The voice server sent something unexpected.', errorKind: 'server' }; }
  const p = w.permissions;
  return {
    rooms: (w.rooms ?? []).filter((x) => x.id).map(roomFromWire),
    permissions: p
      ? { policy: p.policy, canCreate: !!p.can_create, createScope: (p.create_scope || 'none') as 'any' | 'founded_channels' | 'none', foundedChannels: p.founded_channels ?? [] }
      : { canCreate: false, createScope: 'none', foundedChannels: [] },
  };
}

export function roomInputWire(i: VoiceRoomInput, create: boolean): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  if (i.name !== undefined) m.name = i.name.trim();
  if (create && i.parent) m.parent = i.parent;
  if (!create && i.position !== undefined) m.position = i.position;
  if (i.minRole !== undefined) m.min_role = i.minRole;
  if (i.speakRole !== undefined) m.speak_role = i.speakRole;
  if (i.requireChannelMembership !== undefined) m.require_channel_membership = i.requireChannelMembership;
  return m;
}

export async function changeRoom(fetchFn: typeof fetch, method: string, url: string, token: string, body?: unknown): Promise<VoiceRoomChange> {
  const r = await call(fetchFn, method, url, token, body);
  if (!r) return { error: "Couldn't reach the voice server.", code: 'unreachable' };
  const text = await r.text().catch(() => '');
  if (r.ok) {
    if (r.status === 204 || !text.trim()) return {};
    try {
      const w = JSON.parse(text) as RoomWire;
      if (!w.id) throw new Error('no id');
      return { room: roomFromWire(w) };
    } catch {
      return { error: 'The voice server sent something unexpected.', code: 'server' };
    }
  }
  let e: { error?: string; code?: string } = {};
  try { e = JSON.parse(text); } catch { /* not JSON */ }
  const byStatus: Record<number, VoiceRoomErrorCode> = { 400: 'invalid', 415: 'invalid', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 503: 'unavailable', 405: 'unsupported' };
  const out: VoiceRoomChange = { error: e.error, code: (e.code as VoiceRoomErrorCode) || byStatus[r.status] || 'server' };
  const ra = Number(r.headers.get('Retry-After'));
  if (ra > 0) out.retryAfter = ra;
  return out;
}
