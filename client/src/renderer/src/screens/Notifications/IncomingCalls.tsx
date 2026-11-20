import { isMobile } from '../../shared/window-controls';
import { useNarrow } from '../../shared/narrow';
import { incomingCallStyle, setNotificationSettings, type IncomingCallStyle } from '../../modules/ui/notifications.store';
import { useNotificationSettings } from '../../modules/notifications/use-settings';
import './IncomingCalls.css';

const OPTIONS: Array<[IncomingCallStyle, string]> = [['full', 'Full screen'], ['banner', 'Banner']];

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
      <div role="radiogroup" aria-labelledby={label ? `incoming-calls-${layout}` : undefined} aria-label={label ? undefined : 'Incoming calls'} class="incoming-calls-seg">
        {OPTIONS.map(([k, text]) => (
          <button key={k} type="button" role="radio" aria-checked={value === k}
            class={`incoming-calls-opt${value === k ? ' incoming-calls-opt-on' : ''}`}
            onClick={() => setNotificationSettings({ incomingCalls: k })}>
            {text}
          </button>
        ))}
      </div>
      <span class="incoming-calls-hint">
        {value === 'full' ? 'A ringing call takes the whole screen.' : 'A ringing call drops in as a banner; tap it for full screen.'}
      </span>
    </div>
  );
}
