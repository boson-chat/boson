import { useState } from 'preact/hooks';
import { SwitchRow } from '@boson/shared';
import { IncomingCallsSetting } from '../Notifications/IncomingCalls';
import {
  getNotificationSettings, setNotificationSettings, type NotificationSettings,
} from '../../modules/ui/notifications.store';
import { SectionFrame, SettingsGroup } from './SettingsFrame';
import { usePushRows } from '../../modules/push/use-push';
import { getPushManager, type PushRow } from '../../modules/push/push.manager';

// What a server's push row says under its name.
export function pushRowText(r: PushRow): string {
  switch (r.status.state) {
    case 'on': return 'On: mentions and DMs reach you while Boson is closed.';
    case 'pending': return 'Turning on…';
    case 'off': return r.status.needsPermission
      ? 'Get notified about mentions and DMs when Boson is closed. Turning this on asks for permission.'
      : 'Off.';
    case 'sign-in': return 'Sign in to get notifications.';
    case 'unavailable': return r.status.reason;
    default: return '';
  }
}

// Push, per server: on by default once signed in (docs/push.md §3.2).
function PushGroup() {
  const { rows, platform } = usePushRows();
  if (rows.length === 0) return null;
  const relays = Array.from(new Set(rows.map((r) => r.relay).filter((x): x is string => !!x)));
  return (
    <SettingsGroup title="When Boson is closed">
      {rows.map((r) => {
        const st = r.status.state;
        const toggleable = st === 'on' || st === 'off' || st === 'pending';
        return (
          <SwitchRow
            key={r.serverId}
            title={r.serverName}
            description={pushRowText(r)}
            checked={st === 'on' || st === 'pending'}
            disabled={!toggleable}
            ariaLabel={`Push notifications from ${r.serverName}`}
            onChange={(v) => { void getPushManager().setEnabled(r.serverId, v); }}
          />
        );
      })}
      <p class="user-settings-hint">
        Notifications are encrypted by the server for this device; {platform === 'ios' || platform === 'android'
          ? `they pass through ${relays.length ? relays.map((u) => u.replace(/^https:\/\//, '')).join(', ') : 'the push relay the server names'} and Apple or Google without being readable there.`
          : 'your browser’s push service passes them on without being able to read them.'}
      </p>
    </SettingsGroup>
  );
}

// Settings → Notifications: how Boson tells you (toasts, system banners,
// sound), what about, and how a ringing call shows. Who may call at all is
// under Privacy.
export function NotificationsSection() {
  const [s, setS] = useState<NotificationSettings>(() => getNotificationSettings());
  const update = (patch: Partial<NotificationSettings>): void => {
    setNotificationSettings(patch);
    setS(getNotificationSettings());
  };
  const off = !s.inApp && !s.enabled;
  return (
    <SectionFrame
      title="Notifications"
      description="For things happening somewhere you’re not looking. Everything also collects under the bell."
    >
      <SettingsGroup title="How">
        <SwitchRow title="In-app toasts" description="A card in the corner (a banner from the top on phones) when something happens elsewhere in Boson." checked={s.inApp} onChange={(v) => update({ inApp: v })} />
        <SwitchRow title="System notifications" description="OS banners when Boson is in the background or minimised." checked={s.enabled} onChange={(v) => update({ enabled: v })} />
        <SwitchRow title="Sound" description="A short chime with each one." checked={s.sound} disabled={off} onChange={(v) => update({ sound: v })} />
      </SettingsGroup>
      <SettingsGroup title="Notify me about">
        <SwitchRow title="Mentions" description="Someone says your nick." checked={s.mentions} disabled={off} onChange={(v) => update({ mentions: v })} />
        <SwitchRow title="Direct messages" description="Any 1:1 message." checked={s.directMessages} disabled={off} onChange={(v) => update({ directMessages: v })} />
        <SwitchRow title="Friends" description="Requests and accepts." checked={s.friends} disabled={off} onChange={(v) => update({ friends: v })} />
        <SwitchRow title="Calls" description="Missed calls, and calls starting in voice channels you're in." checked={s.calls} disabled={off} onChange={(v) => update({ calls: v })} />
        <SwitchRow title="Every channel message" description="Noisy: every message in every channel." checked={s.allMessages} disabled={off} onChange={(v) => update({ allMessages: v })} />
        <p class="user-settings-hint">Per server: Server settings → Notifications sets what its channels and DMs notify about. Per channel: Channel settings, or right-click a channel (long-press on a phone) → Notifications.</p>
      </SettingsGroup>
      <PushGroup />
      <SettingsGroup title="Incoming calls">
        <IncomingCallsSetting label={false} />
      </SettingsGroup>
    </SectionFrame>
  );
}
