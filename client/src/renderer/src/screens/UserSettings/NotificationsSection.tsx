import { useState } from 'preact/hooks';
import { SwitchRow } from '@boson/shared';
import { IncomingCallsSetting } from '../Notifications/IncomingCalls';
import {
  getNotificationSettings, setNotificationSettings, type NotificationSettings,
} from '../../modules/ui/notifications.store';
import { SectionFrame, SettingsGroup } from './SettingsFrame';

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
      <SettingsGroup title="Incoming calls">
        <IncomingCallsSetting label={false} />
      </SettingsGroup>
    </SectionFrame>
  );
}
