import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { AuthProvider, type AuthService } from '../../modules/auth';
import { VoiceController, movePlan, setVoiceController, type VoiceRoom } from '../../modules/voice';
import { createFakeVoiceBridge, type FakeVoiceBridge } from '../../modules/voice/voice.fake';
import { __resetVoiceSettings } from '../../modules/voice/voice.settings';
import { VoiceSection } from './VoiceSection';
import { VoiceBar } from './VoiceBar';
import { ChannelVoiceAdd, ChannelVoiceRooms } from './VoiceRooms';

function fakeAuth(): AuthService {
  const state = {
    session: { access_token: 'a', expires_at: 0, refresh_token: 'r', session_id: 's', user: { id: 'usr_me', username: 'me', email: null, email_verified: true, role: 'user', user_metadata: {} } },
    loading: false, error: null,
  };
  return { getState: () => state, subscribe: (fn: (s: unknown) => void) => { fn(state); return () => {}; } } as unknown as AuthService;
}

const HOST = 'irc.boson.chat';
const rooms = (): VoiceRoom[] => [
  { id: 'general', name: 'General', kind: 'static', parent: '', position: 0, canJoin: true, canSpeak: true, participants: [] },
  { id: 'dev-standup', name: 'Standup', kind: 'dynamic', parent: '#dev', position: 0, canManage: true, canJoin: true, canSpeak: true, minRole: 'member', speakRole: 'member', participants: [] },
  { id: 'dev-town', name: 'Town hall', kind: 'dynamic', parent: '#dev', position: 1, canManage: true, canJoin: true, canSpeak: false, minRole: 'member', speakRole: 'op', participants: [] },
  { id: 'dev-staff', name: 'Staff', kind: 'dynamic', parent: '#dev', position: 2, canManage: false, canJoin: false, canSpeak: false, minRole: 'admin', speakRole: 'admin', participants: [] },
  { id: 'design-crit', name: 'Crit', kind: 'dynamic', parent: '#design', position: 0, canJoin: true, canSpeak: true, participants: [] },
];

let bridge: FakeVoiceBridge;
let controller: VoiceController;

function mount(scope: 'any' | 'founded_channels' | 'none' = 'any', founded: string[] = []) {
  bridge = createFakeVoiceBridge({
    servers: { [HOST]: {} },
    rooms: { [HOST]: rooms() },
    permissions: { [HOST]: { canCreate: scope !== 'none', createScope: scope, foundedChannels: founded } },
  });
  controller = new VoiceController(bridge, {
    authUrl: 'https://auth.boson.chat',
    voiceToken: async () => ({ token: 't', expiresAt: Date.now() + 300_000 }),
    pollMs: 60_000,
    keyTarget: null,
  });
  setVoiceController(controller);
  return render(
    <AuthProvider service={fakeAuth()}>
      <div class="channel-item" data-channel="#dev"><ChannelVoiceAdd host={HOST} channel="#dev" /></div>
      <ChannelVoiceRooms host={HOST} serverName="boson" channel="#dev" />
      <VoiceSection host={HOST} serverName="boson" engineState="connected" channels={['#dev']} />
      <VoiceBar />
    </AuthProvider>,
  );
}

