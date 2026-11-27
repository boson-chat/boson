import { useState } from 'preact/hooks';
import { Button, Segmented, SwitchRow, useTransientFlag } from '@boson/shared';
import { useFriends, type CallPolicy, type RequestPolicy } from '../../modules/friends';
import { getPrivacySettings, setPrivacySettings, type PrivacySettings } from '../../modules/ui/privacy.store';
import { clearAllSeen } from '../../modules/seen';
import { isTelemetryEnabled, PRIVACY_URL, setTelemetryEnabled } from '../../modules/telemetry/telemetry';
import { NestedSettings, SectionFrame, SettingRow, SettingsGroup } from './SettingsFrame';
import { ExternalLink } from './AboutSection';

// Settings → Privacy: who can reach you (calls and friend requests, on the
// account), and what Boson remembers about other people on this device.
// How a call rings (banner or full screen) is under Notifications. Last,
// the anonymous usage & health stats this device sends (modules/telemetry).
export function PrivacySection({ mode }: { mode: 'guest' | 'account' }) {
  const { friends, snap } = useFriends();
  const reachable = !!friends && snap.available;
  return (
    <SectionFrame
      title="Privacy"
      description="Who can reach you, what Boson remembers about people on this device, and the anonymous stats it sends."
    >
      {reachable ? <PrivacyCalls /> : mode === 'guest' && (
        <SettingsGroup title="Calls & friend requests">
          <p class="user-settings-hint">Sign in to a Boson account to choose who can call you and send you friend requests.</p>
        </SettingsGroup>
      )}
      <RememberedHosts />
      <UsageStats />
    </SectionFrame>
  );
}

const CALL_HINT: Record<CallPolicy, string> = {
  nobody: 'Nobody can call you, except friends who can call you anytime.',
  friends: 'Only friends can call you. Others see “only takes calls from friends”.',
  everyone: 'Anyone who isn’t blocked can call you.',
};
const CALL_OPTS: Array<{ id: CallPolicy; label: string }> = [
  { id: 'nobody', label: 'Nobody' }, { id: 'friends', label: 'Friends' }, { id: 'everyone', label: 'Everyone' },
];
const REQUEST_OPTS: Array<{ id: RequestPolicy; label: string }> = [
  { id: 'nobody', label: 'Nobody' }, { id: 'servers', label: 'People in my servers' }, { id: 'everyone', label: 'Everyone' },
];

// Who can call me, Do not disturb, who can send me friend requests (the
// account's privacy, saved to it at once).
export function PrivacyCalls() {
  const { friends, snap } = useFriends();
  if (!friends || !snap.available) return null;
  const p = snap.privacy;
  return (
    <>
      <SettingsGroup title="Calls">
        <div class="user-settings-choice">
          <span class="user-settings-setting-title" id="privacy-calls-label">Who can call me</span>
          <span class="user-settings-setting-desc">Private calls: right-click a name → Call.</span>
          <Segmented labelledBy="privacy-calls-label" value={p.calls} options={CALL_OPTS} onChange={(calls) => { void friends.setPrivacy({ calls }); }} />
          <span class="user-settings-hint">{CALL_HINT[p.calls]}</span>
        </div>
        <SwitchRow
          title="Do not disturb"
          description="No calls ring, except friends who can call you anytime. Missed calls are listed."
          checked={p.doNotDisturb}
          onChange={(on) => { void friends.setPrivacy({ doNotDisturb: on }); }}
        />
      </SettingsGroup>
      <SettingsGroup title="Friend requests">
        <div class="user-settings-choice">
          <span class="user-settings-setting-title" id="privacy-requests-label">Who can send me friend requests</span>
          <Segmented labelledBy="privacy-requests-label" value={p.friendRequests} options={REQUEST_OPTS}
            onChange={(friendRequests) => { void friends.setPrivacy({ friendRequests }); }} />
        </div>
      </SettingsGroup>
    </>
  );
}

// Who people were after they've left: user@host, account, real name, kept
// on this device only and never sent anywhere (modules/seen).
function RememberedHosts() {
  const [p, setP] = useState<PrivacySettings>(() => getPrivacySettings());
  const [cleared, flashCleared] = useTransientFlag();
  const update = (patch: Partial<PrivacySettings>): void => { setPrivacySettings(patch); setP(getPrivacySettings()); };
  return (
    <SettingsGroup title="People’s hosts">
      <SwitchRow
        title="Remember hosts"
        description="Keep each nick’s last user@host, account and real name on this device, so their profile and /whois still show who they were after they leave. Never sent anywhere."
        checked={p.rememberHosts}
        onChange={(v) => update({ rememberHosts: v })}
      />
      <NestedSettings disabled={!p.rememberHosts}>
        <SwitchRow
          title="Show hosts in join/part lines"
          description="Add user@host after the nick when someone joins or leaves."
          checked={p.showHostsInActivity}
          disabled={!p.rememberHosts}
          onChange={(v) => update({ showHostsInActivity: v })}
        />
      </NestedSettings>
      <SettingRow title="Remembered hosts" description="Forget every host remembered so far.">
        {cleared && <span class="user-settings-saved" role="status">Cleared</span>}
        <Button variant="secondary" size="sm" aria-label="Clear remembered hosts" onClick={() => { void clearAllSeen().then(flashCleared); }}>
          Clear
        </Button>
      </SettingRow>
    </SettingsGroup>
  );
}

// The daily app ping (modules/telemetry): on by default (off in a browser
// that sends Do Not Track / Global Privacy Control), for this device.
export const USAGE_STATS_WHY = 'We collect a small amount of anonymous usage and health data to make Boson better: to see which versions and features people use, and to catch failed updates, crashes and struggling servers so we can fix them, often before anyone has to report them. No names, emails, messages, server names or IP addresses, ever.';

function UsageStats() {
  const [on, setOn] = useState(() => isTelemetryEnabled());
  return (
    <SettingsGroup title="Help improve Boson">
      <SwitchRow
        title="Usage & health stats"
        description={USAGE_STATS_WHY}
        checked={on}
        onChange={(v) => { setTelemetryEnabled(v); setOn(v); }}
      />
      <p class="user-settings-hint">
        <ExternalLink href={PRIVACY_URL}>What’s sent, and how long it’s kept</ExternalLink>
      </p>
    </SettingsGroup>
  );
}
