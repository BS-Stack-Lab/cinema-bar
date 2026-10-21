import { randomUUID } from 'node:crypto';
import type { CatalogService } from './catalog.js';
import type { Fetcher } from './providers/index.js';
import type { Catalog, PosterRequest, PosterResult, Provider } from './types.js';
import { normalizeTitle } from './validation.js';
const MAX_BYTES = 1024 * 1024;
const CACHE_BYTES = 16 * MAX_BYTES;
const TTL = 15 * 60000;
export function catalogPosterUrl(
  provider: Provider,
  movieId: string,
  value: unknown,
): string | undefined {
  if (typeof value !== 'string' || value.length > 1000 || /[\\\s%]/u.test(value)) return;
  if (provider === 'cgv') {
    if (!/^\d{1,9}$/u.test(movieId) || value !== `${movieId}_320.jpg`) return;
    return `https://cdn.cgv.co.kr/cgvpomsfilm/Movie/Thumbnail/Poster/${movieId.padStart(9, '0').slice(0, 6)}/${movieId}/${value}`;
  }
  if (provider === 'megabox') {
    if (
      !/^\/SharedImg\/\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9_-]+_150\.(?:png|jpg|jpeg|webp)$/u.test(value)
    )
      return;
    return `https://img.megabox.co.kr${value}`;
  }
  return validatePosterUrl(provider, value);
}
export function validatePosterUrl(provider: Provider, value: string): string | undefined {
  if (value.length > 1000 || /[\\\s%]/u.test(value) || /(?:^|\/)\.{1,2}(?:\/|$)/u.test(value))
    return;
  try {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.port ||
      value.includes('#') ||
      value.includes('?') ||
      value.match(/^https?:\/\/([^/]+)/u)?.[1] !== url.hostname
    )
      return;
    if (
      provider === 'lottecinema' &&
      url.hostname === 'cf.lottecinema.co.kr' &&
      url.protocol === 'http:'
    )
      url.protocol = 'https:';
    if (url.protocol !== 'https:') return;
    const paths: Record<Provider, [string, RegExp]> = {
      cgv: [
        'cdn.cgv.co.kr',
        /^\/cgvpomsfilm\/Movie\/Thumbnail\/Poster\/\d{6}\/\d{1,9}\/\d{1,9}_320\.jpg$/u,
      ],
      megabox: [
        'img.megabox.co.kr',
        /^\/SharedImg\/\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9_-]+_150\.(?:png|jpg|jpeg|webp)$/u,
      ],
      lottecinema: [
        'cf.lottecinema.co.kr',
        /^\/Media\/MovieFile\/MovieImg\/\d{6}\/\d+_\d+_\d+\.(?:jpg|jpeg|png|webp)$/u,
      ],
    };
    if (provider === 'lottecinema') url.pathname = url.pathname.replace(/\/{2,}/gu, '/');
    const [host, pattern] = paths[provider];
    if (url.hostname !== host || !pattern.test(url.pathname)) return;
    if (provider === 'cgv') {
      const parts = url.pathname.split('/');
      const movieId = parts.at(-2)!;
      if (
        parts.at(-3) !== movieId.padStart(9, '0').slice(0, 6) ||
        parts.at(-1) !== `${movieId}_320.jpg`
      )
        return;
    }
    return url.toString();
  } catch {
    return;
  }
}
interface Waiter {
  resolve(value: PosterResult): void;
  reject(error: Error): void;
  lookup?: Lookup;
  job?: Job;
}
interface Lookup {
  requestId: string;
  users: Set<string>;
  promise: Promise<Catalog>;
}
interface Job {
  key: string;
  url: string;
  waiters: Set<string>;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  isStarted: boolean;
}
export type ImageInspector = (bytes: Uint8Array) => { width: number; height: number } | undefined;
export class PosterService {
  private requests = new Map<string, Waiter>();
  private lookups = new Map<Provider, Lookup>();
  private jobs = new Map<string, Job>();
  private cache = new Map<string, { result: PosterResult; bytes: number; at: number }>();
  private negative = new Map<string, number>();
  private active = 0;
  private isDisposed = false;
  constructor(
    private catalog: Pick<CatalogService, 'get' | 'cancel'>,
    private inspect: ImageInspector,
    private fetcher: Fetcher = fetch,
    private now: () => number = Date.now,
  ) {}
  get(input: PosterRequest): Promise<PosterResult> {
    if (this.isDisposed || this.requests.has(input.requestId) || this.requests.size >= 100)
      return Promise.reject(new Error('포스터 요청을 사용할 수 없습니다.'));
    const result = new Promise<PosterResult>((resolve, reject) => {
      this.requests.set(input.requestId, { resolve, reject });
    });
    void this.resolve(input);
    return result;
  }
  private async resolve(input: PosterRequest) {
    const waiter = this.requests.get(input.requestId)!;
    try {
      let lookup = this.lookups.get(input.provider);
      if (!lookup) {
        const requestId = `poster-${randomUUID()}`;
        lookup = {
          requestId,
          users: new Set(),
          promise: this.catalog.get({ provider: input.provider, requestId }),
        };
        this.lookups.set(input.provider, lookup);
        const current = lookup;
        void current.promise
          .finally(() => {
            if (this.lookups.get(input.provider) === current) this.lookups.delete(input.provider);
          })
          .catch(() => undefined);
      }
      lookup.users.add(input.requestId);
      waiter.lookup = lookup;
      const catalog = await lookup.promise;
      lookup.users.delete(input.requestId);
      waiter.lookup = undefined;
      if (this.isDisposed || this.requests.get(input.requestId) !== waiter) return;
      const matches = input.movieId
        ? catalog.movies.filter((movie) => movie.id === input.movieId)
        : catalog.movies.filter(
            (movie) => normalizeTitle(movie.title) === normalizeTitle(input.movieTitle),
          );
      const movie = matches.length === 1 ? matches[0] : undefined;
      const url = movie?.posterUrl && validatePosterUrl(input.provider, movie.posterUrl);
      if (catalog.provider !== input.provider || !movie || !url)
        return this.settle(input.requestId, {});
      const key = JSON.stringify([input.provider, movie.id, url]);
      this.pruneCache();
      const cached = this.cache.get(key);
      if (cached) {
        this.cache.delete(key);
        this.cache.set(key, cached);
        return this.settle(input.requestId, cached.result);
      }
      if ((this.negative.get(key) ?? 0) > this.now()) return this.settle(input.requestId, {});
      let job = this.jobs.get(key);
      if (!job) {
        if (this.jobs.size >= 100) return this.settle(input.requestId, {});
        job = { key, url, waiters: new Set(), controller: new AbortController(), isStarted: false };
        this.jobs.set(key, job);
      }
      waiter.job = job;
      job.waiters.add(input.requestId);
      this.pump();
    } catch {
      if (this.requests.get(input.requestId) === waiter) this.settle(input.requestId, {});
    }
  }
  private settle(requestId: string, value: PosterResult) {
    const waiter = this.requests.get(requestId);
    this.requests.delete(requestId);
    waiter?.resolve(value);
  }
  cancel(requestId: string) {
    const waiter = this.requests.get(requestId);
    if (!waiter) return;
    this.requests.delete(requestId);
    waiter.reject(new Error('포스터 요청이 취소되었습니다.'));
    if (waiter.lookup) {
      waiter.lookup.users.delete(requestId);
      if (!waiter.lookup.users.size) {
        this.catalog.cancel(waiter.lookup.requestId);
        for (const [provider, lookup] of this.lookups)
          if (lookup === waiter.lookup) this.lookups.delete(provider);
      }
    }
    if (waiter.job) {
      waiter.job.waiters.delete(requestId);
      if (!waiter.job.waiters.size) this.finish(waiter.job);
    }
  }
  private pruneCache() {
    for (const [key, item] of this.cache) if (this.now() - item.at >= TTL) this.cache.delete(key);
    for (const [key, at] of this.negative) if (at <= this.now()) this.negative.delete(key);
    let bytes = [...this.cache.values()].reduce((total, item) => total + item.bytes, 0);
    while (this.cache.size > 32 || bytes > CACHE_BYTES) {
      const key = this.cache.keys().next().value!;
      bytes -= this.cache.get(key)!.bytes;
      this.cache.delete(key);
    }
    while (this.negative.size > 100) this.negative.delete(this.negative.keys().next().value!);
  }
  private pump() {
    if (this.isDisposed) return;
    for (const job of this.jobs.values()) {
      if (this.active >= 3) break;
      if (job.isStarted) continue;
      job.isStarted = true;
      this.active++;
      job.timer = setTimeout(() => this.finish(job, undefined, true), 10000);
      void this.download(job);
    }
  }
  private finish(job: Job, value?: { result: PosterResult; bytes: number }, isFailure = false) {
    if (this.jobs.get(job.key) !== job) return;
    this.jobs.delete(job.key);
    clearTimeout(job.timer);
    if (job.isStarted) this.active--;
    if (!this.isDisposed && job.waiters.size && !job.controller.signal.aborted) {
      if (value) this.cache.set(job.key, { ...value, at: this.now() });
      else if (isFailure) this.negative.set(job.key, this.now() + 30000);
      this.pruneCache();
    }
    job.controller.abort();
    for (const requestId of job.waiters) this.settle(requestId, value?.result ?? {});
    job.waiters.clear();
    this.pump();
  }
  private async download(job: Job) {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const signal = job.controller.signal;
      const response = await this.fetcher(job.url, {
        signal,
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
      });
      if (
        signal.aborted ||
        response.redirected ||
        (response.url && response.url !== job.url) ||
        !response.ok ||
        !response.body
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('image response');
      }
      const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (
        !['image/png', 'image/jpeg', 'image/webp'].includes(mime ?? '') ||
        Number(response.headers.get('content-length')) > MAX_BYTES
      ) {
        await response.body.cancel().catch(() => undefined);
        throw new Error('image headers');
      }
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      const cancelReader = () => {
        void reader?.cancel().catch(() => undefined);
      };
      signal.addEventListener('abort', cancelReader, { once: true });
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (signal.aborted) throw new Error('cancelled');
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) throw new Error('image size');
          chunks.push(value);
        }
      } finally {
        signal.removeEventListener('abort', cancelReader);
      }
      const bytes = Buffer.concat(chunks, size);
      const hasMagic =
        mime === 'image/png'
          ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : mime === 'image/jpeg'
            ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
            : bytes.subarray(0, 4).toString() === 'RIFF' &&
              bytes.subarray(8, 12).toString() === 'WEBP';
      if (!hasMagic || signal.aborted) throw new Error('image signature');
      const dimensions = this.inspect(bytes);
      if (
        !dimensions ||
        !Number.isInteger(dimensions.width) ||
        !Number.isInteger(dimensions.height) ||
        dimensions.width < 1 ||
        dimensions.height < 1 ||
        dimensions.width > 4096 ||
        dimensions.height > 4096 ||
        dimensions.width * dimensions.height > 16000000
      )
        throw new Error('image dimensions');
      this.finish(job, {
        result: { dataUrl: `data:${mime};base64,${bytes.toString('base64')}` },
        bytes: size,
      });
    } catch {
      await reader?.cancel().catch(() => undefined);
      this.finish(job, undefined, true);
    } finally {
      reader?.releaseLock();
    }
  }
  dispose() {
    if (this.isDisposed) return;
    this.isDisposed = true;
    for (const requestId of [...this.requests.keys()]) this.cancel(requestId);
    for (const job of [...this.jobs.values()]) this.finish(job);
    this.cache.clear();
    this.negative.clear();
    this.lookups.clear();
  }
}
