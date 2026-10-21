import * as fs from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { UpdateState } from './types.js';

const HOUR = 3_600_000;
const LEASE = 24 * HOUR;
const MAX_ASSET = 512 * 1024 * 1024;
const LATEST = 'https://api.github.com/repos/BS-Stack-Lab/cinema-bar/releases/latest';
const PREFIX = 'https://github.com/BS-Stack-Lab/cinema-bar/releases/download/';
const RECORD_LIMIT = 4096;
interface CheckRecord {
  schemaVersion: 1;
  lastAttemptAt: number;
  recentManualAttempts: number[];
  githubBlockedUntil: number;
}
export interface UpdateFile {
  stat(): Promise<Stats>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
export interface UpdateIo {
  lstat(file: string): Promise<Stats>;
  realpath(file: string): Promise<string>;
  open(file: string, flags: string | number, mode?: number): Promise<UpdateFile>;
  mkdtemp(prefix: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  rmdir(directory: string): Promise<void>;
  rm(file: string, options: { force: boolean; recursive?: boolean }): Promise<void>;
}
export const updateIo: UpdateIo = fs;
export interface UpdateClock {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(timer: unknown): void;
}
export const updateClock: UpdateClock = {
  now: Date.now,
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds).unref(),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
export interface UpdateOptions {
  currentVersion: string;
  platform: string;
  arch: string;
  isPackaged: boolean;
  userDataPath: string;
  downloadsPath: string;
  fetch: typeof fetch;
  openPath(file: string): Promise<string>;
  io?: UpdateIo;
  clock?: UpdateClock;
}
interface Asset {
  version: string;
  name: string;
  url: string;
  size: number;
  hash: string;
}
class MetadataError extends Error {
  constructor(readonly kind: 'corrupt' | 'unsafe' | 'timeout') {
    super(kind);
  }
}
function stableVersion(value: unknown, tag = false): number[] {
  if (
    typeof value !== 'string' ||
    !(
      tag
        ? /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u
        : /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u
    ).test(value)
  )
    throw new Error('지원하지 않는 릴리스 버전이에요. 공개 릴리스를 확인해 주세요.');
  const parts = (tag ? value.slice(1) : value).split('.').map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part)))
    throw new Error('지원하지 않는 릴리스 버전이에요.');
  return parts;
}
function safeUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    value.includes('#')
  )
    throw new Error('허용되지 않은 업데이트 주소예요.');
  return url;
}
export function selectUpdate(
  release: unknown,
  currentVersion: string,
  platform: string,
  arch: string,
): Asset | undefined {
  const current = stableVersion(currentVersion);
  if (!release || typeof release !== 'object') throw new Error('릴리스 정보를 확인하지 못했어요.');
  const value = release as Record<string, unknown>;
  if (value.draft !== false || value.prerelease !== false)
    throw new Error('정식 릴리스만 설치할 수 있어요.');
  const next = stableVersion(value.tag_name, true);
  const comparison =
    next.map((part, index) => part - current[index]).find((part) => part !== 0) ?? 0;
  if (comparison <= 0) return undefined;
  const version = (value.tag_name as string).slice(1);
  const suffix =
    platform === 'darwin' && arch === 'arm64'
      ? 'macOS-arm64.dmg'
      : platform === 'win32' && arch === 'x64'
        ? 'Windows-x64-Setup.exe'
        : undefined;
  if (!suffix) throw new Error('이 운영체제와 CPU의 업데이트는 지원하지 않아요.');
  const name = `Cinema-Bar-${version}-${suffix}`;
  const assets = Array.isArray(value.assets)
    ? value.assets.filter((asset) => asset && typeof asset === 'object' && asset.name === name)
    : [];
  if (assets.length !== 1) throw new Error('이 기기의 설치 파일을 하나로 확인하지 못했어요.');
  const asset = assets[0];
  if (
    asset.state !== 'uploaded' ||
    !Number.isSafeInteger(asset.id) ||
    asset.id <= 0 ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > MAX_ASSET ||
    typeof asset.digest !== 'string' ||
    !/^sha256:[a-f\d]{64}$/iu.test(asset.digest)
  )
    throw new Error('설치 파일의 크기와 SHA256 정보를 확인하지 못했어요.');
  const url = `${PREFIX}v${version}/${name}`;
  if (asset.browser_download_url !== url || safeUrl(url).search)
    throw new Error('허용되지 않은 설치 파일 주소예요.');
  return { version, name, url, size: asset.size, hash: asset.digest.slice(7).toLowerCase() };
}
function validateRecord(value: unknown): CheckRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MetadataError('corrupt');
  const record = value as CheckRecord;
  const timestamp = (number: unknown) =>
    typeof number === 'number' &&
    Number.isSafeInteger(number) &&
    number >= 0 &&
    number <= 8_640_000_000_000_000;
  if (
    Object.keys(record).sort().join(',') !==
      'githubBlockedUntil,lastAttemptAt,recentManualAttempts,schemaVersion' ||
    record.schemaVersion !== 1 ||
    !timestamp(record.lastAttemptAt) ||
    !timestamp(record.githubBlockedUntil) ||
    !Array.isArray(record.recentManualAttempts) ||
    record.recentManualAttempts.length > 5 ||
    record.recentManualAttempts.some(
      (item, index, array) =>
        !timestamp(item) ||
        item === 0 ||
        item > record.lastAttemptAt ||
        (index > 0 && item < array[index - 1]),
    ) ||
    (record.lastAttemptAt === 0 && record.recentManualAttempts.length !== 0)
  )
    throw new MetadataError('corrupt');
  return record;
}
function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
function aborted() {
  return new Error('업데이트 작업이 취소됐어요.');
}
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const abort = () => reject(aborted());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class UpdateManager {
  private state: UpdateState;
  private readonly io: UpdateIo;
  private readonly clock: UpdateClock;
  private readonly listeners = new Set<(state: UpdateState) => void>();
  private readonly pending = new Set<Promise<unknown>>();
  private record?: CheckRecord;
  private metadataError?: MetadataError;
  private quarantined = false;
  private initialization?: Promise<void>;
  private active?: Promise<UpdateState>;
  private controller?: AbortController;
  private generation = 0;
  private disposed = false;
  private automaticTimer?: unknown;
  private manualStarted = false;
  private asset?: Asset;
  private readyFile?: { directory: string; file: string; asset: Asset };
  readonly metadataPath: string;
  constructor(private readonly options: UpdateOptions) {
    this.io = options.io ?? updateIo;
    this.clock = options.clock ?? updateClock;
    this.metadataPath = path.join(options.userDataPath, 'update-check.json');
    const supported =
      (options.platform === 'darwin' && options.arch === 'arm64') ||
      (options.platform === 'win32' && options.arch === 'x64');
    let valid = true;
    try {
      stableVersion(options.currentVersion);
    } catch {
      valid = false;
    }
    this.state = {
      revision: 0,
      phase: options.isPackaged && supported && valid ? 'idle' : 'disabled',
      currentVersion: options.currentVersion,
      platformLabel:
        options.platform === 'darwin' && options.arch === 'arm64'
          ? 'macOS · Apple Silicon · DMG'
          : options.platform === 'win32' && options.arch === 'x64'
            ? 'Windows · x64 · Setup'
            : `${options.platform} · ${options.arch}`,
      ...(!options.isPackaged || !supported || !valid
        ? {
            message: !options.isPackaged
              ? '개발 실행에서는 앱 업데이트를 확인하지 않아요.'
              : '이 운영체제·CPU 또는 앱 버전의 업데이트는 지원하지 않아요.',
          }
        : {}),
    };
  }
  snapshot(): UpdateState {
    return { ...this.state };
  }
  subscribe(listener: (state: UpdateState) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(patch: Partial<UpdateState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.snapshot());
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }
  get hasActiveIo() {
    return this.pending.size > 0;
  }
  private assertCurrent(generation: number) {
    if (this.disposed || generation !== this.generation) throw aborted();
  }
  private metadata<T>(operation: (assertLive: () => void) => Promise<T>): Promise<T> {
    let live = true;
    const task = this.track(
      operation(() => {
        if (!live || this.disposed) throw aborted();
      }),
    );
    return new Promise((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        live = false;
        this.quarantined = true;
        reject(new MetadataError('timeout'));
      }, 2000);
      task.then(resolve, reject).finally(() => {
        live = false;
        this.clock.clearTimeout(timer);
      });
    });
  }
  private async readRecord(): Promise<CheckRecord | undefined> {
    return this.metadata(async (live) => {
      let stat: Stats;
      try {
        stat = await this.io.lstat(this.metadataPath);
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw new MetadataError('unsafe');
      }
      live();
      if (!stat.isFile() || stat.isSymbolicLink()) throw new MetadataError('unsafe');
      const file = await this.io.open(
        this.metadataPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        live();
        const opened = await file.stat();
        live();
        if (!opened.isFile() || stat.ino !== opened.ino || stat.dev !== opened.dev)
          throw new MetadataError('unsafe');
        const bytes = new Uint8Array(RECORD_LIMIT + 1);
        let length = 0;
        while (length < bytes.length) {
          const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
          live();
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        if (length > RECORD_LIMIT) throw new MetadataError('corrupt');
        try {
          return validateRecord(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))),
          );
        } catch (error) {
          if (error instanceof MetadataError) throw error;
          throw new MetadataError('corrupt');
        }
      } finally {
        await file.close();
      }
    });
  }
  private async saveRecord(record: CheckRecord) {
    validateRecord(record);
    await this.metadata(async (live) => {
      const temporary = path.join(this.options.userDataPath, `update-check.${randomUUID()}.tmp`);
      let file: UpdateFile | undefined;
      try {
        const bytes = Buffer.from(JSON.stringify(record));
        if (bytes.length > RECORD_LIMIT) throw new MetadataError('corrupt');
        live();
        file = await this.io.open(temporary, 'wx', 0o600);
        live();
        await this.writeAll(file, bytes);
        live();
        await file.sync();
        live();
        await file.close();
        file = undefined;
        live();
        await this.io.rename(temporary, this.metadataPath);
        live();
      } finally {
        if (file) await file.close();
        await this.io.rm(temporary, { force: true });
      }
    });
    this.record = record;
  }
  private metadataFailure(error: unknown) {
    this.metadataError = error instanceof MetadataError ? error : new MetadataError('unsafe');
    this.publish({
      phase: 'error',
      message: this.quarantined
        ? '업데이트 확인 기록 저장이 늦어졌어요. 앱을 다시 실행해 주세요. 감시는 계속돼요.'
        : '업데이트 확인 기록을 읽거나 저장하지 못했어요. 저장 폴더 권한을 확인한 뒤 다시 시도하세요. 감시는 계속돼요.',
    });
  }
  async initialize(): Promise<UpdateState> {
    if (this.state.phase === 'disabled' || this.disposed) return this.snapshot();
    if (!this.initialization)
      this.initialization = (async () => {
        try {
          const record = await this.readRecord();
          if (this.disposed) return;
          if (record) this.record = record;
          else
            await this.saveRecord({
              schemaVersion: 1,
              lastAttemptAt: 0,
              recentManualAttempts: [],
              githubBlockedUntil: 0,
            });
          if (!this.disposed) this.publish({ nextCheckAllowedAt: this.nextManual() || undefined });
        } catch (error) {
          this.metadataFailure(error);
        }
      })();
    await this.initialization;
    return this.snapshot();
  }
  start() {
    void this.initialize().then(() => {
      if (!this.manualStarted)
        this.scheduleAutomatic(Math.max(this.clock.now() + 10_000, this.nextAutomatic()));
    });
  }
  private nextAutomatic() {
    return Math.max(
      this.record?.lastAttemptAt ? this.record.lastAttemptAt + 6 * HOUR : 0,
      this.record?.githubBlockedUntil ?? 0,
    );
  }
  private nextManual() {
    if (!this.record) return 0;
    const recent = this.record.recentManualAttempts.filter(
      (time) => time > this.clock.now() - HOUR,
    );
    return Math.max(
      this.record.lastAttemptAt ? this.record.lastAttemptAt + 60_000 : 0,
      this.record.githubBlockedUntil,
      recent.length >= 5 ? recent[0] + HOUR : 0,
    );
  }
  private scheduleAutomatic(at: number) {
    this.clock.clearTimeout(this.automaticTimer);
    if (this.disposed || this.state.phase === 'disabled' || this.metadataError || this.quarantined)
      return;
    this.automaticTimer = this.clock.setTimeout(
      () => {
        void this.check(false);
      },
      Math.max(1, at - this.clock.now()),
    );
  }
  check(manual = true): Promise<UpdateState> {
    if (manual) {
      this.manualStarted = true;
      this.clock.clearTimeout(this.automaticTimer);
    }
    if (
      this.active ||
      this.disposed ||
      this.state.phase === 'disabled' ||
      ['available', 'downloading', 'verifying', 'ready', 'opening', 'opened'].includes(
        this.state.phase,
      )
    )
      return Promise.resolve(this.snapshot());
    const task = this.checkJob(manual);
    this.active = task;
    void task.finally(() => {
      if (this.active === task) this.active = undefined;
      this.scheduleAutomatic(Math.max(this.clock.now() + 6 * HOUR, this.nextAutomatic()));
    });
    return task;
  }
  private async recoverMetadata(): Promise<boolean> {
    if (this.quarantined) return false;
    try {
      let record: CheckRecord | undefined;
      try {
        record = await this.readRecord();
      } catch (error) {
        if (!(error instanceof MetadataError) || error.kind !== 'corrupt') throw error;
        await this.saveRecord({
          schemaVersion: 1,
          lastAttemptAt: this.clock.now(),
          recentManualAttempts: [],
          githubBlockedUntil: this.clock.now() + LEASE,
        });
        this.metadataError = undefined;
        this.publish({
          phase: 'idle',
          nextCheckAllowedAt: this.nextManual(),
          message:
            '확인 기록을 복구했어요. 불확실한 이전 요청 때문에 표시된 시각까지 최대 24시간 기다려 주세요.',
        });
        return false;
      }
      if (!record)
        await this.saveRecord({
          schemaVersion: 1,
          lastAttemptAt: this.clock.now(),
          recentManualAttempts: [],
          githubBlockedUntil: this.clock.now() + LEASE,
        });
      else this.record = record;
      this.metadataError = undefined;
      return true;
    } catch (error) {
      this.metadataFailure(error);
      return false;
    }
  }
  private async checkJob(manual: boolean): Promise<UpdateState> {
    await this.initialize();
    if (this.disposed || this.quarantined) return this.snapshot();
    if (this.metadataError && (!manual || !(await this.recoverMetadata()))) return this.snapshot();
    const next = manual ? this.nextManual() : this.nextAutomatic();
    if (this.clock.now() < next) {
      this.publish({
        nextCheckAllowedAt: next,
        message:
          '업데이트 확인 대기 중이에요. 다음 확인 가능 시각 이후 다시 시도하세요. 불확실한 요청은 최대 24시간 대기할 수 있어요.',
      });
      return this.snapshot();
    }
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.publish({ phase: 'checking', message: undefined });
    let timeout: unknown;
    try {
      const now = this.clock.now();
      const record: CheckRecord = {
        schemaVersion: 1,
        lastAttemptAt: now,
        recentManualAttempts: [
          ...this.record!.recentManualAttempts.filter((time) => time > now - HOUR),
          ...(manual ? [now] : []),
        ],
        githubBlockedUntil: now + LEASE,
      };
      try {
        await this.saveRecord(record);
      } catch (error) {
        this.metadataFailure(error);
        return this.snapshot();
      }
      this.assertCurrent(generation);
      this.publish({ nextCheckAllowedAt: this.nextManual() });
      timeout = this.clock.setTimeout(() => controller.abort(), 15_000);
      let response: Response;
      try {
        response = await this.track(
          raceAbort(
            this.options.fetch(LATEST, {
              redirect: 'manual',
              signal: controller.signal,
              headers: {
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2026-03-10',
              },
            }),
            controller.signal,
          ),
        );
      } catch {
        throw new Error(
          '업데이트 서버에 연결하지 못했어요. 표시된 다음 확인 시각 이후 다시 시도하세요.',
        );
      }
      this.assertCurrent(generation);
      const blockedUntil =
        response.status === 403 || response.status === 429 ? this.cooldown(response.headers) : 0;
      // The committed preflight lease remains if a response cannot be recorded safely.
      try {
        await this.saveRecord({ ...record, githubBlockedUntil: blockedUntil });
      } catch (error) {
        this.metadataFailure(error);
        return this.snapshot();
      }
      this.assertCurrent(generation);
      this.publish({ lastCheckedAt: now, nextCheckAllowedAt: this.nextManual() });
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error(
          blockedUntil
            ? 'GitHub에서 확인을 잠시 제한했어요. 다음 확인 가능 시각까지 기다려 주세요.'
            : '업데이트 서버가 응답하지 못했어요. 잠시 뒤 다시 확인하세요.',
        );
      }
      const bytes = await this.readResponse(response, RECORD_LIMIT * 256, controller.signal);
      this.assertCurrent(generation);
      let release: unknown;
      try {
        release = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        throw new Error('릴리스 정보를 확인하지 못했어요. 잠시 뒤 다시 시도하세요.');
      }
      const selected = selectUpdate(
        release,
        this.options.currentVersion,
        this.options.platform,
        this.options.arch,
      );
      this.asset = selected;
      this.publish({
        phase: selected ? 'available' : 'current',
        availableVersion: selected?.version,
        totalBytes: selected?.size,
        downloadedBytes: undefined,
        message: selected ? '새 버전을 다운로드할 수 있어요.' : '최신 버전을 사용하고 있어요.',
      });
    } catch (error) {
      if (!this.disposed && generation === this.generation)
        this.publish({
          phase: 'error',
          nextCheckAllowedAt: this.nextManual(),
          message: controller.signal.aborted
            ? '업데이트 확인 시간이 초과됐어요. 불확실한 요청은 표시된 시각까지 최대 24시간 대기할 수 있어요.'
            : error instanceof Error && !/JSON|Unexpected token/u.test(error.message)
              ? error.message
              : '릴리스 정보를 확인하지 못했어요. 잠시 뒤 다시 시도하세요.',
        });
    } finally {
      this.clock.clearTimeout(timeout);
      if (this.controller === controller) this.controller = undefined;
    }
    return this.snapshot();
  }
  private cooldown(headers: Headers) {
    const now = this.clock.now();
    const retry = headers.get('retry-after');
    const reset =
      headers.get('x-ratelimit-remaining') === '0' ? headers.get('x-ratelimit-reset') : null;
    const retryAt =
      retry && /^\d+$/u.test(retry) ? now + Number(retry) * 1000 : retry ? Date.parse(retry) : 0;
    const resetAt = reset && /^\d+$/u.test(reset) ? Number(reset) * 1000 : 0;
    const valid = [retryAt, resetAt].filter(
      (time) => Number.isSafeInteger(time) && time > now && time <= 8_640_000_000_000_000,
    );
    return valid.length ? Math.max(...valid) : now + HOUR;
  }
  private async readResponse(
    response: Response,
    limit: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    if (!response.body) throw new Error('업데이트 응답이 비어 있어요.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await this.track(raceAbort(reader.read(), signal));
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error('업데이트 응답이 너무 커요.');
        chunks.push(value);
      }
      return Buffer.concat(chunks, size);
    } finally {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  download(): Promise<UpdateState> {
    if (
      this.active ||
      this.disposed ||
      !this.asset ||
      !['available', 'error'].includes(this.state.phase)
    )
      return Promise.resolve(this.snapshot());
    const task = this.track(this.downloadJob(this.asset));
    this.active = task;
    void task.finally(() => {
      if (this.active === task) this.active = undefined;
    });
    return task;
  }
  private async writeAll(file: UpdateFile, bytes: Uint8Array) {
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
      if (!bytesWritten) throw new Error('설치 파일을 저장하지 못했어요.');
      offset += bytesWritten;
    }
  }
  private async downloadJob(asset: Asset): Promise<UpdateState> {
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const timeout = this.clock.setTimeout(() => controller.abort(), 600_000);
    let stalled: unknown;
    let directory: string | undefined;
    let partial: string | undefined;
    let file: UpdateFile | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cleanupFailed = false;
    const progressDeadline = () => {
      this.clock.clearTimeout(stalled);
      stalled = this.clock.setTimeout(() => controller.abort(), 30_000);
    };
    this.publish({
      phase: 'downloading',
      downloadedBytes: 0,
      totalBytes: asset.size,
      message: undefined,
    });
    try {
      progressDeadline();
      let url = asset.url;
      let response: Response | undefined;
      const visited = new Set<string>();
      for (let redirects = 0; redirects <= 3; redirects++) {
        const parsed = safeUrl(url);
        if (
          (url !== asset.url && parsed.hostname !== 'release-assets.githubusercontent.com') ||
          visited.has(url)
        )
          throw new Error('허용되지 않은 다운로드 이동이에요.');
        visited.add(url);
        response = await raceAbort(
          this.options.fetch(url, { redirect: 'manual', signal: controller.signal }),
          controller.signal,
        );
        this.assertCurrent(generation);
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        void response.body?.cancel().catch(() => undefined);
        const location = response.headers.get('location');
        if (!location || redirects === 3)
          throw new Error('설치 파일 이동 횟수를 확인하지 못했어요.');
        const locationPath = location.split(/[?#]/u)[0];
        if (
          locationPath
            .split('/')
            .some((segment) => ['.', '..'].includes(decodeURIComponent(segment)))
        )
          throw new Error('허용되지 않은 다운로드 이동이에요.');
        url = new URL(location, url).href;
      }
      if (!response || response.status !== 200 || !response.body)
        throw new Error('설치 파일을 받지 못했어요. 다시 시도하세요.');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^[1-9]\d*$/u.test(length) || Number(length) !== asset.size))
        throw new Error('설치 파일 크기가 릴리스 정보와 달라요.');
      directory = await this.io.mkdtemp(
        path.join(this.options.downloadsPath, 'Cinema-Bar-update-'),
      );
      this.assertCurrent(generation);
      partial = path.join(directory, `${asset.name}.part`);
      file = await this.io.open(partial, 'wx', 0o600);
      this.assertCurrent(generation);
      reader = response.body.getReader();
      const hash = createHash('sha256');
      let size = 0;
      while (true) {
        const { done, value } = await raceAbort(reader.read(), controller.signal);
        this.assertCurrent(generation);
        if (done) break;
        size += value.byteLength;
        if (size > asset.size || size > MAX_ASSET)
          throw new Error('설치 파일 크기가 릴리스 정보와 달라요.');
        progressDeadline();
        await this.writeAll(file, value);
        this.assertCurrent(generation);
        hash.update(value);
        this.publish({ downloadedBytes: size });
      }
      this.publish({ phase: 'verifying' });
      if (size !== asset.size || hash.digest('hex') !== asset.hash)
        throw new Error('설치 파일 SHA256 또는 크기가 달라요. 다시 다운로드하세요.');
      await file.close();
      file = undefined;
      this.assertCurrent(generation);
      const destination = path.join(directory, asset.name);
      await this.io.rename(partial, destination);
      // A verified installer is retained even when quit arrives during rename.
      partial = undefined;
      this.readyFile = { directory, file: destination, asset };
      this.assertCurrent(generation);
      this.publish({ phase: 'ready', message: undefined });
    } catch {
      if (!this.disposed && generation === this.generation)
        this.publish({
          phase: 'error',
          message: controller.signal.aborted
            ? '다운로드 시간이 초과됐어요. 다시 다운로드하세요.'
            : '설치 파일을 받거나 검증하지 못했어요. 디스크 공간과 연결을 확인한 뒤 다시 다운로드하세요.',
        });
    } finally {
      this.clock.clearTimeout(timeout);
      this.clock.clearTimeout(stalled);
      void reader?.cancel().catch(() => undefined);
      try {
        if (file) await file.close();
        if (partial) {
          await this.io.rm(partial, { force: true });
          if (directory) await this.io.rmdir(directory);
        }
      } catch {
        cleanupFailed = true;
        if (!this.disposed)
          this.publish({
            message:
              '부분 파일을 정리하지 못했어요. 다운로드 폴더에서 Cinema-Bar-update- 폴더를 확인하세요.',
          });
      }
      if (this.controller === controller) this.controller = undefined;
      if (!this.disposed && generation !== this.generation)
        this.publish({
          phase: 'available',
          downloadedBytes: undefined,
          message: cleanupFailed
            ? '다운로드를 취소했지만 부분 파일을 정리하지 못했어요. 다운로드 폴더의 Cinema-Bar-update- 폴더를 확인하세요.'
            : '다운로드를 취소했어요. 다시 받을 수 있어요.',
        });
    }
    return this.snapshot();
  }
  async cancel(): Promise<UpdateState> {
    if (!['downloading', 'verifying'].includes(this.state.phase)) return this.snapshot();
    this.generation++;
    this.controller?.abort();
    await this.active;
    return this.snapshot();
  }
  openInstaller(): Promise<UpdateState> {
    if (
      this.active ||
      this.disposed ||
      !this.readyFile ||
      !['ready', 'opened'].includes(this.state.phase)
    )
      return Promise.resolve(this.snapshot());
    const task = this.track(this.openJob(this.readyFile));
    this.active = task;
    void task.finally(() => {
      if (this.active === task) this.active = undefined;
    });
    return task;
  }
  private async openJob(ready: NonNullable<UpdateManager['readyFile']>): Promise<UpdateState> {
    const generation = this.generation;
    let file: UpdateFile | undefined;
    this.publish({ phase: 'opening', message: undefined });
    let verified = false;
    try {
      const directoryStat = await this.io.lstat(ready.directory);
      this.assertCurrent(generation);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
        throw new Error('invalid');
      const stat = await this.io.lstat(ready.file);
      this.assertCurrent(generation);
      const realDirectory = await this.io.realpath(ready.directory);
      const realFile = await this.io.realpath(ready.file);
      const realDownloads = await this.io.realpath(this.options.downloadsPath);
      this.assertCurrent(generation);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size !== ready.asset.size ||
        path.dirname(realDirectory) !== realDownloads ||
        path.dirname(realFile) !== realDirectory ||
        path.basename(realFile) !== ready.asset.name
      )
        throw new Error('invalid');
      file = await this.io.open(ready.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = await file.stat();
      this.assertCurrent(generation);
      if (
        !opened.isFile() ||
        stat.ino !== opened.ino ||
        stat.dev !== opened.dev ||
        opened.size !== ready.asset.size
      )
        throw new Error('invalid');
      const hash = createHash('sha256');
      const bytes = new Uint8Array(64 * 1024);
      let position = 0;
      while (true) {
        const { bytesRead } = await file.read(bytes, 0, bytes.length, position);
        this.assertCurrent(generation);
        if (!bytesRead) break;
        position += bytesRead;
        if (position > ready.asset.size) throw new Error('invalid');
        hash.update(bytes.subarray(0, bytesRead));
      }
      if (position !== ready.asset.size || hash.digest('hex') !== ready.asset.hash)
        throw new Error('invalid');
      await file.close();
      file = undefined;
      this.assertCurrent(generation);
      verified = true;
      const result = await this.options.openPath(ready.file);
      this.assertCurrent(generation);
      this.publish({
        phase: result ? 'ready' : 'opened',
        message: result
          ? '설치 파일을 열지 못했어요. 다시 열기를 눌러 주세요. 감시는 계속돼요.'
          : '설치 파일을 열었어요.',
      });
    } catch {
      if (!this.disposed && generation === this.generation) {
        if (!verified) this.readyFile = undefined;
        this.publish({
          phase: verified ? 'ready' : 'error',
          message: verified
            ? '설치 파일을 열지 못했어요. 다시 시도하세요. 감시는 계속돼요.'
            : '설치 파일이 없거나 변경됐어요. 다시 다운로드하세요.',
        });
      }
    } finally {
      if (file) await file.close().catch(() => undefined);
    }
    return this.snapshot();
  }
  dispose(): Promise<void> {
    this.disposed = true;
    this.generation++;
    this.clock.clearTimeout(this.automaticTimer);
    this.controller?.abort();
    this.listeners.clear();
    return Promise.allSettled([...this.pending, ...(this.active ? [this.active] : [])]).then(
      () => undefined,
    );
  }
}

export function createUpdateQuitHandler(options: {
  hasActiveIo(): boolean;
  dispose(): Promise<void>;
  stop(): void;
  continueQuit(): void;
  clock?: UpdateClock;
}) {
  const clock = options.clock ?? updateClock;
  let stopped = false;
  let waiting = false;
  let continued = false;
  const stop = () => {
    if (!stopped) {
      stopped = true;
      options.stop();
    }
  };
  return (event: { preventDefault(): void }) => {
    if (continued) return;
    if (waiting) {
      event.preventDefault();
      return;
    }
    const active = options.hasActiveIo();
    stop();
    if (!active) {
      void options.dispose().catch(() => undefined);
      return;
    }
    event.preventDefault();
    waiting = true;
    const timer = clock.setTimeout(() => finish(), 5000);
    const finish = () => {
      if (continued) return;
      continued = true;
      clock.clearTimeout(timer);
      options.continueQuit();
    };
    void Promise.resolve()
      .then(() => options.dispose())
      .then(finish, finish);
  };
}
