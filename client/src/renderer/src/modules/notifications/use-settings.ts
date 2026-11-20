import { useEffect, useState } from 'preact/hooks';
import { getNotificationSettings, onNotificationSettingsChange, type NotificationSettings } from '../ui/notifications.store';

// The notification settings, live.
export function useNotificationSettings(): NotificationSettings {
  const [s, set] = useState(() => getNotificationSettings());
  useEffect(() => onNotificationSettingsChange(() => set(getNotificationSettings())), []);
  return s;
}