describe('voice channel management', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetVoiceSettings();
  });
  afterEach(() => setVoiceController(null));

  it('groups rooms under their text channel; others go in VOICE under their channel name', async () => {
    mount();
    await screen.findByText('Standup');
    const group = screen.getByLabelText('Voice channels in #dev');
    expect(group.textContent).toContain('Standup');
    expect(group.textContent).toContain('Town hall');
    expect(group.textContent).not.toContain('General');
    expect(screen.getByLabelText('Voice channels in #design').textContent).toContain('Crit');
  });

  it('locks rooms you cannot join and marks listen-only ones', async () => {
    mount();
    const staff = await screen.findByLabelText('Staff (locked)');
    expect(staff.getAttribute('aria-disabled')).toBe('true');
    expect(staff.getAttribute('title')).toBe('Needs channel admin (&) or higher in #dev');
    fireEvent.click(staff);
    expect(bridge.calls.some((c) => c.method === 'join')).toBe(false);
    expect(screen.getByLabelText('Join voice channel Town hall, listen only')).toBeTruthy();
    expect(screen.getByText('listen only')).toBeTruthy();
  });

  it('creates a voice channel under a text channel with locks', async () => {
    mount();
    fireEvent.click(await screen.findByLabelText('Create a voice channel in #dev'));
    await screen.findByText('Create a voice channel');
    fireEvent.input(screen.getByPlaceholderText('Game night'), { target: { value: 'Game night' } });
    // A real change event (testing-library/preact's fireEvent.change sends input).
    const pick = (label: string, value: string): void => {
      const el = screen.getByLabelText(label) as HTMLSelectElement;
      act(() => {
        el.value = value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
    };
    pick('Who can join', 'voice');
    pick('Who can talk', 'op');
    await act(async () => { fireEvent.submit(document.querySelector('form.voice-dialog')!); });
    await waitFor(() => expect(bridge.calls.some((c) => c.method === 'createRoom')).toBe(true));
    const call = bridge.calls.find((c) => c.method === 'createRoom')!;
    expect(call.args[2]).toEqual({ name: 'Game night', parent: '#dev', minRole: 'voice', speakRole: 'op', requireChannelMembership: false });
    await screen.findByText('Game night');
  });

  it('only offers + under founded channels for founders', async () => {
    mount('founded_channels', ['#design']);
    await screen.findByText('Standup');
    expect(screen.queryByLabelText('Create a voice channel in #dev')).toBeNull();
    // The VOICE "+" offers the founded channel.
    fireEvent.click(screen.getByLabelText('Create a voice channel'));
    const select = await screen.findByLabelText('Text channel') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['#design']);
  });

  it('shows the server error when a name is taken', async () => {
    mount();
    bridge.opts.onChange = (m) => (m === 'create' ? { code: 'conflict', error: 'taken' } : null);
    fireEvent.click(await screen.findByLabelText('Create a voice channel in #dev'));
    fireEvent.input(await screen.findByPlaceholderText('Game night'), { target: { value: 'Standup' } });
    await act(async () => { fireEvent.submit(document.querySelector('form.voice-dialog')!); });
    expect((await screen.findByRole('alert')).textContent).toBe('There is already a voice channel with that name here.');
  });

  it('edits, then deletes after confirming', async () => {
    mount();
    fireEvent.click(await screen.findByLabelText('Edit voice channel Standup'));
    const name = await screen.findByDisplayValue('Standup');
    fireEvent.input(name, { target: { value: 'Daily' } });
    await act(async () => { fireEvent.submit(document.querySelector('form.voice-dialog')!); });
    await waitFor(() => expect(bridge.calls.find((c) => c.method === 'updateRoom')?.args.slice(2)).toEqual(['dev-standup', { name: 'Daily' }]));
    fireEvent.click(await screen.findByLabelText('Edit voice channel Daily'));
    fireEvent.click(await screen.findByText('Delete channel'));
    await screen.findByText('Delete Daily?');
    await act(async () => { fireEvent.click(screen.getAllByText('Delete channel').at(-1)!); });
    await waitFor(() => expect(bridge.calls.some((c) => c.method === 'deleteRoom' && c.args[2] === 'dev-standup')).toBe(true));
    await waitFor(() => expect(screen.queryByText('Daily')).toBeNull());
  });

  it('moves a room with the context menu', async () => {
    mount();
    const row = await screen.findByLabelText('Join voice channel Town hall, listen only');
    fireEvent.contextMenu(row);
    expect((screen.getByText('Move down') as HTMLButtonElement).disabled).toBe(true); // Staff isn't yours
    await act(async () => { fireEvent.click(screen.getByText('Move up')); });
    await waitFor(() => {
      const ups = bridge.calls.filter((c) => c.method === 'updateRoom').map((c) => c.args.slice(2));
      expect(ups).toEqual([['dev-town', { position: 0 }], ['dev-standup', { position: 1 }]]);
    });
  });

  it('says why when you were put out of a deleted room', async () => {
    mount();
    await screen.findByText('Standup');
    act(() => bridge.push({ status: 'error', host: HOST, room: 'dev-standup', roomName: 'Standup', errorKind: 'kicked', error: 'Voice channel "Standup" was deleted by fred.' }));
    expect(await screen.findByText('Disconnected from voice')).toBeTruthy();
    expect(screen.getByText('Voice channel "Standup" was deleted by fred.')).toBeTruthy();
    expect(screen.queryByLabelText('Try again')).toBeNull();
  });
});

describe('movePlan', () => {
  it('renumbers the group and refuses moves past rooms you cannot manage', () => {
    const r = rooms();
    expect(movePlan(r, 'dev-standup', -1)).toBeNull();
    expect(movePlan(r, 'dev-standup', 1)).toEqual([{ id: 'dev-town', position: 0 }, { id: 'dev-standup', position: 1 }]);
    expect(movePlan(r, 'dev-town', 1)).toBeNull();
    expect(movePlan(r, 'general', 1)).toBeNull();
  });
});
