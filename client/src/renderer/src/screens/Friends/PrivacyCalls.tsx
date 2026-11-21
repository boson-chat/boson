import { IncomingCallsSetting } from '../Notifications/IncomingCalls';
import { Card, EmptyState, Segmented, SwitchRow } from '@boson/shared';
import { useFriends, type CallPolicy, type RequestPolicy } from '../../modules/friends';
import './PrivacyCalls.css';

const CALL_HINT: Record<CallPolicy, { desktop: string; phone: string }> = {
  nobody: { desktop: 'Nobody can call you, except friends who can call you anytime.', phone: 'Nobody can call you, except friends who can call you anytime.' },
  friends: { desktop: 'Only friends can call you. Others see “only takes calls from friends”.', phone: 'Only friends can call you.' },
  everyone: { desktop: 'Anyone who isn’t blocked can call you.', phone: 'Anyone who isn’t blocked can call you.' },
};

// Who can call me, Do not disturb, who can send me friend requests. In
// Settings → Privacy & calls (desktop) and the phone's Calls tab.
export function PrivacyCalls({ layout }: { layout: 'desktop' | 'phone' }) {
  const { friends, snap } = useFriends();
  if (!friends || !snap.available) {
    return <EmptyState>Sign in to your Boson account to set who can call you.</EmptyState>;
  }
  const p = snap.privacy;
  const phone = layout === 'phone';
  const size = phone ? 'lg' : 'md';
  const callOpts: Array<{ id: CallPolicy; label: string }> = [
    { id: 'nobody', label: 'Nobody' }, { id: 'friends', label: 'Friends' }, { id: 'everyone', label: 'Everyone' },
  ];
  const reqOpts: Array<{ id: RequestPolicy; label: string }> = [
    { id: 'nobody', label: 'Nobody' }, { id: 'servers', label: 'People in my servers' }, { id: 'everyone', label: 'Everyone' },
  ];
  return (
    <div class={`privacy privacy-${layout}`}>
      <Card variant="raised"><section class="privacy-card">
        {!phone && (
          <>
            <span class="privacy-card-title">Private calls</span>
            <span class="privacy-card-desc">Let people call you directly (right-click a name → Call).</span>
          </>
        )}
        <span class="privacy-label">WHO CAN CALL ME</span>
        <Segmented label="Who can call me" value={p.calls} options={callOpts} size={size} onChange={(calls) => { void friends.setPrivacy({ calls }); }} />
        <span class="privacy-hint">{CALL_HINT[p.calls][layout]}</span>
        <SwitchRow class="privacy-dnd" size={size} title="Do not disturb"
          description={phone ? 'Only friends who can call you anytime ring.' : 'No calls ring, except friends who can call you anytime. Missed calls are listed.'}
          checked={p.doNotDisturb} onChange={(on) => { void friends.setPrivacy({ doNotDisturb: on }); }} />
        <IncomingCallsSetting layout="desktop" />
      </section></Card>
      <Card variant="raised"><section class="privacy-card">
        {phone ? <span class="privacy-label">FRIEND REQUESTS</span> : <span class="privacy-card-title">Friend requests</span>}
        <Segmented label="Who can send me friend requests" value={p.friendRequests} options={reqOpts} size={size}
          onChange={(friendRequests) => { void friends.setPrivacy({ friendRequests }); }} />
      </section></Card>
      {phone && (
        <Card variant="raised"><section class="privacy-card">
          <span class="privacy-label">CALLS RING</span>
          <span class="privacy-hint">While Boson is open. When it's closed or in the background, you'll see missed calls next time you open it.</span>
        </section></Card>
      )}
    </div>
  );
}
