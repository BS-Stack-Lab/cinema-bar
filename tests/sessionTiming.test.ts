import { describe, expect, it } from 'vitest';
import {
  compareSessions,
  isFutureSession,
  sessionFormatLabel,
  sessionStartsAt,
  sessionTimeLabel,
} from '../electron/sessionTiming';
import { session } from './fixtures';
describe('Korean business time and deterministic earliest sessions', () => {
  it('handles 24–29 hour values by arithmetic and expires at the exact start', () => {
    const now = Date.parse('2026-10-20T15:30:00Z');
    const times = ['23:00', '24:20', '24:30', '25:00', '29:00'];
    expect(times.map((time) => isFutureSession({ date: '2026-10-20', time }, now))).toEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
    expect(sessionStartsAt({ date: '2026-10-20', time: '25:00' })).toBe(
      Date.parse('2026-10-20T16:00:00Z'),
    );
    expect(sessionTimeLabel({ time: '25:00' })).toBe('25:00 (다음 날 01:00)');
    expect(sessionFormatLabel('UNKNOWN')).toBe('포맷 미확인');
  });
  it('validates real dates, ranges, leap years and years below 100 without Date.UTC correction', () => {
    for (const [date, time] of [
      ['2026-02-29', '12:00'],
      ['2026-13-01', '12:00'],
      ['2026-01-00', '12:00'],
      ['2026-10-20', '30:00'],
      ['2026-10-20', '23:60'],
      ['2026-10-20', '1:00'],
    ])
      expect(sessionStartsAt({ date, time })).toBeUndefined();
    expect(sessionStartsAt({ date: '0099-01-02', time: '09:00' })).toBe(
      Date.parse('0099-01-02T00:00:00Z'),
    );
    expect(sessionStartsAt({ date: '2000-02-29', time: '24:00' })).toBe(
      Date.parse('2000-02-29T15:00:00Z'),
    );
  });
  it('orders by absolute start, actual format, screen and stable identity regardless of arrival', () => {
    const candidates = [
      { ...session, time: '18:00', format: '2D' as const },
      { ...session, time: '10:00', format: 'IMAX' as const, showingId: 'b', screen: '2관' },
      { ...session, time: '10:00', format: 'DOLBY' as const },
      { ...session, time: '10:00', format: 'IMAX' as const, showingId: 'a', screen: '1관' },
    ];
    const forward = [...candidates].sort(compareSessions);
    expect([...candidates].reverse().sort(compareSessions)).toEqual(forward);
    expect(forward.map((s) => [s.time, s.format, s.screen])).toEqual([
      ['10:00', 'DOLBY', '1관'],
      ['10:00', 'IMAX', '1관'],
      ['10:00', 'IMAX', '2관'],
      ['18:00', '2D', '1관'],
    ]);
  });
});
