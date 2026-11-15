import { describe, it, expect } from 'vitest';
import {
  describeUploadError, fileTooLargeMessage, formatBytes, formatDuration, formatWindow, quotaExceededMessage,
  STORAGE_FULL_MESSAGE, usageSummary,
} from './quota';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const H = 3_600_000;
const GB = 1e9;

describe('formatting', () => {
  it('sizes in decimal units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1500)).toBe('1.5 KB');
    expect(formatBytes(25e6)).toBe('25 MB');
    expect(formatBytes(4.8 * GB)).toBe('4.8 GB');
    expect(formatBytes(5 * GB)).toBe('5 GB');
    expect(formatBytes(1.04 * GB)).toBe('1 GB');
    expect(formatBytes(140e6)).toBe('140 MB');
  });
  it('durations', () => {
    expect(formatDuration(30_000)).toBe('1 min');
    expect(formatDuration(45 * 60_000)).toBe('45 min');
    expect(formatDuration(20 * H)).toBe('20 h');
    expect(formatDuration(19.6 * H)).toBe('20 h');
    expect(formatDuration(47 * H)).toBe('47 h');
    expect(formatDuration(49 * H)).toBe('2 days');
  });
  it('windows', () => {
    expect(formatWindow(259_200)).toBe('3 days');
    expect(formatWindow(86_400)).toBe('day');
    expect(formatWindow(129_600)).toBe('36 h');
  });
});

describe('quota messages', () => {
  const err = { used: 4.8 * GB, quota: 5 * GB, window_seconds: 259_200, frees_at: new Date(NOW + 20 * H).toISOString() };

  it('says how much is used and when how much frees up', () => {
    const frees = [{ bytes: 1 * GB, at: new Date(NOW + 20 * H).toISOString() }, { bytes: 2 * GB, at: new Date(NOW + 40 * H).toISOString() }];
    expect(quotaExceededMessage(err, { now: NOW, frees }))
      .toBe("You've used 4.8 GB of 5 GB in the last 3 days, 1 GB frees up in 20 h");
  });
  it('without the schedule: just when space frees up', () => {
    expect(quotaExceededMessage(err, { now: NOW })).toBe("You've used 4.8 GB of 5 GB in the last 3 days, space frees up in 20 h");
  });
  it('accepts unix-seconds times', () => {
    expect(quotaExceededMessage({ ...err, frees_at: (NOW + 20 * H) / 1000 }, { now: NOW, frees: [{ bytes: GB, at: (NOW + 20 * H) / 1000 }] }))
      .toBe("You've used 4.8 GB of 5 GB in the last 3 days, 1 GB frees up in 20 h");
  });
  it('the meter line', () => {
    expect(usageSummary({ used: 1.2 * GB, quota: 5 * GB, window_seconds: 259_200, max_file: 100e6, frees: [{ bytes: GB, at: new Date(NOW + 20 * H).toISOString() }] }, NOW))
      .toBe('1.2 GB of 5 GB used · 1 GB frees in 20 h');
    expect(usageSummary({ used: 0, quota: 5 * GB, window_seconds: 259_200, max_file: 100e6, frees: [] }, NOW)).toBe('0 B of 5 GB used');
  });
  it('file too large names the limit', () => {
    expect(fileTooLargeMessage(100e6, { name: 'big.zip', size: 140e6 })).toBe('big.zip is 140 MB; the limit is 100 MB per file.');
    expect(fileTooLargeMessage(25e6)).toBe('That file is too large; the limit is 25 MB per file.');
  });
});

describe('describeUploadError', () => {
  it('quota_exceeded, details at the top level or under details', () => {
    const body = JSON.stringify({ error: 'quota_exceeded', used: 4.8 * GB, quota: 5 * GB, window_seconds: 259_200, frees_at: new Date(NOW + 20 * H).toISOString() });
    expect(describeUploadError(413, body, { now: NOW })).toEqual({
      code: 'quota_exceeded', message: "You've used 4.8 GB of 5 GB in the last 3 days, space frees up in 20 h",
    });
    const nested = JSON.stringify({ code: 'quota_exceeded', details: { used: 4.8 * GB, quota: 5 * GB, window_seconds: 259_200, frees_at: new Date(NOW + 20 * H).toISOString() } });
    expect(describeUploadError(413, nested, { now: NOW }).message).toContain('4.8 GB of 5 GB');
  });
  it('file_too_large', () => {
    expect(describeUploadError(413, '{"error":"file_too_large","max":25000000}', { file: { name: 'a.mov', size: 30e6 } }))
      .toEqual({ code: 'file_too_large', message: 'a.mov is 30 MB; the limit is 25 MB per file.' });
  });
  it('storage_full (507), distinct from the quota message', () => {
    const e = describeUploadError(507, '{"code":"storage_full"}');
    expect(e).toEqual({ code: 'storage_full', message: STORAGE_FULL_MESSAGE });
    expect(e.message).toBe("This server's file storage is full right now — try again later");
    expect(e.message).not.toMatch(/You've used/);
    expect(describeUploadError(507, 'not json').code).toBe('storage_full');
  });
  it('quota_exceeded with frees_at null: bigger than the whole quota', () => {
    expect(describeUploadError(413, JSON.stringify({ error: 'quota_exceeded', used: 0, quota: 5 * GB, window_seconds: 259_200, frees_at: null })).message)
      .toBe('This file is bigger than your whole upload allowance (5 GB per 3 days)');
  });
  it('the service\'s other codes', () => {
    expect(describeUploadError(503, '{"error":"uploads_disabled"}').message).toBe('File uploads are turned off on this server right now');
    expect(describeUploadError(403, '{"error":"guest_disabled"}').message).toBe('This server only takes uploads from signed-in users');
    expect(describeUploadError(429, '{"error":"rate_limited"}', { retryAfter: '120' }).message).toBe('Too many uploads — try again in 2 min');
    expect(describeUploadError(429, '{"error":"rate_limited"}').message).toBe('Too many uploads — try again in a moment');
    expect(describeUploadError(400, '{"error":"empty_file"}').message).toBe('That file is empty');
    expect(describeUploadError(400, '{"error":"incomplete_body"}').message).toBe("The file didn't arrive in full — try again");
    expect(describeUploadError(411, '{"error":"length_required"}').code).toBe('length_required');
  });
  it('anything else says what happened', () => {
    expect(describeUploadError(0, '').message).toBe("Couldn't reach the files server");
    expect(describeUploadError(403, '{"error":"forbidden"}').message).toBe("You can't upload files on this server");
    expect(describeUploadError(500, '{"error":"internal_error","message":"boom"}').message).toBe('Upload failed (500): boom');
  });
});
