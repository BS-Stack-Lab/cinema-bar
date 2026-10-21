import type { Fetcher } from './providers/index.js';
import { retryAfter } from './providers/index.js';
import type { Session } from './types.js';
import { bookingUrl } from './validation.js';
import { alertHeading } from './dayAlerts.js';
import { sessionFormatLabel, sessionTimeLabel } from './sessionTiming.js';
export type DeliveryResult =
  | { kind: 'sent' }
  | { kind: 'retry'; delayMs: number; detail: string }
  | { kind: 'terminal' | 'failed'; detail: string };
export function discordPayload(session: Session) {
  const url = bookingUrl(session.provider, session.bookingUrl);
  const title = session.movieTitle.slice(0, 120);
  return {
    content: [
      `🎬 ${title}`,
      `${session.provider.toUpperCase()} · ${session.theaterName.slice(0, 80)}`,
      `${session.date} ${session.notificationKind === 'dayOpen' ? '가장 빠른 회차 ' : ''}${sessionTimeLabel(session)} · ${sessionFormatLabel(session.format)} · ${session.screen.slice(0, 80)}`,
      alertHeading(session),
      ...(url ? [url] : []),
    ]
      .join('\n')
      .slice(0, 1900),
    allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
  };
}
export function createDiscord(fetcher: Fetcher = fetch) {
  return async (url: string, session: Session, signal: AbortSignal): Promise<DeliveryResult> => {
    try {
      const response = await fetcher(`${url}?wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(discordPayload(session)),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        redirect: 'error',
      });
      if (response.ok) return { kind: 'sent' };
      if (response.status === 429) {
        let bodyDelay = 0;
        try {
          const body = (await response.json()) as { retry_after?: unknown };
          if (typeof body.retry_after === 'number' && Number.isFinite(body.retry_after))
            bodyDelay = Math.max(0, body.retry_after * 1000);
        } catch {
          /* Retry-After remains authoritative when the body is unavailable. */
        }
        return {
          kind: 'retry',
          delayMs: Math.max(1000, bodyDelay, retryAfter(response.headers.get('retry-after'))),
          detail: 'Discord 요청 제한 — 대기 후 재시도합니다.',
        };
      }
      if ([401, 403, 404].includes(response.status))
        return { kind: 'terminal', detail: `Discord HTTP ${response.status} — 웹훅을 교체하세요.` };
      if (response.status >= 500)
        return { kind: 'retry', delayMs: 0, detail: 'Discord 일시 오류 — 재시도 대기 중입니다.' };
      return { kind: 'failed', detail: `Discord HTTP ${response.status} — 전송이 거절되었습니다.` };
    } catch {
      return {
        kind: 'retry',
        delayMs: 0,
        detail: 'Discord 네트워크 또는 시간 초과 — 재시도 대기 중입니다.',
      };
    }
  };
}
