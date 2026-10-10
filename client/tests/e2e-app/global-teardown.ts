// Coverage runs (E2E_COVERAGE=1): build the per-layer reports + summary.md
// from the raw data the fixtures collected. No-op otherwise.
import { COVERAGE } from './coverage/config';

export default async function globalTeardown(): Promise<void> {
  if (!COVERAGE) return;
  const { generateE2eCoverageReport } = await import('./coverage/report');
  await generateE2eCoverageReport();
}
