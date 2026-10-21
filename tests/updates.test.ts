import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  UpdateManager,
  selectUpdate,
  createUpdateQuitHandler,
  updateIo,
  type UpdateClock,
  type UpdateIo,
  type UpdateFile,
  type UpdateOptions,
} from '../electron/updates.js';
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const bytes = Buffer.from('verified isolated installer bytes');
const hash = createHash('sha256').update(bytes).digest('hex');
const name = 'Cinema-Bar-0.3.0-macOS-arm64.dmg';
const url = `https://github.com/BS-Stack-Lab/cinema-bar/releases/download/v0.3.0/${name}`;
function release(patch = {}, assetPatch = {}) {
  return {
    tag_name: 'v0.3.0',
    draft: false,
    prerelease: false,
    assets: [
      {
        id: 1,
        name,
        state: 'uploaded',
        size: bytes.length,
        digest: `sha256:${hash}`,
        browser_download_url: url,
        ...assetPatch,
      },
    ],
    ...patch,
  };
}
function clockFixture() {
  let now = NOW;
  let counter = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: UpdateClock = {
    now: () => now,
    setTimeout(callback, delay) {
      const id = ++counter;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id as number);
    },
  };
  return {
    clock,
    advance(milliseconds: number) {
      now += milliseconds;
      for (const [id, timer] of [...timers])
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
    },
    set(time: number) {
      now = time;
    },
  };
}
const roots: string[] = [];
const managers: UpdateManager[] = [];
function owned(options: UpdateOptions) {
  const manager = new UpdateManager(options);
  managers.push(manager);
  return manager;
}
async function fixture(patch: Partial<UpdateOptions> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cinema-updates-'));
  roots.push(root);
  const downloads = path.join(root, 'Downloads');
  await mkdir(downloads);
  const timer = clockFixture();
  const fetcher = vi.fn<typeof fetch>(async (input) =>
    String(input).includes('api.github.com') ? Response.json(release()) : new Response(bytes),
  );
  const opener = vi.fn(async () => '');
  const options: UpdateOptions = {
    currentVersion: '0.2.0',
    platform: 'darwin',
    arch: 'arm64',
    isPackaged: true,
    userDataPath: root,
    downloadsPath: downloads,
    fetch: fetcher,
    openPath: opener,
    clock: timer.clock,
    ...patch,
  };
  const manager = owned(options);
  return {
    root,
    downloads,
    timer,
    fetcher,
    opener,
    options,
    manager,
    record: () => readFile(path.join(root, 'update-check.json'), 'utf8').then(JSON.parse),
  };
}
async function settle() {
  for (let i = 0; i < 15; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function wrapFile(file: UpdateFile, patch: Partial<UpdateFile>): UpdateFile {
  return {
    stat: () => file.stat(),
    read: (...args) => file.read(...args),
    write: (...args) => file.write(...args),
    close: () => file.close(),
    sync: () => file.sync(),
    ...patch,
  };
}
afterEach(async () => {
  for (const manager of managers.splice(0)) void manager.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe('strict public release selection', () => {
  it('selects exactly the greater stable OS installer; same/older releases are current', () => {
    expect(selectUpdate(release(), '0.2.0', 'darwin', 'arm64')).toMatchObject({
      name,
      hash,
      size: bytes.length,
    });
    expect(selectUpdate(release(), '0.3.0', 'darwin', 'arm64')).toBeUndefined();
    expect(selectUpdate(release(), '1.0.0', 'darwin', 'arm64')).toBeUndefined();
    const windowsName = 'Cinema-Bar-0.3.0-Windows-x64-Setup.exe';
    expect(
      selectUpdate(
        release({}, { name: windowsName, browser_download_url: url.replace(name, windowsName) }),
        '0.2.0',
        'win32',
        'x64',
      )?.name,
    ).toBe(windowsName);
  });
  it.each(['v01.3.0', 'v0.3.0-beta', 'v0.3.0+build', 'v9007199254740992.0.0', '0.3.0'])(
    'rejects noncanonical tag %s',
    (tag_name) => {
      expect(() => selectUpdate(release({ tag_name }), '0.2.0', 'darwin', 'arm64')).toThrow();
    },
  );
  it.each([
    { digest: null },
    { digest: 'sha256:no' },
    { size: 0 },
    { size: 513 * 1024 * 1024 },
    { id: 0 },
    { state: 'new' },
    { browser_download_url: `${url}?token=secret` },
    { browser_download_url: url.replace('github.com', 'evil.example') },
  ])('rejects invalid digest/size/identity/address %j', (patch) => {
    expect(() => selectUpdate(release({}, patch), '0.2.0', 'darwin', 'arm64')).toThrow();
  });
  it('rejects duplicate exact assets, drafts and prereleases', () => {
    const value = release();
    value.assets.push(value.assets[0]);
    expect(() => selectUpdate(value, '0.2.0', 'darwin', 'arm64')).toThrow();
    for (const patch of [{ draft: true }, { prerelease: true }])
      expect(() => selectUpdate(release(patch), '0.2.0', 'darwin', 'arm64')).toThrow();
  });
});
describe('isolated update manager', () => {
  it('development/unsupported builds never touch transport or storage', async () => {
    for (const patch of [
      { isPackaged: false },
      { platform: 'linux' },
      { arch: 'x64' },
      { currentVersion: '0.2.0-dev' },
    ]) {
      const f = await fixture(patch);
      f.manager.start();
      await f.manager.check();
      await f.manager.download();
      expect(f.manager.snapshot().phase).toBe('disabled');
      expect(f.fetcher).not.toHaveBeenCalled();
      expect(await readdir(f.root)).toEqual(['Downloads']);
    }
  });
  it('commits a private preflight lease before HTTP and clears it before publishing availability', async () => {
    const f = await fixture();
    f.fetcher.mockImplementation(async () => {
      const record = await f.record();
      expect(record.githubBlockedUntil).toBe(NOW + 24 * HOUR);
      expect(record.recentManualAttempts).toEqual([NOW]);
      return Response.json(release());
    });
    const revisions: number[] = [];
    f.manager.subscribe((state) => revisions.push(state.revision));
    await f.manager.check();
    expect(f.manager.snapshot()).toMatchObject({
      phase: 'available',
      currentVersion: '0.2.0',
      availableVersion: '0.3.0',
    });
    expect((await f.record()).githubBlockedUntil).toBe(0);
    expect((await lstat(f.manager.metadataPath)).mode & 0o777).toBe(0o600);
    expect(new Set(revisions).size).toBe(revisions.length);
    expect(await readdir(f.root)).toEqual(['Downloads', 'update-check.json']);
  });
  it('streams exact bytes into an exclusive private part and rehashes before explicit open; failed handoff retries without network', async () => {
    const f = await fixture();
    await f.manager.check();
    const states: string[] = [];
    f.manager.subscribe((state) => states.push(state.phase));
    await f.manager.download();
    expect(f.opener).not.toHaveBeenCalled();
    const directories = await readdir(f.downloads);
    expect(directories).toHaveLength(1);
    const file = path.join(f.downloads, directories[0], name);
    expect(await readdir(path.dirname(file))).toEqual([name]);
    expect(await readFile(file)).toEqual(bytes);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect(states).toContain('verifying');
    expect(f.manager.snapshot().phase).toBe('ready');
    f.opener.mockResolvedValueOnce('fixture failure');
    await f.manager.openInstaller();
    expect(f.manager.snapshot().phase).toBe('ready');
    await f.manager.openInstaller();
    expect(f.manager.snapshot().phase).toBe('opened');
    expect(f.opener).toHaveBeenCalledTimes(2);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    await f.manager.dispose();
    expect(await readFile(file)).toEqual(bytes);
  });
  it('rejects installer tampering and symlinks without invoking the opener', async () => {
    for (const symbolic of [false, true]) {
      const f = await fixture();
      await f.manager.check();
      await f.manager.download();
      const [directory] = await readdir(f.downloads);
      const file = path.join(f.downloads, directory, name);
      if (symbolic) {
        const target = path.join(f.root, 'external');
        await writeFile(target, bytes);
        await rm(file);
        await symlink(target, file);
      } else await writeFile(file, Buffer.alloc(bytes.length, 7));
      await f.manager.openInstaller();
      expect(f.manager.snapshot().phase).toBe('error');
      expect(f.opener).not.toHaveBeenCalled();
    }
  });
  it.each(['wrong-hash', 'short', 'long', 'content-length'])(
    'rejects %s download and cleans only its partial',
    async (kind) => {
      const f = await fixture();
      await f.manager.check();
      await writeFile(path.join(f.downloads, 'keep-user-file'), 'keep');
      f.fetcher.mockResolvedValueOnce(
        new Response(
          kind === 'wrong-hash'
            ? Buffer.alloc(bytes.length)
            : kind === 'short'
              ? bytes.subarray(0, 2)
              : kind === 'long'
                ? Buffer.concat([bytes, bytes])
                : bytes,
          { headers: kind === 'content-length' ? { 'content-length': '1' } : {} },
        ),
      );
      await f.manager.download();
      expect(f.manager.snapshot().phase).toBe('error');
      expect(await readdir(f.downloads)).toEqual(['keep-user-file']);
      expect(f.opener).not.toHaveBeenCalled();
    },
  );
  it('cancels a noncooperative stream and retries in a fresh directory without stale progress', async () => {
    const f = await fixture();
    await f.manager.check();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    f.fetcher.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            stream = controller;
            controller.enqueue(bytes.subarray(0, 2));
          },
        }),
      ),
    );
    const download = f.manager.download();
    await vi.waitFor(() => expect(f.manager.snapshot().downloadedBytes).toBe(2));
    await f.manager.cancel();
    await download;
    expect(f.manager.snapshot().phase).toBe('available');
    expect(await readdir(f.downloads)).toEqual([]);
    await f.manager.download();
    const revision = f.manager.snapshot().revision;
    expect(() => stream.enqueue(bytes)).toThrow();
    await settle();
    expect(f.manager.snapshot().phase).toBe('ready');
    expect(f.manager.snapshot().revision).toBe(revision);
  });
  it('allows only HTTPS exact CDN redirects and bounds loops/redirect count', async () => {
    for (const location of [
      'http://release-assets.githubusercontent.com/file',
      'https://evil.example/file',
      'https://github.com/other/file',
      'https://user:pass@release-assets.githubusercontent.com/file',
      `${url}`,
    ]) {
      const f = await fixture();
      await f.manager.check();
      f.fetcher.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }));
      await f.manager.download();
      expect(f.manager.snapshot().phase).toBe('error');
      expect(f.opener).not.toHaveBeenCalled();
    }
    const f = await fixture();
    await f.manager.check();
    f.fetcher
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location: 'https://release-assets.githubusercontent.com/fixture?signature=hidden',
          },
        }),
      )
      .mockResolvedValueOnce(new Response(bytes));
    await f.manager.download();
    expect(f.manager.snapshot().phase).toBe('ready');
    expect(JSON.stringify(f.manager.snapshot())).not.toContain('signature');
    expect(f.fetcher.mock.calls.every(([, init]) => init?.redirect === 'manual')).toBe(true);
  });
  it('bounds metadata body and aborts whole-request and stalled-download deadlines', async () => {
    const f = await fixture();
    f.fetcher.mockResolvedValueOnce(new Response('x'.repeat(1024 * 1024 + 1)));
    await f.manager.check();
    expect(f.manager.snapshot().phase).toBe('error');
    const g = await fixture();
    const barrier = deferred<Response>();
    g.fetcher.mockReturnValueOnce(barrier.promise);
    const checking = g.manager.check();
    await vi.waitFor(() => expect(g.fetcher).toHaveBeenCalledTimes(1));
    g.timer.advance(15_000);
    await checking;
    expect(g.manager.snapshot().phase).toBe('error');
    expect((await g.record()).githubBlockedUntil).toBe(NOW + 24 * HOUR);
    barrier.resolve(Response.json(release()));
    await settle();
    expect(g.manager.snapshot().phase).toBe('error');
    const h = await fixture();
    await h.manager.check();
    h.fetcher.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.subarray(0, 2));
          },
        }),
      ),
    );
    const download = h.manager.download();
    await vi.waitFor(() => expect(h.manager.snapshot().downloadedBytes).toBe(2));
    h.timer.advance(30_000);
    await download;
    expect(h.manager.snapshot().phase).toBe('error');
    expect(await readdir(h.downloads)).toEqual([]);
  });
  it('rejects redirect traversal/count overflow and metadata redirects without following', async () => {
    const f = await fixture();
    f.fetcher.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://api.github.com/other' } }),
    );
    await f.manager.check();
    expect(f.manager.snapshot().phase).toBe('error');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    for (const overflow of [false, true]) {
      const g = await fixture();
      await g.manager.check();
      let hop = 0;
      g.fetcher.mockImplementation(
        async () =>
          new Response(null, {
            status: 302,
            headers: {
              location: overflow
                ? `https://release-assets.githubusercontent.com/fixture-${++hop}`
                : 'https://release-assets.githubusercontent.com/files/%2e%2e/escape',
            },
          }),
      );
      await g.manager.download();
      expect(g.manager.snapshot().phase).toBe('error');
      expect(g.fetcher).toHaveBeenCalledTimes(overflow ? 5 : 2);
      expect(await readdir(g.downloads)).toEqual([]);
    }
  });
  it('coalesces concurrent commands and never lets late network results publish after disposal', async () => {
    const f = await fixture();
    const waiting = deferred<Response>();
    f.fetcher.mockReturnValueOnce(waiting.promise);
    const check = f.manager.check();
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
    await f.manager.check();
    await f.manager.download();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    const revision = f.manager.snapshot().revision;
    await f.manager.dispose();
    await check;
    waiting.resolve(Response.json(release()));
    await settle();
    expect(f.manager.snapshot().revision).toBe(revision);
    expect(f.opener).not.toHaveBeenCalled();
  });
  it('uses built-in fetch/AbortController/Response streams through an injected data-only transport', async () => {
    const f = await fixture();
    await f.manager.check();
    f.fetcher.mockImplementationOnce(async (_input, init) =>
      fetch(`data:application/octet-stream;base64,${bytes.toString('base64')}`, init),
    );
    await f.manager.download();
    expect(f.manager.snapshot().phase).toBe('ready');
    const controller = new AbortController();
    controller.abort();
    await expect(fetch('data:text/plain,fixture', { signal: controller.signal })).rejects.toThrow();
  });
});
describe('restart-safe updater metadata', () => {
  it('restores exact >24h GitHub cooldown and refuses restart/clock-rollback bypass', async () => {
    const f = await fixture();
    f.fetcher.mockResolvedValueOnce(
      new Response(null, {
        status: 429,
        headers: {
          'retry-after': '172800',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String((NOW + 3 * HOUR) / 1000),
        },
      }),
    );
    await f.manager.check();
    const blocked = NOW + 48 * HOUR;
    expect((await f.record()).githubBlockedUntil).toBe(blocked);
    await f.manager.dispose();
    const restarted = owned(f.options);
    f.timer.set(NOW - HOUR);
    await restarted.check();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(restarted.snapshot().nextCheckAllowedAt).toBe(blocked);
    f.timer.set(blocked);
    await restarted.check();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it('enforces 60 seconds and five rolling manual attempts across every restart', async () => {
    const f = await fixture();
    f.fetcher.mockImplementation(async () => Response.json(release({ tag_name: 'v0.2.0' })));
    let manager = f.manager;
    for (let index = 0; index < 5; index++) {
      await manager.check();
      expect(f.fetcher).toHaveBeenCalledTimes(index + 1);
      await manager.dispose();
      manager = owned(f.options);
      await manager.check();
      expect(f.fetcher).toHaveBeenCalledTimes(index + 1);
      f.timer.advance(60_000);
    }
    await manager.check();
    expect(f.fetcher).toHaveBeenCalledTimes(5);
    expect((await f.record()).recentManualAttempts).toHaveLength(5);
    f.timer.set(NOW + HOUR);
    await manager.check();
    expect(f.fetcher).toHaveBeenCalledTimes(6);
  });
  it('runs startup after 10s and respects persisted six-hour automatic spacing', async () => {
    const f = await fixture();
    f.fetcher.mockImplementation(async () => Response.json(release({ tag_name: 'v0.2.0' })));
    f.manager.start();
    await f.manager.initialize();
    await settle();
    f.timer.advance(9999);
    await settle();
    expect(f.fetcher).not.toHaveBeenCalled();
    f.timer.advance(1);
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(f.manager.snapshot().phase).toBe('current'));
    await f.manager.dispose();
    const manager = owned(f.options);
    manager.start();
    await manager.initialize();
    await settle();
    f.timer.advance(10_000);
    await settle();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    f.timer.advance(6 * HOUR);
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(manager.snapshot().phase).toBe('current'));
  });
  it('manual startup check suppresses the scheduled initial automatic request', async () => {
    const f = await fixture();
    f.fetcher.mockImplementation(async () => Response.json(release({ tag_name: 'v0.2.0' })));
    f.manager.start();
    await f.manager.check();
    f.timer.advance(10_000);
    await settle();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([1, 2, 3])(
    'blocks release success when atomic replacement %d fails; preserves preflight on result-save failure',
    async (failure) => {
      let renames = 0;
      const f = await fixture({
        io: {
          ...updateIo,
          rename: async (from, to) => {
            if (++renames === failure) throw new Error('denied');
            await updateIo.rename(from, to);
          },
        },
      });
      await f.manager.check();
      expect(f.manager.snapshot().phase).toBe('error');
      expect(f.fetcher).toHaveBeenCalledTimes(failure === 3 ? 1 : 0);
      if (failure === 3) {
        expect((await f.record()).githubBlockedUntil).toBe(NOW + 24 * HOUR);
        const restarted = owned({ ...f.options, io: updateIo });
        await restarted.check();
        expect(f.fetcher).toHaveBeenCalledTimes(1);
      }
      expect((await readdir(f.root)).some((file) => file.endsWith('.tmp'))).toBe(false);
    },
  );
  it.each([
    'unknown-key',
    'future-schema',
    'oversize',
    'malformed',
    'invalid-time',
    'manual-history',
  ])(
    'blocks %s metadata then recovers a corrupt regular file with a finite lease',
    async (kind) => {
      const f = await fixture();
      const record = {
        schemaVersion: 1,
        lastAttemptAt: 0,
        recentManualAttempts: [],
        githubBlockedUntil: 0,
      };
      const bad =
        kind === 'oversize'
          ? ' '.repeat(4097)
          : kind === 'malformed'
            ? '{'
            : JSON.stringify(
                kind === 'unknown-key'
                  ? { ...record, other: true }
                  : kind === 'future-schema'
                    ? { ...record, schemaVersion: 2 }
                    : kind === 'invalid-time'
                      ? { ...record, githubBlockedUntil: -1 }
                      : { ...record, recentManualAttempts: [NOW] },
              );
      await writeFile(f.manager.metadataPath, bad);
      await f.manager.initialize();
      expect(f.manager.snapshot().phase).toBe('error');
      expect(f.fetcher).not.toHaveBeenCalled();
      await f.manager.check();
      expect(f.fetcher).not.toHaveBeenCalled();
      expect((await f.record()).githubBlockedUntil).toBe(NOW + 24 * HOUR);
    },
  );
  it('never overwrites symlink/nonregular metadata or touches existing application data', async () => {
    const f = await fixture();
    const target = path.join(f.root, 'state.json');
    await writeFile(target, 'existing-user-state');
    await symlink(target, f.manager.metadataPath);
    await f.manager.check();
    await f.manager.check();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(await readFile(target, 'utf8')).toBe('existing-user-state');
    expect((await lstat(f.manager.metadataPath)).isSymbolicLink()).toBe(true);
  });
  it('blocks read permission/nonregular failures and resumes only after a valid readable record', async () => {
    const f = await fixture({
      io: {
        ...updateIo,
        lstat: async () => {
          throw Object.assign(new Error('private filesystem detail'), { code: 'EACCES' });
        },
      },
    });
    await f.manager.initialize();
    await f.manager.check();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.manager.snapshot().message).not.toContain('private filesystem detail');
    const g = await fixture();
    await mkdir(g.manager.metadataPath);
    await g.manager.check();
    expect(g.fetcher).not.toHaveBeenCalled();
    expect((await lstat(g.manager.metadataPath)).isDirectory()).toBe(true);
  });
  it('limits a never-settling metadata read to two seconds and quarantines late completion', async () => {
    const f = await fixture();
    await f.manager.initialize();
    await f.manager.dispose();
    const reached = deferred();
    const releaseIo = deferred();
    const restarted = owned({
      ...f.options,
      io: {
        ...updateIo,
        lstat: async (file) => {
          reached.resolve();
          await releaseIo.promise;
          return updateIo.lstat(file);
        },
      },
    });
    const initializing = restarted.initialize();
    await reached.promise;
    f.timer.advance(1999);
    expect(restarted.snapshot().phase).toBe('idle');
    f.timer.advance(1);
    await initializing;
    expect(restarted.snapshot().phase).toBe('error');
    releaseIo.resolve();
    await settle();
    await restarted.check();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('quarantines a timed-out metadata transaction and refuses late-I/O recovery/network', async () => {
    const reached = deferred();
    const releaseIo = deferred();
    const f = await fixture({
      io: {
        ...updateIo,
        open: async (file, flags, mode) => {
          const handle = await updateIo.open(file, flags, mode);
          if (!file.endsWith('.tmp')) return handle;
          return wrapFile(handle, {
            write: async (...args) => {
              reached.resolve();
              await releaseIo.promise;
              return handle.write(...args);
            },
          });
        },
      },
    });
    const initializing = f.manager.initialize();
    await reached.promise;
    f.timer.advance(2000);
    await initializing;
    expect(f.manager.snapshot().phase).toBe('error');
    await f.manager.check();
    expect(f.fetcher).not.toHaveBeenCalled();
    releaseIo.resolve();
    await settle();
    await f.manager.check();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.manager.snapshot().message).toContain('다시 실행');
  });
});
describe('user-only bounded quit continuation', () => {
  it('keeps idle quit synchronous and never starts a continuation itself', () => {
    const stop = vi.fn();
    const dispose = vi.fn(async () => undefined);
    const quit = vi.fn();
    const preventDefault = vi.fn();
    const handler = createUpdateQuitHandler({
      stop,
      dispose,
      continueQuit: quit,
      hasActiveIo: () => false,
    });
    expect(quit).not.toHaveBeenCalled();
    handler({ preventDefault });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });
  it('defers once, stops monitoring before cleanup, continues exactly once on success or rejection', async () => {
    for (const reject of [false, true]) {
      const timer = clockFixture();
      const done = deferred();
      const order: string[] = [];
      const preventDefault = vi.fn();
      const quit = vi.fn(() => order.push('quit'));
      const handler = createUpdateQuitHandler({
        clock: timer.clock,
        hasActiveIo: () => true,
        stop: () => order.push('stop'),
        dispose: () => {
          order.push('cleanup');
          return done.promise;
        },
        continueQuit: quit,
      });
      handler({ preventDefault });
      handler({ preventDefault });
      await settle();
      expect(order).toEqual(['stop', 'cleanup']);
      if (reject) done.reject(new Error('cleanup denied'));
      else done.resolve();
      await settle();
      timer.advance(5000);
      handler({ preventDefault });
      expect(order).toEqual(['stop', 'cleanup', 'quit']);
      expect(quit).toHaveBeenCalledTimes(1);
    }
  });
  it.each(['write', 'close', 'rm'] as const)(
    'bounds an actual manager cleanup stuck on %s to five seconds, even after late completion',
    async (operation) => {
      const reached = deferred();
      const releaseIo = deferred();
      const order: string[] = [];
      const io: UpdateIo = {
        ...updateIo,
        open: async (file, flags, mode) => {
          const handle = await updateIo.open(file, flags, mode);
          if (!file.endsWith('.part')) return handle;
          return wrapFile(handle, {
            write: async (...args) => {
              if (operation === 'write') {
                reached.resolve();
                order.push('write-wait');
                await releaseIo.promise;
              }
              return handle.write(...args);
            },
            close: async () => {
              if (operation === 'close') {
                reached.resolve();
                order.push('close-wait');
                await releaseIo.promise;
              }
              await handle.close();
              order.push('closed');
            },
          });
        },
        rm: async (file, options) => {
          if (operation === 'rm' && file.endsWith('.part')) {
            reached.resolve();
            order.push('rm-wait');
            await releaseIo.promise;
          }
          await updateIo.rm(file, options);
          if (file.endsWith('.part')) order.push('removed');
        },
      };
      const f = await fixture({ io });
      await f.manager.check();
      if (operation === 'rm')
        f.fetcher.mockResolvedValueOnce(new Response(Buffer.alloc(bytes.length)));
      const download = f.manager.download();
      await reached.promise;
      const quit = vi.fn(() => order.push('quit'));
      const preventDefault = vi.fn();
      const handler = createUpdateQuitHandler({
        clock: f.timer.clock,
        hasActiveIo: () => f.manager.hasActiveIo,
        dispose: () => f.manager.dispose(),
        stop: () => order.push('stopped'),
        continueQuit: quit,
      });
      handler({ preventDefault });
      await settle();
      f.timer.advance(4999);
      expect(quit).not.toHaveBeenCalled();
      handler({ preventDefault });
      f.timer.advance(1);
      expect(quit).toHaveBeenCalledTimes(1);
      const revision = f.manager.snapshot().revision;
      releaseIo.resolve();
      await download;
      await settle();
      f.timer.advance(5000);
      expect(quit).toHaveBeenCalledTimes(1);
      expect(f.manager.snapshot().revision).toBe(revision);
      expect(order.indexOf('stopped')).toBeLessThan(order.indexOf('quit'));
      expect(order.indexOf('closed')).toBeLessThan(order.indexOf('removed'));
    },
  );
});
