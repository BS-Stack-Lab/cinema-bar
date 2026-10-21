import type { Session } from './types.js';
import { sessionIdentity } from './validation.js';

export function sessionStartsAt(session: Pick<Session, 'date' | 'time'>): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(session.date) || !/^\d{2}:\d{2}$/u.test(session.time))
    return undefined;
  const [year, month, day] = session.date.split('-').map(Number);
  const [hour, minute] = session.time.split(':').map(Number);
  if (hour > 29 || minute > 59 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const midnight = new Date(0);
  midnight.setUTCFullYear(year, month - 1, day);
  midnight.setUTCHours(0, 0, 0, 0);
  if (midnight.toISOString().slice(0, 10) !== session.date) return undefined;
  return midnight.getTime() + (hour * 60 + minute - 9 * 60) * 60000;
}
export function isFutureSession(session: Pick<Session, 'date' | 'time'>, now: number) {
  return (sessionStartsAt(session) ?? -Infinity) > now;
}
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export function compareSessions(a: Session, b: Session) {
  return (
    (sessionStartsAt(a) ?? Infinity) - (sessionStartsAt(b) ?? Infinity) ||
    compareText(a.format, b.format) ||
    compareText(a.screen, b.screen) ||
    compareText(sessionIdentity(a), sessionIdentity(b))
  );
}
export function sessionTimeLabel(session: Pick<Session, 'time'>) {
  const [hour, minute] = session.time.split(':').map(Number);
  return hour >= 24
    ? `${session.time} (다음 날 ${String(hour - 24).padStart(2, '0')}:${String(minute).padStart(2, '0')})`
    : session.time;
}
export function sessionFormatLabel(format: Session['format']) {
  return format === 'UNKNOWN' ? '포맷 미확인' : format;
}
