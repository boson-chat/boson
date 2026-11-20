import { Segmented, type SegmentedOption } from '@boson/shared';
import { isMobile } from '../../shared/window-controls';
import { useNarrow } from '../../shared/narrow';
import { incomingCallStyle, setNotificationSettings, type IncomingCallStyle } from '../../modules/ui/notifications.store';
import { useNotificationSettings } from '../../modules/notifications/use-settings';
import './IncomingCalls.css';

const OPTIONS: ReadonlyArray<SegmentedOption<IncomingCallStyle>> = [{ id: 'full', label: 'Full screen' }, { id: 'banner', label: 'Banner' }];

// "Incoming calls: Full screen | Banner", as on iOS: how a call ringing for
// you shows on this device (phones default to full screen, desktop to the
// banner in the corner).
export function IncomingCallsSetting({ layout = 'desktop', label = true }: { layout?: 'desktop' | 'phone'; label?: boolean }) {
  const s = useNotificationSettings();
  const narrow = useNarrow();
  const value = incomingCallStyle(narrow || isMobile(), s);
  return (
    <div class={`incoming-calls incoming-calls-${layout}`}>
      {label && <span class="incoming-calls-label" id={`incoming-calls-${layout}`}>INCOMING CALLS</span>}
      <Segmented
        labelledBy={label ? `incoming-calls-${layout}` : undefined}
        label={label ? undefined : 'Incoming calls'}
        value={value}
        options={OPTIONS}
        size={layout === 'phone' ? 'lg' : 'md'}
        onChange={(k) => setNotificationSettings({ incomingCalls: k })}
      />
      <span class="incoming-calls-hint">
        {value === 'full' ? 'A ringing call takes the whole screen.' : 'A ringing call drops in as a banner; tap it for full screen.'}
      </span>
    </div>
  );
}
