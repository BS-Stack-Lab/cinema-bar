import { ProviderError, retryAfter, type Fetcher } from './providers/index.js';
import { koreanToday, object, text } from './validation.js';
import type { Catalog, CatalogRequest, Provider } from './types.js';
const MAX_BODY = 2 * 1024 * 1024;
const TTL = 15 * 60 * 1000;
const MIN_REFRESH = 10000;
function rows(value: unknown) {
  if (!Array.isArray(value) || value.length > 10000) throw new Error('목록 배열 오류');
  return value.map(object);
}
function id(value: unknown, max = 80) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('목록 ID 오류');
  const result = text(typeof value === 'number' ? String(value) : value, max);
  if (!/^[\dA-Za-z_-]+$/u.test(result)) throw new Error('목록 ID 오류');
  return result;
}
function label(value: unknown, max: number) {
  const result = text(
    text(value, max * 8).replace(
      /&(amp|quot|lt|gt|nbsp);|&#(\d+);|&#x([\da-f]+);/giu,
      (match, name, dec, hex) => {
        if (name)
          return ({ amp: '&', quot: '"', lt: '<', gt: '>', nbsp: ' ' } as Record<string, string>)[
            name.toLowerCase()
          ];
        const point = Number.parseInt(dec ?? hex, dec ? 10 : 16);
        if (point > 0x10ffff) throw new Error('목록 텍스트 오류');
        return String.fromCodePoint(point);
      },
    ),
    max,
  );
  if (
    [...result].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
  )
    throw new Error('목록 텍스트 오류');
  return result;
}
function unique<T extends { id: string }>(items: T[]): T[] {
  const result = new Map<string, T>();
  for (const item of items) {
    const old = result.get(item.id);
    if (old && JSON.stringify(old) !== JSON.stringify(item)) throw new Error('중복 ID 불일치');
    result.set(item.id, item);
  }
  return [...result.values()];
}
export function parseCatalog(
  provider: Provider,
  payload: unknown,
  fetchedAt: number,
  moviesPayload?: unknown,
): Catalog {
  try {
    const body = object(payload);
    let regions: Catalog['regions'];
    let theaters: Catalog['theaters'];
    let movies: Catalog['movies'];
    if (provider === 'cgv') {
      const film = object(moviesPayload);
      for (const response of [body, film])
        if (response.statusCode !== 0 && response.statusCode !== 200)
          throw new Error('CGV 상태 오류');
      const groups = rows(body.data);
      regions = groups.map((r) => ({ id: id(r.regnGrpCd), name: label(r.regnGrpNm, 80) }));
      theaters = groups.flatMap((r) =>
        rows(r.siteList).map((t) => ({
          id: id(t.siteNo, 24),
          name: label(t.siteNm, 80),
          regionId: id(r.regnGrpCd),
        })),
      );
      movies = rows(film.data).map((m) => ({ id: id(m.movNo), title: label(m.movNm, 120) }));
    } else if (provider === 'megabox') {
      if (body.statCd !== 0 && body.statCd !== '0') throw new Error('MEGABOX 상태 오류');
      const branches = rows(body.areaBrchList);
      regions = branches.map((r) => ({ id: id(r.areaCd), name: label(r.areaCdNm, 80) }));
      theaters = branches.map((t) => ({
        id: id(t.brchNo, 24),
        name: label(t.brchNm, 80),
        regionId: id(t.areaCd),
      }));
      movies = [...rows(body.movieList), ...rows(body.crtnMovieList)].map((m) => ({
        id: id(m.movieNo),
        title: label(m.movieNm, 120),
      }));
    } else {
      const division = object(body.CinemaDivison);
      const cinemas = object(body.Cinemas);
      const films = object(body.Movies);
      for (const response of [body, division, cinemas, films])
        if (response.IsOK !== true && response.IsOK !== 'true')
          throw new Error('롯데시네마 상태 오류');
      const regionId = (r: Record<string, unknown>) =>
        `${id(r.DivisionCode)}-${id(r.DetailDivisionCode)}`;
      regions = rows(object(division.AreaDivisions).Items)
        .filter((r) => id(r.DivisionCode) === '1')
        .map((r) => ({ id: regionId(r), name: label(r.GroupNameKR, 80) }));
      theaters = rows(object(cinemas.Cinemas).Items)
        .filter((r) => id(r.DivisionCode) === '1')
        .map((t) => ({
          id: id(t.CinemaID, 24),
          name: label(t.CinemaNameKR, 80),
          regionId: regionId(t),
        }));
      movies = rows(object(films.Movies).Items).map((m) => ({
        id: id(m.RepresentationMovieCode),
        title: label(m.MovieNameKR, 120),
      }));
    }
    regions = unique(regions);
    theaters = unique(theaters);
    movies = unique(movies);
    const regionIds = new Set(regions.map((r) => r.id));
    if (
      theaters.some((t) => !regionIds.has(t.regionId)) ||
      theaters.length > 10000 ||
      movies.length > 10000
    )
      throw new Error('지역 참조 오류');
    return { provider, fetchedAt, regions, theaters, movies };
  } catch {
    throw new ProviderError(
      '공식 목록 응답을 확인할 수 없어요. 공급자 거절 또는 형식 변경일 수 있어요. 잠시 후 재시도하세요.',
    );
  }
}
interface Pending {
  provider: Provider;
  day: string;
  controller: AbortController;
  waiters: Map<string, { resolve(value: Catalog): void; reject(error: Error): void }>;
  timer?: ReturnType<typeof setTimeout>;
}
export class CatalogService {
  private cache = new Map<Provider, Catalog>();
  private pending = new Map<Provider, Pending>();
  private requests = new Map<string, Pending>();
  private lastStarted = new Map<Provider, number>();
  private retryUntil = new Map<Provider, number>();
  constructor(
    private fetcher: Fetcher = fetch,
    private cgvFetcher: Fetcher = fetcher,
    private now: () => number = Date.now,
  ) {}
  get(input: CatalogRequest): Promise<Catalog> {
    if (this.requests.has(input.requestId))
      return Promise.reject(new Error('이미 사용 중인 목록 요청입니다.'));
    if (this.requests.size >= 16)
      return Promise.reject(new Error('목록 요청이 많아요. 잠시 후 다시 시도하세요.'));
    let pending = this.pending.get(input.provider);
    const now = this.now();
    const cached = this.cache.get(input.provider);
    if (
      !pending &&
      !input.force &&
      cached &&
      now - cached.fetchedAt < TTL &&
      koreanToday(now) === koreanToday(cached.fetchedAt)
    )
      return Promise.resolve(structuredClone(cached));
    if (!pending) {
      const deadline = Math.max(
        this.retryUntil.get(input.provider) ?? 0,
        input.force ? (this.lastStarted.get(input.provider) ?? -Infinity) + MIN_REFRESH : 0,
      );
      if (deadline > now)
        return Promise.reject(
          new Error(
            `목록 조회가 제한되었어요. ${Math.ceil((deadline - now) / 1000)}초 후 재시도하세요.`,
          ),
        );
      pending = {
        provider: input.provider,
        day: koreanToday(now),
        controller: new AbortController(),
        waiters: new Map(),
      };
      this.pending.set(input.provider, pending);
      this.lastStarted.set(input.provider, now);
      const current = pending;
      current.timer = setTimeout(
        () =>
          this.finish(
            current,
            undefined,
            new Error('목록 조회 시간이 초과됐어요. 연결을 확인하고 재시도하세요.'),
          ),
        15000,
      );
      void Promise.resolve().then(() => this.load(current));
    }
    const current = pending;
    return new Promise<Catalog>((resolve, reject) => {
      current.waiters.set(input.requestId, { resolve, reject });
      this.requests.set(input.requestId, current);
    });
  }
  cancel(requestId: string) {
    const pending = this.requests.get(requestId);
    if (!pending) return;
    this.requests.delete(requestId);
    pending.waiters.get(requestId)?.reject(new Error('목록 조회가 취소되었습니다.'));
    pending.waiters.delete(requestId);
    if (!pending.waiters.size)
      this.finish(pending, undefined, new Error('목록 조회가 취소되었습니다.'));
  }
  dispose() {
    for (const pending of [...this.pending.values()])
      this.finish(pending, undefined, new Error('목록 조회가 취소되었습니다.'));
  }
  private finish(pending: Pending, value?: Catalog, error?: Error) {
    clearTimeout(pending.timer);
    const isCurrent = this.pending.get(pending.provider) === pending;
    if (isCurrent) this.pending.delete(pending.provider);
    if (value && isCurrent && !pending.controller.signal.aborted && pending.waiters.size)
      this.cache.set(pending.provider, value);
    if (error) pending.controller.abort();
    for (const [requestId, waiter] of pending.waiters) {
      if (this.requests.get(requestId) === pending) this.requests.delete(requestId);
      if (error) waiter.reject(error);
      else waiter.resolve(structuredClone(value!));
    }
    pending.waiters.clear();
  }
  private async request(
    pending: Pending,
    url: string,
    init: RequestInit = {},
    transport = this.fetcher,
  ): Promise<unknown> {
    const signal = pending.controller.signal;
    if (signal.aborted) throw new Error('취소');
    const response = await transport(url, {
      ...init,
      signal,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    });
    if (signal.aborted) throw new Error('취소');
    if (response.status === 429) {
      this.retryUntil.set(
        pending.provider,
        Math.max(
          this.retryUntil.get(pending.provider) ?? 0,
          this.now() +
            Math.max(MIN_REFRESH, retryAfter(response.headers.get('retry-after'), this.now())),
        ),
      );
      throw new ProviderError(
        `공급자가 목록 조회를 제한했어요. ${Math.ceil(((this.retryUntil.get(pending.provider) ?? 0) - this.now()) / 1000)}초 후 재시도하세요.`,
      );
    }
    if (!response.ok)
      throw new ProviderError(
        `목록 공급자 HTTP ${response.status} 오류예요. 잠시 후 재시도하세요.`,
      );
    if (Number(response.headers.get('content-length')) > MAX_BODY) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderError('공식 목록 응답이 너무 커요. 공급자 형식을 확인해야 해요.');
    }
    if (!response.body) throw new ProviderError('공식 목록 응답이 비어 있어요. 재시도하세요.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (signal.aborted) throw new Error('취소');
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY)
          throw new ProviderError('공식 목록 응답이 너무 커요. 공급자 형식을 확인해야 해요.');
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder().decode(joined)) as unknown;
    } catch {
      throw new ProviderError('공급자가 올바른 목록 JSON을 반환하지 않았어요. 재시도하세요.');
    }
  }
  private async load(pending: Pending) {
    try {
      let payload: unknown;
      let movies: unknown;
      if (pending.provider === 'cgv') {
        const init = {
          headers: {
            Accept: 'application/json',
            'Accept-Language': 'ko-KR',
            Referer: 'https://cgv.co.kr/cnm/movieBook/movie',
          },
        };
        payload = await this.request(
          pending,
          'https://cgv.co.kr/api/v1/booking/searchRegnList?coCd=A420',
          init,
          this.cgvFetcher,
        );
        movies = await this.request(
          pending,
          'https://cgv.co.kr/api/v1/booking/searchAtktTopPostrList?coCd=A420&movNm=&div=&attrCd=',
          init,
          this.cgvFetcher,
        );
      } else if (pending.provider === 'megabox') {
        payload = await this.request(
          pending,
          'https://www.megabox.co.kr/on/oh/ohb/SimpleBooking/selectBokdList.do',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
              Accept: 'application/json',
              'X-Requested-With': 'XMLHttpRequest',
            },
            body: new URLSearchParams({
              playDe: koreanToday(this.now()).replaceAll('-', ''),
              onLoad: 'Y',
              sellChnlCd: 'ONLINE',
            }).toString(),
          },
        );
      } else {
        const form = new FormData();
        form.set(
          'paramList',
          JSON.stringify({
            MethodName: 'GetTicketingPageTOBE',
            channelType: 'HO',
            osType: 'W',
            osVersion: 'CinemaBar/0.1',
            memberOnNo: '0',
          }),
        );
        payload = await this.request(
          pending,
          'https://www.lottecinema.co.kr/LCWS/Ticketing/TicketingData.aspx',
          { method: 'POST', headers: { Accept: 'application/json' }, body: form },
        );
      }
      if (
        pending.controller.signal.aborted ||
        !pending.waiters.size ||
        this.pending.get(pending.provider) !== pending
      )
        return;
      if (pending.day !== koreanToday(this.now()))
        throw new ProviderError('한국 날짜가 바뀌었어요. 목록을 다시 불러오세요.');
      this.finish(pending, parseCatalog(pending.provider, payload, this.now(), movies));
    } catch (error) {
      this.finish(
        pending,
        undefined,
        error instanceof ProviderError
          ? error
          : new Error('목록 네트워크 연결을 확인하고 재시도하세요.'),
      );
    }
  }
}
