import { afterEach, describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/catalogPublic.json';
import { CatalogService, parseCatalog } from '../electron/catalog';
import { validateIpc } from '../electron/ipc';
import type { Fetcher } from '../electron/providers';
import type { Provider } from '../electron/types';
const NOW = Date.parse('2026-10-20T12:00:00Z');
const services: CatalogService[] = [];
function service(fetcher: Fetcher, cgvFetcher = fetcher, now = () => NOW) {
  const result = new CatalogService(fetcher, cgvFetcher, now);
  services.push(result);
  return result;
}
const json = () => Response.json(fixture.megabox);
const request = (requestId: string, force?: boolean) => ({
  provider: 'megabox' as const,
  requestId,
  ...(force === undefined ? {} : { force }),
});
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  services.forEach((s) => s.dispose());
  services.length = 0;
  vi.useRealTimers();
});
describe('official public catalog normalization', () => {
  it('preserves CGV leading zeros, titles, region membership and exact movie IDs', () => {
    const result = parseCatalog('cgv', fixture.cgvRegions, NOW, fixture.cgvMovies);
    expect(result.regions).toHaveLength(2);
    expect(result.theaters).toHaveLength(4);
    expect(result.theaters[0]).toEqual({ id: '0056', name: '강남', regionId: '01' });
    expect(result.movies[0]).toEqual({
      id: '30001367',
      title: '극장판 치이카와-인어 섬의 비밀',
      posterUrl:
        'https://cdn.cgv.co.kr/cgvpomsfilm/Movie/Thumbnail/Poster/030001/30001367/30001367_320.jpg',
    });
    expect(Object.keys(result).sort()).toEqual([
      'fetchedAt',
      'movies',
      'provider',
      'regions',
      'theaters',
    ]);
  });
  it('deduplicates Mega curation while retaining unavailable theaters and decoding labels', () => {
    const result = parseCatalog('megabox', fixture.megabox, NOW);
    expect(result.regions).toHaveLength(2);
    expect(result.theaters).toHaveLength(3);
    expect(result.theaters[1].name).toBe('픽쳐하우스(휴관)');
    expect(result.movies).toHaveLength(3);
    expect(result.movies.some((m) => m.title.includes('치이카와'))).toBe(true);
  });
  it('joins Lotte normal regional divisions and excludes special rows', () => {
    const result = parseCatalog('lottecinema', fixture.lottecinema, NOW);
    expect(result.regions.map((r) => r.id)).toEqual(['1-0001', '1-0002']);
    expect(result.theaters).toHaveLength(4);
    expect(new Set(result.theaters.map((t) => t.id)).size).toBe(4);
    expect(result.movies).toHaveLength(2);
    for (const IsOK of [false, 'false', undefined]) {
      expect(() => parseCatalog('lottecinema', { ...fixture.lottecinema, IsOK }, NOW)).toThrow(
        /형식 변경/,
      );
      expect(() =>
        parseCatalog(
          'lottecinema',
          { ...fixture.lottecinema, Movies: { ...fixture.lottecinema.Movies, IsOK } },
          NOW,
        ),
      ).toThrow();
    }
    expect(
      parseCatalog('lottecinema', { ...fixture.lottecinema, IsOK: true }, NOW).movies,
    ).toHaveLength(2);
  });
  it('accepts an explicit empty list but rejects missing arrays, failed status, bad fields and conflicting IDs', () => {
    expect(
      parseCatalog(
        'megabox',
        { statCd: 0, areaBrchList: [], movieList: [], crtnMovieList: [] },
        NOW,
      ).movies,
    ).toEqual([]);
    const branch = fixture.megabox.areaBrchList[0];
    for (const patch of [
      { statCd: 2 },
      { movieList: undefined },
      { areaBrchList: [{ ...branch, brchNo: '' }] },
      { areaBrchList: [{ ...branch, brchNm: 'bad\u0001' }] },
      { areaBrchList: [{ ...branch, brchNo: NaN }] },
      { areaBrchList: [branch, { ...branch, brchNm: 'different' }] },
      { movieList: Array.from({ length: 10001 }, () => fixture.megabox.movieList[0]) },
    ])
      expect(() => parseCatalog('megabox', { ...fixture.megabox, ...patch }, NOW)).toThrow(
        /형식 변경/,
      );
    const broken = structuredClone(fixture.lottecinema);
    broken.Cinemas.Cinemas.Items[0].DetailDivisionCode = '9999';
    expect(() => parseCatalog('lottecinema', broken, NOW)).toThrow();
    expect(() =>
      parseCatalog('cgv', { ...fixture.cgvRegions, statusCode: 403 }, NOW, fixture.cgvMovies),
    ).toThrow();
  });
});
describe('bounded catalog transport and lifecycle', () => {
  it('uses only pinned official endpoints and the dedicated CGV transport', async () => {
    const ordinary = vi.fn<Fetcher>(async () => json());
    const cgv = vi.fn<Fetcher>(async (url) =>
      Response.json(url.includes('searchRegnList') ? fixture.cgvRegions : fixture.cgvMovies),
    );
    const s = service(ordinary, cgv);
    await s.get({ provider: 'cgv', requestId: 'a' });
    expect(ordinary).not.toHaveBeenCalled();
    expect(cgv.mock.calls.map(([url]) => url)).toEqual([
      'https://cgv.co.kr/api/v1/booking/searchRegnList?coCd=A420',
      'https://cgv.co.kr/api/v1/booking/searchAtktTopPostrList?coCd=A420&movNm=&div=&attrCd=',
    ]);
    await s.get(request('b'));
    const init = ordinary.mock.calls[0][1]!;
    expect(String(init.body)).toBe('playDe=20261020&onLoad=Y&sellChnlCd=ONLINE');
    expect(init).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store' });
  });
  it('shares requests, cancels one waiter independently and returns defensive cache copies', async () => {
    const fetch = deferred();
    const fetcher = vi.fn<Fetcher>(() => fetch.promise);
    const s = service(fetcher);
    const a = s.get(request('a'));
    const cancelled = expect(a).rejects.toThrow(/취소/);
    const b = s.get(request('b'));
    s.cancel('a');
    await cancelled;
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]!.signal!.aborted).toBe(false);
    fetch.resolve(json());
    const result = await b;
    result.movies.length = 0;
    expect((await s.get(request('c'))).movies).toHaveLength(3);
    s.cancel('b');
    s.cancel('unknown');
  });
  it('aborts the last waiter, does not cache a late response and cannot delete a new request', async () => {
    const old = deferred();
    const fresh = deferred();
    const fetcher = vi
      .fn<Fetcher>()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(fresh.promise);
    const s = service(fetcher);
    const p = s.get(request('a'));
    const rejected = expect(p).rejects.toThrow(/취소/);
    await Promise.resolve();
    s.cancel('a');
    await rejected;
    expect(fetcher.mock.calls[0][1]!.signal!.aborted).toBe(true);
    const next = s.get(request('new'));
    old.resolve(json());
    await Promise.resolve();
    await Promise.resolve();
    fresh.resolve(json());
    expect((await next).movies).toHaveLength(3);
    expect((await s.get(request('cached'))).theaters).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('expires at 15 minutes and KST midnight, and force bypasses TTL with a ten-second floor', async () => {
    let now = NOW;
    const fetcher = vi.fn<Fetcher>(async () => json());
    const s = service(fetcher, fetcher, () => now);
    await s.get(request('a'));
    await expect(s.get(request('early', true))).rejects.toThrow(/10초/);
    now += 10000;
    await s.get(request('force', true));
    expect(fetcher).toHaveBeenCalledTimes(2);
    now += 15 * 60000 - 1;
    await s.get(request('still-valid'));
    expect(fetcher).toHaveBeenCalledTimes(2);
    now++;
    await s.get(request('expired'));
    expect(fetcher).toHaveBeenCalledTimes(3);
    now = Date.parse('2026-10-20T14:59:59Z');
    await s.get(request('before-midnight', true));
    now += 1000;
    await s.get(request('midnight'));
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
  it('does not cache an old-day response that completes after KST midnight', async () => {
    let now = Date.parse('2026-10-20T14:59:59Z');
    const old = deferred();
    const fetcher = vi
      .fn<Fetcher>()
      .mockReturnValueOnce(old.promise)
      .mockImplementation(async () => json());
    const s = service(fetcher, fetcher, () => now);
    const pending = s.get(request('before'));
    const rejection = expect(pending).rejects.toThrow(/날짜가 바뀌/);
    await Promise.resolve();
    now += 1000;
    old.resolve(json());
    await rejection;
    expect((await s.get(request('today'))).movies).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(['30', new Date(NOW + 30000).toUTCString(), 'invalid', null])(
    'honors 429 Retry-After %s without poisoning successful cache',
    async (value) => {
      let now = NOW;
      const fetcher = vi
        .fn<Fetcher>()
        .mockResolvedValueOnce(json())
        .mockResolvedValueOnce(
          new Response('{}', { status: 429, headers: value ? { 'Retry-After': value } : {} }),
        )
        .mockImplementation(async () => json());
      const s = service(fetcher, fetcher, () => now);
      await s.get(request('a'));
      now += 10000;
      await expect(s.get(request('limited', true))).rejects.toThrow(/제한/);
      s.cancel('limited');
      expect((await s.get(request('cache'))).movies).toHaveLength(3);
      await expect(s.get(request('blocked', true))).rejects.toThrow(/초 후/);
      expect(fetcher).toHaveBeenCalledTimes(2);
      now += 40000;
      await s.get(request('allowed', true));
      expect(fetcher).toHaveBeenCalledTimes(3);
    },
  );
  it('keeps an observed 429 deadline when the waiter cancels before catch cleanup', async () => {
    let now = NOW;
    const s = service(
      async () => new Response('{}', { status: 429, headers: { 'Retry-After': '40' } }),
      undefined,
      () => now,
    );
    const p = s.get(request('a'));
    const rejection = expect(p).rejects.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    s.cancel('a');
    await rejection;
    now += 10000;
    await expect(s.get(request('b', true))).rejects.toThrow(/30초/);
  });
  it('times out an uncooperative transport and bounds active request IDs', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<Fetcher>(() => new Promise(() => undefined));
    const s = service(fetcher);
    const waits = Array.from({ length: 16 }, (_, i) =>
      s.get(request(`r${i}`)).catch((e: Error) => e.message),
    );
    await expect(s.get(request('overflow'))).rejects.toThrow(/많아요/);
    await expect(s.get(request('r0'))).rejects.toThrow(/사용 중/);
    await vi.advanceTimersByTimeAsync(15000);
    expect(
      (await Promise.all(waits)).every(
        (message) => typeof message === 'string' && message.includes('시간이 초과'),
      ),
    ).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]!.signal!.aborted).toBe(true);
  });
  it.each([
    ['HTTP', () => new Response('{}', { status: 503 })],
    ['JSON', () => new Response('not-json')],
    [
      'header cap',
      () => new Response('{}', { headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) } }),
    ],
    ['stream cap', () => new Response(' '.repeat(2 * 1024 * 1024 + 1))],
    ['schema', () => Response.json({ statCd: 0 })],
  ])('does not turn %s failure into an empty success or cache it', async (_name, response) => {
    const fetcher = vi
      .fn<Fetcher>()
      .mockImplementationOnce(async () => response())
      .mockImplementation(async () => json());
    const s = service(fetcher);
    await expect(s.get(request('bad'))).rejects.toThrow();
    expect((await s.get(request('retry'))).movies).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('limits simultaneous transfers to the three providers and disposes all waiters', async () => {
    const fetcher = vi.fn<Fetcher>(() => new Promise(() => undefined));
    const s = service(fetcher);
    const waits = (['cgv', 'megabox', 'lottecinema'] as Provider[]).map((provider) =>
      s.get({ provider, requestId: provider }).catch((e: Error) => e.message),
    );
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(3);
    s.dispose();
    expect(
      (await Promise.all(waits)).every((m) => typeof m === 'string' && m.includes('취소')),
    ).toBe(true);
  });
});
describe('narrow catalog IPC input', () => {
  it.each([
    { provider: 'unknown', requestId: 'a' },
    { ...request('a'), url: 'https://example.com' },
    { ...request('a'), force: 'true' },
    { ...request('a'), requestId: '' },
    { ...request('a'), requestId: 'a\n' },
    { ...request('a'), requestId: 'a'.repeat(81) },
    { ...request('a'), requestId: ' a' },
  ])('rejects malformed input %#', (input) => {
    expect(() => validateIpc('getCatalog', input)).toThrow();
  });
  it('admits only the exact request and cancellation keys', () => {
    expect(validateIpc('getCatalog', request('a', true))).toEqual(request('a', true));
    expect(validateIpc('cancelCatalog', { requestId: 'a' })).toEqual({ requestId: 'a' });
    expect(() => validateIpc('cancelCatalog', { requestId: 'a', provider: 'cgv' })).toThrow();
  });
});

describe('optional official poster metadata', () => {
  it('normalizes observed three-provider fields without making optional images a catalog requirement', () => {
    expect(parseCatalog('megabox', fixture.megabox, NOW).movies[0].posterUrl).toBe(
      'https://img.megabox.co.kr/SharedImg/2026/10/14/ftMynesIgnNFPtPj59KlhsG6ifaruRgW_150.png',
    );
    expect(parseCatalog('lottecinema', fixture.lottecinema, NOW).movies[0].posterUrl).toBe(
      'https://cf.lottecinema.co.kr/Media/MovieFile/MovieImg/202607/24128_503_1.jpg',
    );
    expect(
      parseCatalog('megabox', fixture.megabox, NOW).movies.find((movie) => movie.id === '26062100')
        ?.posterUrl,
    ).toContain('_150.jpg');
    const malformed = structuredClone(fixture.cgvMovies);
    malformed.data[0].i320Fnm = 'https://evil.test/a.jpg';
    expect(
      parseCatalog('cgv', fixture.cgvRegions, NOW, malformed).movies[0].posterUrl,
    ).toBeUndefined();
    const conflict = structuredClone(fixture.megabox);
    conflict.crtnMovieList[0].movieNm = 'different';
    expect(() => parseCatalog('megabox', conflict, NOW)).toThrow();
    const reverse = structuredClone(fixture.megabox);
    reverse.movieList = [...reverse.movieList].reverse();
    expect(
      parseCatalog('megabox', reverse, NOW).movies.find((movie) => movie.id === '26062100')
        ?.posterUrl,
    ).toContain('_150.jpg');
  });
});
