import { bookingUrl, matches, normalizeTitle, object, validDate, text } from '../validation.js';
import type { Provider, Rule, Session } from '../types.js';
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type ProviderAdapter = (rule: Rule, signal: AbortSignal) => Promise<Session[]>;
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs = 0,
  ) {
    super(message);
  }
}
export function retryAfter(value: string | null, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  return Number.isFinite(seconds)
    ? Math.max(0, seconds * 1000)
    : Math.max(0, Date.parse(value) - now) || 0;
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 10000)
    throw new ProviderError('공급자 응답 형식이 변경되었습니다.');
  return value.map(object);
}
function field(value: unknown, max = 120) {
  return text(typeof value === 'number' ? String(value) : value, max);
}
function decode(value: unknown) {
  return field(value)
    .replace(/&amp;/gu, '&')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&nbsp;/gu, ' ');
}
function date(value: unknown) {
  const str = field(value, 20);
  if (str !== String(value) || !/^(?:\d{8}|\d{4}-\d{2}-\d{2})$/u.test(str))
    throw new ProviderError('공급자 상영 날짜를 해석할 수 없습니다.');
  return validDate(
    /^\d{8}$/u.test(str) ? `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}` : str,
  );
}
function time(value: unknown) {
  const source = field(value, 10);
  if (source !== String(value) || !/^(?:\d{4}|\d{2}:\d{2}|\d{4}00)$/u.test(source))
    throw new ProviderError('공급자 상영 시각을 해석할 수 없습니다.');
  const str = source.replace(':', '');
  if (Number(str.slice(0, 2)) > 29 || Number(str.slice(2, 4)) > 59)
    throw new ProviderError('공급자 상영 시각을 해석할 수 없습니다.');
  return `${str.slice(0, 2)}:${str.slice(2, 4)}`;
}
function available(value: unknown) {
  return (
    (typeof value === 'number' || typeof value === 'string') &&
    value !== '' &&
    Number.isFinite(Number(value)) &&
    Number(value) > 0
  );
}
export function normalizeFormat(...values: unknown[]): Session['format'] {
  const value = values
    .filter((v) => typeof v === 'string')
    .join(' ')
    .toUpperCase();
  if (/IMAX|아이맥스/u.test(value)) return 'IMAX';
  if (/4DX/u.test(value)) return '4DX';
  if (/SCREEN\s?X/u.test(value)) return 'SCREENX';
  if (/DOLBY|돌비/u.test(value)) return 'DOLBY';
  if (/(?:^|[^\d])3D/u.test(value)) return '3D';
  if (/(?:^|[^\d])2D|디지털\s?2D/u.test(value)) return '2D';
  return 'UNKNOWN';
}
function route(provider: Provider) {
  return {
    cgv: 'https://cgv.co.kr/cnm/movieBook/movie',
    megabox: 'https://www.megabox.co.kr/booking',
    lottecinema: 'https://www.lottecinema.co.kr/NLCHS/Ticketing',
  }[provider];
}
export function parseCgv(payload: unknown, now = Date.now()): Session[] {
  try {
    const body = object(payload);
    if (body.statusCode !== 0 && body.statusCode !== 200)
      throw new ProviderError('CGV 응답 상태를 확인할 수 없습니다.');
    return rows(body.data).map((r) => {
      const businessDate = date(r.scnYmd);
      const startTime = time(r.scnsrtTm);
      const start =
        Date.parse(`${businessDate}T00:00:00+09:00`) +
        (Number(startTime.slice(0, 2)) * 60 + Number(startTime.slice(3))) * 60000;
      return {
        provider: 'cgv',
        showingId: [
          field(r.siteNo, 24),
          businessDate,
          field(r.scnsNo, 80),
          field(r.scnSseq, 80),
        ].join('-'),
        theaterId: field(r.siteNo, 24),
        theaterName: decode(r.siteNm),
        movieId: field(r.movNo, 80),
        movieTitle: decode(r.movNm),
        date: businessDate,
        time: startTime,
        screen: field(r.scnsNm, 80),
        format: normalizeFormat(r.movkndDsplNm, r.tcscnsGradNm, r.sascnsGradNm),
        isBookable: available(r.frSeatCnt) && r.cntlYn === 'N' && start > now,
        bookingUrl: route('cgv'),
      };
    });
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('CGV 상영 응답 형식이 변경되었습니다.');
  }
}
export function parseMegabox(payload: unknown): Session[] {
  const body = object(payload);
  if (body.statCd !== 0 && body.statCd !== '0')
    throw new ProviderError('메가박스 응답 상태를 확인할 수 없습니다.');
  return rows(body.movieFormList).map((r) => ({
    provider: 'megabox',
    showingId: field(r.playSchdlNo, 80),
    theaterId: field(r.brchNo, 24),
    theaterName: decode(r.brchNm),
    movieId: field(r.movieNo, 80),
    movieTitle: decode(r.movieNm),
    date: date(r.playDe),
    time: time(r.playStartTime),
    screen: field(r.theabExpoNm ?? r.theabNm ?? r.theabNo ?? '미제공', 80),
    format: normalizeFormat(r.playKindNm, r.movieTypeNm, r.movieFormNm, r.movie2d3dDivNm),
    isBookable: available(r.restSeatCnt) && r.bokdAbleAt === 'Y' && r.brchBokdUnableAt === 'N',
    bookingUrl: route('megabox'),
  }));
}
export function parseLotte(
  payload: unknown,
  rule: Rule,
  movie: { id: string; title: string },
): Session[] {
  const body = object(payload);
  if (body.IsOK === false) throw new ProviderError('롯데시네마가 요청을 거절했습니다.');
  const list = rows(object(body.PlaySeqs).Items);
  return list.map((r) => ({
    provider: 'lottecinema',
    showingId: [date(r.PlayDt ?? rule.date), field(r.ScreenID, 80), field(r.PlaySequence, 80)].join(
      '-',
    ),
    theaterId: field(r.CinemaID, 24),
    theaterName: decode(r.CinemaNameKR ?? rule.theaterName),
    movieId: field(r.RepresentationMovieCode, 80),
    movieTitle: decode(r.MovieNameKR ?? movie.title),
    date: date(r.PlayDt ?? rule.date),
    time: time(r.StartTime),
    screen: field(r.ScreenNameKR ?? r.ScreenID, 80),
    format: normalizeFormat(r.FilmNameKR, r.ScreenDivisionNameKR, r.MovieFormatName),
    isBookable: available(r.BookingSeatCount) && r.IsBookingYN === 'Y',
    bookingUrl: route('lottecinema'),
  }));
}
export function createProviders(
  fetcher: Fetcher = fetch,
  cgvFetcher: Fetcher = fetcher,
  now: () => number = Date.now,
): Record<Provider, ProviderAdapter> {
  async function request(
    url: string,
    signal: AbortSignal,
    init: RequestInit = {},
    transport = fetcher,
  ) {
    const timeout = AbortSignal.timeout(15000);
    let response: Response;
    try {
      response = await transport(url, {
        ...init,
        signal: AbortSignal.any([signal, timeout]),
        redirect: 'error',
      });
    } catch {
      if (signal.aborted) throw new ProviderError('조회가 취소되었습니다.');
      throw new ProviderError('네트워크 또는 조회 시간 초과입니다. 연결을 확인하세요.');
    }
    if (!response.ok)
      throw new ProviderError(
        `공급자 HTTP ${response.status} — 잠시 후 다시 확인하세요.`,
        retryAfter(response.headers.get('retry-after')),
      );
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new ProviderError('공급자가 올바른 JSON을 반환하지 않았습니다.');
    }
  }
  async function lotteRequest(method: string, fields: Record<string, string>, signal: AbortSignal) {
    const form = new FormData();
    form.set(
      'paramList',
      JSON.stringify({
        MethodName: method,
        channelType: 'HO',
        osType: 'W',
        osVersion: 'CinemaBar/0.1',
        ...fields,
      }),
    );
    return request('https://www.lottecinema.co.kr/LCWS/Ticketing/TicketingData.aspx', signal, {
      method: 'POST',
      body: form,
      headers: { Accept: 'application/json' },
    });
  }
  return {
    cgv: async (rule, signal) => {
      const query = new URLSearchParams({
        coCd: 'A420',
        siteNo: rule.theaterId,
        scnYmd: rule.date.replaceAll('-', ''),
        rtctlScopCd: '08',
      });
      return parseCgv(
        await request(
          `https://cgv.co.kr/api/v1/booking/searchMovScnInfo?${query}`,
          signal,
          {
            headers: {
              Accept: 'application/json',
              'Accept-Language': 'ko-KR',
              Referer: 'https://cgv.co.kr/cnm/movieBook/movie',
            },
            credentials: 'omit',
            cache: 'no-store',
          },
          cgvFetcher,
        ),
        now(),
      );
    },
    megabox: async (rule, signal) => {
      const form = new URLSearchParams({
        playDe: rule.date.replaceAll('-', ''),
        sellChnlCd: 'ONLINE',
        brchNoListCnt: '1',
        areaCd1: '11',
        spclbYn1: 'N',
        theabKindCd1: '',
        brchNo1: rule.theaterId,
      });
      if (rule.movieId) form.set('arrMovieNo', rule.movieId);
      return parseMegabox(
        await request(
          'https://www.megabox.co.kr/on/oh/ohb/SimpleBooking/selectBokdList.do',
          signal,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
              Accept: 'application/json',
              'X-Requested-With': 'XMLHttpRequest',
            },
            body: form.toString(),
          },
        ),
      );
    },
    lottecinema: async (rule, signal) => {
      const catalog = object(
        await lotteRequest('GetTicketingPageTOBE', { memberOnNo: '0' }, signal),
      );
      if (catalog.IsOK === false) throw new ProviderError('롯데시네마 목록 조회가 거절되었습니다.');
      const theaters = rows(object(object(catalog.Cinemas).Cinemas).Items);
      const movies = rows(object(object(catalog.Movies).Movies).Items);
      const theater = theaters.find((t) => String(t.CinemaID) === rule.theaterId);
      const movie = movies.find((m) =>
        rule.movieId
          ? String(m.RepresentationMovieCode) === rule.movieId
          : typeof m.MovieNameKR === 'string' &&
            normalizeTitle(m.MovieNameKR) === normalizeTitle(rule.movieTitle),
      );
      if (!theater || !movie) return [];
      const id = field(movie.RepresentationMovieCode, 80);
      const title = decode(movie.MovieNameKR);
      return parseLotte(
        await lotteRequest(
          'GetPlaySequence',
          {
            playDate: rule.date,
            cinemaID: `${field(theater.DivisionCode, 12)}|${field(theater.DetailDivisionCode, 12)}|${rule.theaterId}`,
            representationMovieCode: id,
          },
          signal,
        ),
        rule,
        { id, title },
      );
    },
  };
}
export function eligibleSessions(rule: Rule, sessions: Session[]) {
  return sessions
    .filter((s) => matches(rule, s, false))
    .map((s) => ({ ...s, bookingUrl: bookingUrl(s.provider, s.bookingUrl) }));
}
