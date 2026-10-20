import { afterEach, describe, expect, it, vi } from 'vitest';
import publicFixture from './fixtures/cgvPublic.json';
import {
  createProviders,
  normalizeFormat,
  parseCgv,
  ProviderError,
} from '../electron/providers/index';
import { bookingUrl, matches, sessionIdentity, validateRule } from '../electron/validation';
import { isRuleEligible } from '../electron/eligibility';
import { rule } from './fixtures';
const NOW = Date.parse('2026-10-20T10:04:52Z');
const row = publicFixture.data[0];
const parse = (patch: Record<string, unknown> = {}, now = NOW) =>
  parseCgv({ statusCode: 0, data: [{ ...row, ...patch }] }, now)[0];
afterEach(() => vi.restoreAllMocks());
describe('current public CGV contract', () => {
  it('parses the 41 actual anonymous rows with screen-specific identity and exact metadata', () => {
    const sessions = parseCgv(publicFixture, NOW);
    expect(sessions).toHaveLength(41);
    expect(new Set(sessions.map(sessionIdentity)).size).toBe(41);
    expect(sessions[0]).toMatchObject({
      theaterId: row.siteNo,
      theaterName: row.siteNm,
      movieId: row.movNo,
      movieTitle: row.movNm,
      screen: row.scnsNm,
      date: '2026-10-20',
      time: '24:00',
    });
    expect(parse({ scnsNo: '002' }).showingId).not.toBe(parse().showingId);
    expect(new Set(sessions.map((s) => s.format))).toEqual(
      new Set(['2D', '4DX', 'SCREENX', 'IMAX']),
    );
  });
  it('strictly rejects missing identity/date/time and failure status; only explicit empty arrays are empty success', () => {
    expect(parseCgv({ statusCode: 200, data: [] })).toEqual([]);
    for (const payload of [
      { statusCode: 1, data: [] },
      { statusCode: 0 },
      { statusCode: 0, data: {} },
      { statusCode: 0, data: [{}] },
    ])
      expect(() => parseCgv(payload)).toThrow(ProviderError);
    for (const key of [
      'siteNo',
      'siteNm',
      'scnsNo',
      'scnSseq',
      'movNo',
      'movNm',
      'scnYmd',
      'scnsrtTm',
      'scnsNm',
    ])
      expect(() => parse({ [key]: '' })).toThrow(ProviderError);
    expect(() => parse({ scnsrtTm: '3000' })).toThrow(ProviderError);
    expect(() => parse({ scnYmd: '20260230' })).toThrow(ProviderError);
  });
  it('requires exact zero seconds in six-digit times without losing minute precision', () => {
    for (const value of [
      '240099',
      '240001',
      '235959',
      '295901',
      '246000',
      '300000',
      '24a000',
      '24000',
      '2400000',
    ])
      expect(() => parse({ scnsrtTm: value })).toThrow(ProviderError);
    for (const [value, expected] of [
      ['000000', '00:00'],
      ['235900', '23:59'],
      ['240000', '24:00'],
      ['295900', '29:59'],
      ['2400', '24:00'],
      ['24:00', '24:00'],
      ['2959', '29:59'],
      ['29:59', '29:59'],
    ])
      expect(parse({ scnsrtTm: value })).toMatchObject({ date: '2026-10-20', time: expected });
  });
  it.each([
    ':2400',
    '2:400',
    '240:0',
    '2400:',
    '24::00',
    '24:0000',
    '24:00:00',
    '240000:',
    '2400junk',
    '24000000',
    '240',
    '24:',
    '24:60',
    '30:00',
    '24.00',
    ' 2400',
    '2400 ',
  ])('rejects unsupported complete time syntax %j before normalization', (value) => {
    expect(() => parse({ scnsrtTm: value })).toThrow(ProviderError);
  });
  it.each([
    '2026-10-20garbage',
    '2026-10-20T00:00:00',
    '20261020x',
    '2026-10-2',
    '2026-1-20',
    '2026/10/20',
    '2026-02-30',
    '20260229',
    '20261301',
    '2026-00-01',
    '20260001',
    '2026-10-00',
    '2026-10-32',
    '2026102',
    '202610200',
    ' 20261020',
    '20261020 ',
  ])('rejects unsupported or impossible complete date %j', (value) => {
    expect(() => parse({ scnYmd: value })).toThrow(ProviderError);
  });
  it.each([
    ['20261020', '2026-10-20'],
    ['2026-10-20', '2026-10-20'],
    ['20240229', '2024-02-29'],
    ['2024-02-29', '2024-02-29'],
    ['20260228', '2026-02-28'],
    ['2026-02-28', '2026-02-28'],
    ['20000229', '2000-02-29'],
    ['2000-02-29', '2000-02-29'],
  ])('preserves the entire supported date %s as %s', (value, expected) => {
    expect(parse({ scnYmd: value }).date).toBe(expected);
  });
  it('uses controlled N, real positive seats and future KST start; preserves late business date', () => {
    expect(parse().isBookable).toBe(true);
    for (const patch of [
      { cntlYn: 'Y' },
      { cntlYn: '' },
      { cntlYn: undefined },
      { frSeatCnt: '0', frtmpSeatCnt: '100' },
      { frSeatCnt: 'unknown' },
      { frSeatCnt: null },
      { scnsrtTm: '1800' },
    ])
      expect(parse(patch).isBookable).toBe(false);
    const midnight = Date.parse('2026-10-20T15:00:00Z');
    expect(parse({ scnsrtTm: '2400' }, midnight - 1).isBookable).toBe(true);
    expect(parse({ scnsrtTm: '2400' }, midnight).isBookable).toBe(false);
    expect(parse({ scnsrtTm: '2959' }, Date.parse('2026-10-20T20:58:59Z'))).toMatchObject({
      date: '2026-10-20',
      time: '29:59',
      isBookable: true,
    });
    expect(parse({ scnsrtTm: '2959' }, Date.parse('2026-10-20T20:59:00Z')).isBookable).toBe(false);
  });
  it.each([
    ['IMAX LASER 2D', 'IMAX'],
    ['아이맥스', 'IMAX'],
    ['ULTRA 4DX 2D', '4DX'],
    ['SCREENX DOLBY ATMOS mix 2D', 'SCREENX'],
    ['DOLBY 3D', 'DOLBY'],
    ['3D', '3D'],
    ['2D', '2D'],
    ['special', 'UNKNOWN'],
  ])('format %s normalizes to %s with declared precedence', (input, output) => {
    expect(normalizeFormat(input)).toBe(output);
    expect(
      matches(
        {
          ...rule,
          provider: 'cgv',
          theaterId: row.siteNo,
          movieTitle: row.movNm,
          date: '2026-10-20',
          format: 'IMAX',
        },
        parse({ movkndDsplNm: 'special' }),
        false,
      ),
    ).toBe(false);
  });
  it('retains only previous CGV business date before 06:00 and refuses new past-date rules', () => {
    const saved = { ...rule, provider: 'cgv' as const, date: '2026-10-20' };
    expect(isRuleEligible(saved, Date.parse('2026-10-20T14:59:59Z'))).toBe(true);
    expect(isRuleEligible(saved, Date.parse('2026-10-20T15:00:00Z'))).toBe(true);
    expect(isRuleEligible(saved, Date.parse('2026-10-20T20:59:59Z'))).toBe(true);
    expect(isRuleEligible(saved, Date.parse('2026-10-20T21:00:00Z'))).toBe(false);
    for (const provider of ['megabox', 'lottecinema'] as const)
      expect(isRuleEligible({ ...saved, provider }, Date.parse('2026-10-20T15:00:00Z'))).toBe(
        false,
      );
    const { revision: _revision, ...input } = saved;
    void _revision;
    expect(() => validateRule({ ...input, date: '2000-01-01' })).toThrow('오늘 이후');
  });
  it('injects only CGV transport with public headers, no credentials, fresh reads and a 15 second abort deadline', async () => {
    const node = vi.fn(async () => Response.json({ statCd: 0, movieFormList: [] }));
    const chromium = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(false);
      return Response.json(publicFixture);
    });
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const adapters = createProviders(node, chromium, () => NOW);
    await adapters.cgv(rule, new AbortController().signal);
    await adapters.megabox(rule, new AbortController().signal);
    expect(node).toHaveBeenCalledTimes(1);
    expect(chromium).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(15000);
    const [url, init] = chromium.mock.calls[0];
    expect(url).toContain('https://cgv.co.kr/api/v1/booking/searchMovScnInfo?coCd=A420');
    expect(init).toMatchObject({
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'ko-KR',
        Referer: 'https://cgv.co.kr/cnm/movieBook/movie',
      },
    });
    expect(new Headers(init?.headers).has('Cookie')).toBe(false);
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const cancelled = createProviders(node, async (_url, options) => {
      requestSignal = options?.signal as AbortSignal;
      return new Promise((_resolve, reject) =>
        requestSignal!.addEventListener('abort', () => reject(new Error('cancelled'))),
      );
    });
    const request = cancelled.cgv(rule, controller.signal);
    controller.abort();
    await expect(request).rejects.toThrow('취소');
    expect(requestSignal?.aborted).toBe(true);
  });
  it('reports 403/429/JSON errors and permits only current official booking URLs', async () => {
    const signal = new AbortController().signal;
    await expect(
      createProviders(fetch, async () => new Response('', { status: 403 })).cgv(rule, signal),
    ).rejects.toThrow('HTTP 403');
    await expect(
      createProviders(
        fetch,
        async () => new Response('', { status: 429, headers: { 'Retry-After': '40' } }),
      ).cgv(rule, signal),
    ).rejects.toMatchObject({ retryAfterMs: 40000 });
    await expect(
      createProviders(fetch, async () => new Response('not JSON')).cgv(rule, signal),
    ).rejects.toThrow('JSON');
    expect(bookingUrl('cgv', 'https://cgv.co.kr/cnm/movieBook/movie')).toBe(
      'https://cgv.co.kr/cnm/movieBook/movie',
    );
    for (const value of [
      'https://cgv.co.kr/cnm/movieBook/movie/evil',
      'https://user@cgv.co.kr/cnm/movieBook/movie',
      'https://cgv.co.kr:123/cnm/movieBook/movie',
      'https://cgv.co.kr/cnm/movieBook/movie?redirect=x',
      'https://evil.test/cnm/movieBook/movie',
    ])
      expect(bookingUrl('cgv', value)).toBe('');
  });
});
