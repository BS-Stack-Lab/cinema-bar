import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PosterService,
  catalogPosterUrl,
  validatePosterUrl,
  type ImageInspector,
} from '../electron/posters';
import { validateIpc } from '../electron/ipc';
import type { Catalog, PosterRequest } from '../electron/types';
import type { Fetcher } from '../electron/providers/index';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=',
  'base64',
);
const services: PosterService[] = [];
const request = (id = '1', requestId = `request-${id}`): PosterRequest => ({
  provider: 'cgv',
  movieId: id,
  movieTitle: `Movie ${id}`,
  requestId,
});
const url = (id: string) => catalogPosterUrl('cgv', id, `${id}_320.jpg`)!;
function fixture(
  fetcher: Fetcher = async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }),
  inspect: ImageInspector = () => ({ width: 1, height: 1 }),
) {
  let now = 0;
  const catalog: Catalog = {
    provider: 'cgv',
    fetchedAt: 0,
    regions: [],
    theaters: [],
    movies: Array.from({ length: 110 }, (_, i) => ({
      id: String(i + 1),
      title: `Movie ${i + 1}`,
      posterUrl: url(String(i + 1)),
    })),
  };
  const get = vi.fn(async () => structuredClone(catalog));
  const cancel = vi.fn();
  const transport = vi.fn<Fetcher>(fetcher);
  const service = new PosterService({ get, cancel }, inspect, transport, () => now);
  services.push(service);
  return {
    service,
    get,
    cancel,
    catalog,
    transport,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
afterEach(() => {
  services.splice(0).forEach((service) => service.dispose());
  vi.useRealTimers();
});
describe('official poster references and narrow IPC', () => {
  it('accepts only observed templates and canonicalizes the exact Lotte HTTP host', () => {
    expect(url('30001367')).toBe(
      'https://cdn.cgv.co.kr/cgvpomsfilm/Movie/Thumbnail/Poster/030001/30001367/30001367_320.jpg',
    );
    expect(
      catalogPosterUrl(
        'megabox',
        '26058900',
        '/SharedImg/2026/10/14/ftMynesIgnNFPtPj59KlhsG6ifaruRgW_150.png',
      ),
    ).toBe(
      'https://img.megabox.co.kr/SharedImg/2026/10/14/ftMynesIgnNFPtPj59KlhsG6ifaruRgW_150.png',
    );
    expect(
      catalogPosterUrl(
        'lottecinema',
        '24128',
        'http://cf.lottecinema.co.kr//Media/MovieFile/MovieImg/202607/24128_503_1.jpg',
      ),
    ).toBe('https://cf.lottecinema.co.kr/Media/MovieFile/MovieImg/202607/24128_503_1.jpg');
    for (const value of [undefined, {}, '', '1_420.jpg', '2_320.jpg', '../1_320.jpg'])
      expect(catalogPosterUrl('cgv', '1', value)).toBeUndefined();
    for (const value of [
      url('1').replace('https:', 'http:'),
      url('1').replace('cdn.cgv.co.kr', 'evil.test'),
      url('1').replace('https://', 'https://user@'),
      url('1').replace('cdn.cgv.co.kr', 'cdn.cgv.co.kr:444'),
      url('1') + '?x=1',
      url('1') + '#x',
      url('1').replace('000000', '123456'),
      url('1').replace('/1/', '/2/'),
      url('1').replace('/1/', '/../1/'),
      url('1').replace('/1/', '/%31/'),
    ])
      expect(validatePosterUrl('cgv', value)).toBeUndefined();
    expect(catalogPosterUrl('megabox', '1', '/SharedImg/2026/10/14/x_420.png')).toBeUndefined();
    expect(
      validatePosterUrl(
        'lottecinema',
        'http://example.com/Media/MovieFile/MovieImg/202607/1_503_1.jpg',
      ),
    ).toBeUndefined();
  });
  it('rejects arbitrary capabilities, malformed identities, wrong providers and duplicate request IDs', async () => {
    for (const value of [
      { ...request(), url: url('1') },
      { ...request(), path: '/tmp/a' },
      { ...request(), provider: 'unknown' },
      { ...request(), movieId: '../1' },
      { ...request(), movieId: '' },
      { ...request(), requestId: 'x/y' },
      { ...request(), movieTitle: '' },
    ])
      expect(() => validateIpc('getPoster', value)).toThrow();
    expect(validateIpc('getPoster', request())).toEqual(request());
    expect(() => validateIpc('cancelPoster', { requestId: 'one', url: url('1') })).toThrow();
    const f = fixture(async () => new Promise(() => undefined));
    const pending = f.service.get(request()).catch(() => ({}));
    await expect(f.service.get(request())).rejects.toThrow();
    f.service.cancel('request-1');
    await pending;
  });
});
describe('bounded poster service', () => {
  it('shares duplicate and legacy identity downloads, returns a raster data URL, and caches only resolved identities', async () => {
    const f = fixture();
    const result = await Promise.all(
      Array.from({ length: 40 }, (_, i) => f.service.get(request('1', `duplicate-${i}`))),
    );
    expect(new Set(result.map((item) => item.dataUrl)).size).toBe(1);
    expect(result[0].dataUrl).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(f.transport).toHaveBeenCalledWith(
      url('1'),
      expect.objectContaining({
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      }),
    );
    await f.service.get({ provider: 'cgv', movieTitle: '  MOVIE   1 ', requestId: 'legacy' });
    expect(f.transport).toHaveBeenCalledTimes(1);
    await f.service.get(request('not-in-catalog'));
    f.catalog.movies.push({ ...f.catalog.movies[0], id: 'other' });
    expect(
      await f.service.get({ provider: 'cgv', movieTitle: 'Movie 1', requestId: 'ambiguous' }),
    ).toEqual({});
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed poster metadata and never fetches URLs outside the catalog identity', async () => {
    const f = fixture();
    f.catalog.movies[0].posterUrl = 'https://evil.test/image.png';
    expect(await f.service.get(request())).toEqual({});
    expect(f.transport).not.toHaveBeenCalled();
    delete f.catalog.movies[0].posterUrl;
    expect(await f.service.get(request('1', 'missing'))).toEqual({});
    f.catalog.provider = 'megabox';
    expect(await f.service.get(request('2'))).toEqual({});
  });
  it('cancels one waiter independently; final cancellation aborts and ignores the late response', async () => {
    let release!: (response: Response) => void;
    const f = fixture(
      async () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = f.service.get(request('1', 'first')).catch(() => ({ cancelled: true }));
    const second = f.service.get(request('1', 'second'));
    await vi.waitFor(() => expect(f.transport).toHaveBeenCalledTimes(1));
    f.service.cancel('first');
    expect(await first).toEqual({ cancelled: true });
    const signal = f.transport.mock.calls[0][1]!.signal!;
    expect(signal.aborted).toBe(false);
    release(new Response(PNG, { headers: { 'content-type': 'image/png' } }));
    expect((await second).dataUrl).toBeTruthy();
    const late = f.service.get(request('2', 'late')).catch(() => ({ cancelled: true }));
    await vi.waitFor(() => expect(f.transport).toHaveBeenCalledTimes(2));
    const lateSignal = f.transport.mock.calls[1][1]!.signal!;
    f.service.cancel('late');
    expect(lateSignal.aborted).toBe(true);
    await late;
    release(new Response(PNG, { headers: { 'content-type': 'image/png' } }));
    await Promise.resolve();
    f.transport.mockResolvedValueOnce(
      new Response(PNG, { headers: { 'content-type': 'image/png' } }),
    );
    await f.service.get(request('2', 'after-late'));
    expect(f.transport).toHaveBeenCalledTimes(3);
  });
  it('bounds pending requests at 100 and downloads at 3, drains queued work on completion', async () => {
    const releases: Array<() => void> = [];
    const f = fixture(
      async () =>
        new Promise((resolve) => {
          releases.push(() =>
            resolve(new Response(PNG, { headers: { 'content-type': 'image/png' } })),
          );
        }),
    );
    const pending = Array.from({ length: 100 }, (_, i) =>
      f.service.get(request(String(i + 1))).catch(() => ({})),
    );
    await vi.waitFor(() => expect(f.transport).toHaveBeenCalledTimes(3));
    await expect(f.service.get(request('101'))).rejects.toThrow();
    releases[0]();
    await pending[0];
    await vi.waitFor(() => expect(f.transport).toHaveBeenCalledTimes(4));
    f.service.dispose();
    await Promise.all(pending);
    expect(f.transport).toHaveBeenCalledTimes(4);
    for (const [, init] of f.transport.mock.calls) expect(init!.signal!.aborted).toBe(true);
    await expect(f.service.get(request('1', 'after-dispose'))).rejects.toThrow();
  });
  it('cancels an unresolved shared catalog lookup only after its final waiter', async () => {
    const f = fixture();
    f.get.mockImplementationOnce(() => new Promise(() => undefined));
    const one = f.service.get(request('1', 'one')).catch(() => ({}));
    const two = f.service.get(request('2', 'two')).catch(() => ({}));
    f.service.cancel('one');
    expect(f.cancel).not.toHaveBeenCalled();
    f.service.cancel('two');
    expect(f.cancel).toHaveBeenCalledTimes(1);
    await Promise.all([one, two]);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it('expires successes after 15 minutes and failures after 30 seconds', async () => {
    const f = fixture();
    await f.service.get(request());
    f.advance(899999);
    await f.service.get(request('1', 'cached'));
    expect(f.transport).toHaveBeenCalledTimes(1);
    f.advance(1);
    await f.service.get(request('1', 'expired'));
    expect(f.transport).toHaveBeenCalledTimes(2);
    f.transport.mockResolvedValueOnce(new Response('bad', { status: 404 }));
    await f.service.get(request('2'));
    await f.service.get(request('2', 'negative'));
    expect(f.transport).toHaveBeenCalledTimes(3);
    f.advance(30000);
    await f.service.get(request('2', 'retry'));
    expect(f.transport).toHaveBeenCalledTimes(4);
  });
  it('evicts least recently used images at 32 entries and 16 MiB', async () => {
    const f = fixture();
    for (let i = 1; i <= 32; i++) await f.service.get(request(String(i)));
    await f.service.get(request('1', 'touch'));
    await f.service.get(request('33'));
    await f.service.get(request('1', 'retained'));
    expect(f.transport).toHaveBeenCalledTimes(33);
    await f.service.get(request('2', 'evicted'));
    expect(f.transport).toHaveBeenCalledTimes(34);
    const large = Buffer.alloc(1024 * 1024);
    PNG.copy(large);
    const bytes = fixture(
      async () => new Response(large, { headers: { 'content-type': 'image/png' } }),
    );
    for (let i = 1; i <= 17; i++) await bytes.service.get(request(String(i)));
    await bytes.service.get(request('1', 'byte-evicted'));
    expect(bytes.transport).toHaveBeenCalledTimes(18);
  });
  it.each([
    ['html', 'text/html', Buffer.from('<html>')],
    ['svg', 'image/svg+xml', Buffer.from('<svg/>')],
    ['mismatch', 'image/jpeg', PNG],
    ['invalid-png', 'image/png', Buffer.from('not png')],
    ['empty', 'image/png', Buffer.alloc(0)],
  ])('rejects %s content before decoding', async (_name, mime, bytes) => {
    const inspect = vi.fn(() => ({ width: 1, height: 1 }));
    const f = fixture(
      async () => new Response(bytes, { headers: { 'content-type': mime } }),
      inspect,
    );
    expect(await f.service.get(request())).toEqual({});
    expect(inspect).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    { width: 0, height: 1 },
    { width: 4097, height: 1 },
    { width: 1, height: 4097 },
    { width: 4096, height: 4096 },
    { width: 1.5, height: 2 },
  ])('rejects decoded raster dimensions %j', async (dimensions) => {
    const f = fixture(undefined, () => dimensions);
    expect(await f.service.get(request())).toEqual({});
  });
  it('accepts JPEG/WebP signatures only with matching MIME and supported decode', async () => {
    for (const [mime, bytes] of [
      ['image/jpeg', Buffer.from([255, 216, 255, 224])],
      ['image/webp', Buffer.from('RIFF0000WEBPdata')],
    ] as const) {
      const f = fixture(async () => new Response(bytes, { headers: { 'content-type': mime } }));
      expect((await f.service.get(request())).dataUrl).toContain(`data:${mime};base64,`);
    }
  });
  it('rejects redirects and oversized content length, cancels oversized streamed bytes', async () => {
    for (const response of [
      new Response(PNG, { status: 302, headers: { location: 'https://evil.test' } }),
      new Response(PNG, {
        headers: { 'content-type': 'image/png', 'content-length': String(1024 * 1024 + 1) },
      }),
    ]) {
      const f = fixture(async () => response);
      expect(await f.service.get(request())).toEqual({});
    }
    const cancel = vi.fn();
    let pulls = 0;
    const f = fixture(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              pulls++;
              controller.enqueue(new Uint8Array(600000));
            },
            cancel,
          }),
          { headers: { 'content-type': 'image/png' } },
        ),
    );
    expect(await f.service.get(request())).toEqual({});
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pulls).toBeLessThan(5);
  });
  it('times out a stalled body at 10 seconds, aborts it and cleans up timers on dispose', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const f = fixture(
      async () =>
        new Response(new ReadableStream({ start() {}, cancel }), {
          headers: { 'content-type': 'image/png' },
        }),
    );
    const pending = f.service.get(request());
    await vi.advanceTimersByTimeAsync(0);
    const signal = f.transport.mock.calls[0][1]!.signal!;
    await vi.advanceTimersByTimeAsync(9999);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({});
    expect(signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalled();
    f.service.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
