// Counts are sent as buckets, never exact numbers (the telemetry spec,
// boson-chat/stack docs/telemetry.md "Buckets").

export const BUCKETS = ['0', '1', '2-10', '11-50', '51-100', '101-500', '501-1k', '1k-5k', '5k+'] as const;
export type Bucket = typeof BUCKETS[number];

export function bucket(n: number): Bucket {
  if (!(n > 0)) return '0';
  if (n <= 1) return '1';
  if (n <= 10) return '2-10';
  if (n <= 50) return '11-50';
  if (n <= 100) return '51-100';
  if (n <= 500) return '101-500';
  if (n <= 1000) return '501-1k';
  if (n <= 5000) return '1k-5k';
  return '5k+';
}
