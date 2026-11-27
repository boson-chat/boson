import { useEffect, useState } from 'preact/hooks';
import { getPushManager, type PushRow } from './push.manager';

// Each connected Boson server's push state, live (Settings → Notifications).
export function usePushRows(): { rows: PushRow[]; platform: ReturnType<typeof getPushManager>['platform'] } {
  const m = getPushManager();
  const [rows, setRows] = useState(() => m.rows());
  useEffect(() => { setRows(m.rows()); return m.subscribe(() => setRows(m.rows())); }, [m]);
  return { rows, platform: m.platform };
}
