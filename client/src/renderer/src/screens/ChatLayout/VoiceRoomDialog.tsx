import { useEffect, useState } from 'preact/hooks';
import { Button, Field, Input, Modal, Toggle } from '@boson/shared';
import {
  VOICE_ROLES, type VoiceController, type VoiceRole, type VoiceRoom, type VoiceRoomInput, type VoiceServerView,
} from '../../modules/voice';
import { canCreateUnder, type VoiceDialog } from './VoiceRooms';
import './VoiceSection.css';

const ROLE_LABEL: Record<VoiceRole, string> = {
  member: 'Everyone',
  voice: 'Voice (+v) and up',
  halfop: 'Half-ops (%) and up',
  op: 'Ops (@) and up',
  admin: 'Channel admins (&) and up',
  founder: 'Founder only',
  oper: 'Network admins only',
};

const TOP_LEVEL_LABEL: Partial<Record<VoiceRole, string>> = {
  member: 'Everyone signed in',
  oper: 'Network admins only',
};

const NAME_MAX = 32;

// Create or edit a voice channel: its name, the text channel it sits under
// (fixed once made), who can join, who can talk, and whether you have to be
// in the text channel too. Editing also deletes, after a confirmation.
export function VoiceRoomDialog({ voice, dialog, server, joinedChannels, isNetworkAdmin, onClose }: {
  voice: VoiceController;
  dialog: VoiceDialog;
  server: VoiceServerView;
  // The IRC channels you're in (lowercase), for the "Text channel" picker.
  joinedChannels: string[];
  // Network admins may lock to "oper".
  isNetworkAdmin: boolean;
  onClose: () => void;
}) {
  const editing = dialog.kind === 'edit' ? server.rooms?.find((r) => r.id === dialog.roomId) ?? null : null;
  const parentChoices = parentOptions(server, joinedChannels);
  const initialParent = dialog.kind === 'create'
    ? dialog.parent ?? (parentChoices.includes('') ? '' : parentChoices[0] ?? '')
    : editing?.parent ?? '';

  const [name, setName] = useState(editing?.name ?? '');
  const [parent, setParent] = useState(initialParent);
  const [minRole, setMinRole] = useState<VoiceRole>(editing?.minRole ?? 'member');
  const [speakRole, setSpeakRole] = useState<VoiceRole>(editing?.speakRole ?? 'member');
  const [requireMember, setRequireMember] = useState(!!editing?.requireChannelMembership);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(dialog.kind === 'edit' && !!dialog.confirmDelete);

  // A room deleted from elsewhere while the dialog is open.
  const gone = dialog.kind === 'edit' && server.rooms !== null && !editing;
  useEffect(() => { if (gone && !busy) onClose(); }, [gone, busy, onClose]);

  const topLevel = !parent;
  const roles = roleOptions(topLevel, isNetworkAdmin, [minRole, speakRole]);
  // Talking needs at least what joining does.
  const speakRoles = roles.filter((r) => rank(r) >= rank(minRole));
  const label = (r: VoiceRole): string => (topLevel ? TOP_LEVEL_LABEL[r] : undefined) ?? ROLE_LABEL[r];

  const onParent = (p: string): void => {
    setParent(p);
    if (!p) {
      // Top-level rooms lock only to member or oper, and can't need a channel.
      if (minRole !== 'member' && minRole !== 'oper') setMinRole('member');
      if (speakRole !== 'member' && speakRole !== 'oper') setSpeakRole(minRole === 'oper' ? 'oper' : 'member');
      setRequireMember(false);
    }
  };
  const onMinRole = (r: VoiceRole): void => {
    setMinRole(r);
    if (rank(speakRole) < rank(r)) setSpeakRole(r);
  };

  const trimmed = name.trim();
  const nameProblem = trimmed.length > NAME_MAX ? `At most ${NAME_MAX} characters.` : null;
  const changed = !editing || trimmed !== editing.name || minRole !== (editing.minRole ?? 'member')
    || speakRole !== (editing.speakRole ?? 'member') || requireMember !== !!editing.requireChannelMembership;

  const save = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (!trimmed || nameProblem || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        const input: VoiceRoomInput = {};
        if (trimmed !== editing.name) input.name = trimmed;
        if (minRole !== (editing.minRole ?? 'member')) input.minRole = minRole;
        if (speakRole !== (editing.speakRole ?? 'member')) input.speakRole = speakRole;
        if (!topLevel && requireMember !== !!editing.requireChannelMembership) input.requireChannelMembership = requireMember;
        if (Object.keys(input).length > 0) await voice.updateRoom(server.host, editing.id, input);
      } else {
        await voice.createRoom(server.host, {
          name: trimmed,
          ...(parent ? { parent } : {}),
          minRole,
          speakRole,
          ...(parent ? { requireChannelMembership: requireMember } : {}),
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      await voice.deleteRoom(server.host, editing.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const title = editing ? `Edit ${editing.name}` : 'Create a voice channel';
  const fixedParent = dialog.kind === 'create' && dialog.parent !== null;

  if (editing && confirmDelete) {
    const n = editing.participants.length;
    return (
      <Modal open onClose={onClose} title={`Delete ${editing.name}?`}>
        <div class="voice-dialog">
          <p class="voice-dialog-text">
            {editing.parent ? <>It goes from <strong>{editing.parent}</strong> for everyone. </> : <>It goes for everyone. </>}
            {n > 0 ? `${n === 1 ? 'The 1 person' : `The ${n} people`} in it now will be disconnected.` : 'Nobody is in it right now.'}
          </p>
          {error && <div class="voice-dialog-error" role="alert">{error}</div>}
          <div class="voice-dialog-actions">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => (dialog.kind === 'edit' && dialog.confirmDelete ? onClose() : setConfirmDelete(false))}>
              Cancel
            </Button>
            <Button type="button" variant="primary" data-tone="danger" disabled={busy} loading={busy} onClick={() => { void remove(); }}>
              Delete channel
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title={title}>
      <form class="voice-dialog" onSubmit={(e) => { void save(e); }}>
        <Field label="Name" error={nameProblem ?? undefined}>
          <Input
            value={name}
            placeholder="Game night"
            maxLength={NAME_MAX + 8}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            autoFocus
            required
            spellcheck={false}
            autoComplete="off"
          />
        </Field>

        {editing ? (
          editing.parent && (
            <p class="voice-dialog-where">In <strong>{editing.parent}</strong>. A voice channel can't move to another text channel.</p>
          )
        ) : fixedParent ? (
          <p class="voice-dialog-where">In <strong>{parent}</strong>.</p>
        ) : parentChoices.length > 1 || (parentChoices.length === 1 && parentChoices[0] !== '') ? (
          <Field label="Text channel" hint="Where it shows in the channel list. This can't be changed later.">
            <select
              class="bds-input voice-dialog-select"
              aria-label="Text channel"
              value={parent}
              onChange={(e) => onParent((e.target as HTMLSelectElement).value)}
            >
              {parentChoices.map((p) => <option key={p} value={p}>{p || 'None (top level)'}</option>)}
            </select>
          </Field>
        ) : null}

        <div class="voice-dialog-locks">
          <Field label="Who can join" hint={topLevel ? undefined : `By their role in ${parent}.`}>
            <select
              class="bds-input voice-dialog-select"
              aria-label="Who can join"
              value={minRole}
              onChange={(e) => onMinRole((e.target as HTMLSelectElement).value as VoiceRole)}
            >
              {roles.map((r) => <option key={r} value={r}>{label(r)}</option>)}
            </select>
          </Field>
          <Field label="Who can talk" hint="Everyone else who can join listens.">
            <select
              class="bds-input voice-dialog-select"
              aria-label="Who can talk"
              value={speakRole}
              onChange={(e) => setSpeakRole((e.target as HTMLSelectElement).value as VoiceRole)}
            >
              {speakRoles.map((r) => <option key={r} value={r}>{label(r)}</option>)}
            </select>
          </Field>
        </div>

        {!topLevel && (
          <div class="voice-dialog-toggle">
            <Toggle checked={requireMember} onChange={setRequireMember} label={`Only people in ${parent}`} />
            <span class="voice-dialog-hint">They must be in the text channel when they join.</span>
          </div>
        )}

        {error && <div class="voice-dialog-error" role="alert">{error}</div>}

        <div class="voice-dialog-actions">
          {editing && (
            <Button type="button" variant="ghost" data-tone="danger-ghost" disabled={busy} onClick={() => setConfirmDelete(true)}>
              Delete channel
            </Button>
          )}
          <span class="voice-dialog-spacer" />
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !trimmed || !!nameProblem || !changed} loading={busy}>
            {editing ? 'Save changes' : 'Create channel'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function rank(r: VoiceRole): number {
  return VOICE_ROLES.indexOf(r);
}

// The roles a lock may use: top-level rooms only member / oper; oper only
// for network admins (or when it's already set).
function roleOptions(topLevel: boolean, admin: boolean, current: VoiceRole[]): VoiceRole[] {
  return VOICE_ROLES.filter((r) => {
    if (topLevel && r !== 'member' && r !== 'oper') return false;
    if (r === 'oper' && !admin && !current.includes('oper')) return false;
    return true;
  });
}

// Where a new room may go: '' (top level) and channels, by your scope.
function parentOptions(server: VoiceServerView, joined: string[]): string[] {
  const p = server.permissions;
  const out: string[] = [];
  if (canCreateUnder(p, '')) out.push('');
  const pool = p.createScope === 'founded_channels' ? p.foundedChannels ?? [] : joined;
  for (const c of pool) {
    const k = c.toLowerCase();
    if (!out.includes(k) && canCreateUnder(p, k)) out.push(k);
  }
  return out;
}

export function voiceRoomOf(server: VoiceServerView | undefined, id: string): VoiceRoom | null {
  return server?.rooms?.find((r) => r.id === id) ?? null;
}
