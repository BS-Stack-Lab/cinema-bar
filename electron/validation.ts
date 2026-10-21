import {
  FORMATS,
  PROVIDERS,
  type Provider,
  type RuleInput,
  type Session,
  type State,
} from './types.js';
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('올바른 객체가 필요합니다.');
  return value as Record<string, unknown>;
}
export function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error('지원하지 않는 입력입니다.');
}
export function text(value: unknown, max = 120): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error('비어 있지 않은 올바른 텍스트를 입력하세요.');
  return value.trim();
}
export function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('올바른 켜짐/꺼짐 값이 필요합니다.');
  return value;
}
export function normalizeTitle(value: string) {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('ko-KR');
}
export function koreanToday(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now));
}
export function validDate(value: unknown): string {
  const date = text(value, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
  )
    throw new Error('날짜를 YYYY-MM-DD 형식으로 입력하세요.');
  return date;
}
export function validateRule(value: unknown, allowPast = false): RuleInput {
  const v = object(value);
  exact(v, [
    'id',
    'provider',
    'theaterId',
    'theaterName',
    'movieTitle',
    'movieId',
    'date',
    'format',
    'isEnabled',
    'shouldNotifyEarliestOnly',
  ]);
  if (!PROVIDERS.includes(v.provider as Provider)) throw new Error('영화관을 선택하세요.');
  if (!FORMATS.includes(v.format as (typeof FORMATS)[number]))
    throw new Error('상영 포맷을 선택하세요.');
  const theaterId = text(v.theaterId, 24);
  if (!/^[\dA-Za-z_-]+$/u.test(theaterId))
    throw new Error('극장 ID는 영문·숫자·하이픈만 입력하세요.');
  const date = validDate(v.date);
  if (!allowPast && date < koreanToday()) throw new Error('오늘 이후의 한국 날짜를 선택하세요.');
  return {
    ...(v.id === undefined ? {} : { id: text(v.id, 80) }),
    provider: v.provider as Provider,
    theaterId,
    theaterName: text(v.theaterName, 80),
    movieTitle: text(v.movieTitle),
    ...(v.movieId === undefined ? {} : { movieId: text(v.movieId, 80) }),
    date,
    format: v.format as RuleInput['format'],
    isEnabled: flag(v.isEnabled),
    ...(Object.hasOwn(v, 'shouldNotifyEarliestOnly')
      ? { shouldNotifyEarliestOnly: flag(v.shouldNotifyEarliestOnly) }
      : {}),
  };
}
export function validateSettings(value: unknown) {
  const v = object(value);
  exact(v, ['intervalSeconds', 'shouldStartAtLogin', 'shouldNotifyLocally', 'shouldKeepAwake']);
  const result: {
    intervalSeconds?: number;
    shouldStartAtLogin?: boolean;
    shouldNotifyLocally?: boolean;
    shouldKeepAwake?: boolean;
  } = {};
  if (v.intervalSeconds !== undefined) {
    if (
      !Number.isInteger(v.intervalSeconds) ||
      (v.intervalSeconds as number) < 60 ||
      (v.intervalSeconds as number) > 3600
    )
      throw new Error('조회 간격은 60~3600초로 입력하세요.');
    result.intervalSeconds = v.intervalSeconds as number;
  }
  if (v.shouldStartAtLogin !== undefined) result.shouldStartAtLogin = flag(v.shouldStartAtLogin);
  if (v.shouldNotifyLocally !== undefined) result.shouldNotifyLocally = flag(v.shouldNotifyLocally);
  if (v.shouldKeepAwake !== undefined) result.shouldKeepAwake = flag(v.shouldKeepAwake);
  return result;
}
export function validateWebhook(value: unknown) {
  const raw = text(value, 300);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Discord 웹훅 주소를 확인하세요.');
  }
  if (
    u.protocol !== 'https:' ||
    !['discord.com', 'discordapp.com'].includes(u.hostname) ||
    u.port ||
    u.username ||
    u.password ||
    u.hash ||
    u.search ||
    !/^\/api\/(?:v10\/)?webhooks\/\d{5,24}\/[A-Za-z0-9_-]{20,200}$/u.test(u.pathname)
  )
    throw new Error('Discord의 HTTPS 웹훅 주소만 연결할 수 있습니다.');
  return `https://discord.com${u.pathname.replace(/^\/api\/webhooks/u, '/api/v10/webhooks')}`;
}
export function bookingUrl(provider: Provider, value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.port || u.username || u.password || u.hash) return '';
    const allowed: Record<Provider, [string[], RegExp]> = {
      cgv: [
        ['cgv.co.kr', 'www.cgv.co.kr', 'cgv.co.kr', 'm.cgv.co.kr'],
        /^\/(?:cnm\/movieBook\/movie$|cnm\/booking(?:\/|$)|ticket(?:\/|$)|reserve(?:\/|$))/u,
      ],
      megabox: [['www.megabox.co.kr'], /^\/booking(?:$|\/)/u],
      lottecinema: [['www.lottecinema.co.kr'], /^\/NLCHS\/Ticketing(?:$|\/)/u],
    };
    const [hosts, path] = allowed[provider];
    if (
      !hosts.includes(u.hostname) ||
      !path.test(u.pathname) ||
      [...u.searchParams.keys()].some((key) => /redirect|url|next|callback/iu.test(key))
    )
      return '';
    return u.toString();
  } catch {
    return '';
  }
}
export function matches(rule: RuleInput & { movieId?: string }, session: Session, bookable = true) {
  return (
    rule.provider === session.provider &&
    rule.theaterId === session.theaterId &&
    (rule.movieId
      ? rule.movieId === session.movieId
      : normalizeTitle(rule.movieTitle) === normalizeTitle(session.movieTitle)) &&
    rule.date === session.date &&
    (rule.format === 'ALL' || rule.format === session.format) &&
    (!bookable || session.isBookable)
  );
}
export function sessionIdentity(s: Session) {
  return JSON.stringify([
    s.provider,
    s.theaterId,
    s.date,
    s.showingId || [s.movieId || normalizeTitle(s.movieTitle), s.date, s.time, s.screen, s.format],
  ]);
}
function number(value: unknown, min = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min)
    throw new Error('저장 데이터 숫자가 손상되었습니다.');
}
function validateSession(value: unknown): asserts value is Session {
  const s = object(value);
  if (!PROVIDERS.includes(s.provider as Provider)) throw new Error('저장 영화관 오류');
  for (const key of ['theaterId', 'theaterName', 'movieId', 'movieTitle', 'time', 'screen'])
    text(s[key], key === 'movieTitle' ? 120 : 120);
  validDate(s.date);
  if (
    !/^\d{2}:\d{2}$/u.test(String(s.time)) ||
    ![...FORMATS.slice(1), 'UNKNOWN'].includes(s.format as never)
  )
    throw new Error('저장 상영 정보 오류');
  flag(s.isBookable);
  if (
    Object.hasOwn(s, 'notificationKind') &&
    !['dayOpen', 'earliest'].includes(s.notificationKind as string)
  )
    throw new Error('저장 알림 종류 오류');
  if (
    typeof s.bookingUrl !== 'string' ||
    s.bookingUrl.length > 2000 ||
    (s.bookingUrl && !bookingUrl(s.provider as Provider, s.bookingUrl))
  )
    throw new Error('저장 예매 주소 오류');
}
export function validateState(value: unknown, legacy = false): State {
  const s = object(value);
  if (s.schemaVersion !== (legacy ? 1 : 2))
    throw new Error(
      typeof s.schemaVersion === 'number' && s.schemaVersion > 2
        ? '새 버전 저장 형식입니다. 앱을 업데이트하세요.'
        : '저장 형식이 손상되었습니다.',
    );
  if (
    !Array.isArray(s.rules) ||
    s.rules.length > 100 ||
    !Array.isArray(s.outbox) ||
    s.outbox.length > 1000 ||
    !Array.isArray(s.history) ||
    s.history.length > 100
  )
    throw new Error('저장 목록이 손상되었습니다.');
  if (
    legacy &&
    (Object.hasOwn(s, 'localOutbox') ||
      Object.hasOwn(s, 'localDedupe') ||
      Object.hasOwn(object(s.settings), 'shouldNotifyLocally'))
  )
    throw new Error('기존 저장 형식에 지원하지 않는 앱 알림 필드가 있습니다.');
  const ids = new Set();
  for (const rule of s.rules) {
    const r = object(rule);
    const { revision, movieId, ...input } = r;
    validateRule(input, true);
    text(r.id, 80);
    number(revision, 1);
    if (!Number.isInteger(revision) || ids.has(r.id)) throw new Error('저장 규칙 오류');
    ids.add(r.id);
    if (movieId !== undefined) text(movieId, 80);
  }
  const settings = object(s.settings);
  validateSettings({
    intervalSeconds: settings.intervalSeconds,
    shouldStartAtLogin: settings.shouldStartAtLogin,
  });
  flag(settings.isPaused);
  flag(settings.hasConfiguredLogin);
  if (!Number.isInteger(settings.intervalSeconds) || settings.shouldStartAtLogin === undefined)
    throw new Error('저장 설정 오류');
  if (!legacy) flag(settings.shouldNotifyLocally);
  if (Object.hasOwn(settings, 'shouldKeepAwake')) flag(settings.shouldKeepAwake);
  const secret = object(s.secret);
  number(secret.revision);
  flag(secret.isTerminal);
  if (secret.retryAt !== undefined) number(secret.retryAt);
  if (
    secret.encrypted !== undefined &&
    (typeof secret.encrypted !== 'string' ||
      secret.encrypted.length > 10000 ||
      !/^[A-Za-z0-9+/]+=*$/u.test(secret.encrypted))
  )
    throw new Error('암호화 저장 오류');
  for (const p of Object.values(object(s.progress))) {
    const v = object(p);
    number(v.revision, 1);
    number(v.failures);
    number(v.nextAt);
    number(v.count);
    for (const key of ['lastSuccess', 'lastFailure', 'retryUntil'])
      if (v[key] !== undefined) number(v[key]);
    if (v.error !== undefined) text(v.error, 240);
    if (v.baseline !== undefined) {
      const baseline = object(v.baseline);
      if (Object.keys(baseline).length > 10000) throw new Error('기준선 크기 오류');
      Object.values(baseline).forEach(flag);
    }
  }
  if (!legacy && (!Array.isArray(s.localOutbox) || s.localOutbox.length > 1000))
    throw new Error('앱 알림 대기 오류');
  for (const item of [...s.outbox, ...(legacy ? [] : (s.localOutbox as unknown[]))]) {
    const q = object(item);
    text(q.id, 1000);
    validateSession(q.session);
    for (const key of ['createdAt', 'nextAt', 'attempts']) number(q[key]);
    if ((s.outbox as unknown[]).includes(item)) number(q.secretRevision);
    if (!Array.isArray(q.ruleRefs) || q.ruleRefs.length > 100) throw new Error('대기 규칙 오류');
    for (const ref of q.ruleRefs) {
      const r = object(ref);
      text(r.id, 80);
      number(r.revision, 1);
    }
  }
  for (const record of [s.dedupe, ...(legacy ? [] : [s.localDedupe])]) {
    const dedupe = object(record);
    if (Object.keys(dedupe).length > 10000) throw new Error('중복 기록 크기 오류');
    Object.values(dedupe).forEach((v) => number(v));
  }
  for (const item of s.history) {
    const h = object(item);
    text(h.id, 1000);
    number(h.at);
    if (
      ![
        'sent',
        'failed',
        'expired',
        'overflow',
        ...(legacy ? [] : ['localRequested', 'localFailed', 'cancelled']),
      ].includes(String(h.kind))
    )
      throw new Error('이력 오류');
    text(h.title, 120);
    text(h.detail, 240);
  }
  return value as State;
}
