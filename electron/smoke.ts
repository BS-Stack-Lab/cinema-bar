import { mkdir, writeFile, readFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  UpdateManager,
  createUpdateQuitHandler,
  updateIo,
  type UpdateOptions,
  type UpdateClock,
} from './updates.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import type { App, BrowserWindow, Tray, WebPreferences, Rectangle } from 'electron';
import { Engine } from './engine.js';
import { Store } from './store.js';
import type { PowerPolicy } from './power.js';
import { PopupAlerts } from './notifications.js';
import type { LoginSettings } from './lifecycle.js';
import type { Fetcher } from './providers/index.js';
import { createTrayIcon } from './trayIcon.js';
import { koreanToday } from './validation.js';
import type { SecretCodec } from './secretStore.js';
import type { TraySample } from './trayVisibility.js';
import { validateIpc, validateSender } from './ipc.js';

export function createSmokeRuntime(app: App) {
  assert.equal(process.env.CINEMA_SMOKE, '1');
  assert.ok(process.argv.includes('--cinema-smoke'));
  const profile = process.env.CINEMA_SMOKE_PROFILE;
  assert.ok(profile && path.resolve(profile).startsWith(`${os.tmpdir()}${path.sep}`));
  assert.equal(app.getPath('userData'), profile);
  const output = process.env.CINEMA_SMOKE_OUTPUT;
  assert.ok(output);
  const downloadsPath = path.join(profile, 'Downloads');
  mkdirSync(downloadsPath, { recursive: true });
  const updateBytes = Buffer.from('Cinema Bar isolated updater fixture');
  const installerName = `Cinema-Bar-0.3.0-${process.platform === 'darwin' ? 'macOS-arm64.dmg' : 'Windows-x64-Setup.exe'}`;
  const updateObservations = {
    metadataCalls: 0,
    downloadCalls: 0,
    openerCalls: [] as string[],
    failOpen: true,
    hangDownload: false,
  };
  const updateIsolation = {
    mockTransport: true,
    mockOpener: true,
    mockQuit: true,
    realUpdateNetworkCalls: 0,
    realInstallerOpens: 0,
    updaterQuitRequests: 0,
    downloadsPath,
    metadataPath: path.join(profile, 'update-check.json'),
  };
  const updateOptions: UpdateOptions = {
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    isPackaged: true,
    userDataPath: profile,
    downloadsPath,
    fetch: async (input) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/BS-Stack-Lab/cinema-bar/releases/latest') {
        updateObservations.metadataCalls++;
        return Response.json({
          tag_name: 'v0.3.0',
          draft: false,
          prerelease: false,
          assets: [
            {
              id: 1,
              state: 'uploaded',
              name: installerName,
              size: updateBytes.length,
              digest: `sha256:${createHash('sha256').update(updateBytes).digest('hex')}`,
              browser_download_url: `https://github.com/BS-Stack-Lab/cinema-bar/releases/download/v0.3.0/${installerName}`,
            },
          ],
        });
      }
      assert.equal(
        url,
        `https://github.com/BS-Stack-Lab/cinema-bar/releases/download/v0.3.0/${installerName}`,
      );
      updateObservations.downloadCalls++;
      if (updateObservations.hangDownload)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(updateBytes.subarray(0, 2));
            },
          }),
        );
      return new Response(updateBytes);
    },
    openPath: async (file) => {
      updateObservations.openerCalls.push(file);
      return updateObservations.failOpen ? 'fixture open rejection' : '';
    },
  };
  const values = new Map<string, string>();
  const codecEvidence = { kind: 'in-memory', availabilityChecks: 0, encrypts: 0, decrypts: 0 };
  const codec: SecretCodec = {
    isAvailable: () => {
      codecEvidence.availabilityChecks++;
      return true;
    },
    encrypt: (value) => {
      const token = `smoke-${++codecEvidence.encrypts}`;
      values.set(token, value);
      return Buffer.from(token);
    },
    decrypt: (value) => {
      codecEvidence.decrypts++;
      const result = values.get(value.toString());
      assert.ok(result !== undefined, 'Smoke codec token must belong to this process');
      return result;
    },
  };
  const recordIdentity = (hasLock: boolean) => {
    const readPlist = (key: string) =>
      execFileSync(
        '/usr/libexec/PlistBuddy',
        ['-c', `Print :${key}`, path.resolve(path.dirname(process.execPath), '../Info.plist')],
        { encoding: 'utf8' },
      ).trim();
    const bundleId =
      process.platform === 'darwin' && app.isPackaged ? readPlist('CFBundleIdentifier') : null;
    const displayName =
      process.platform === 'darwin' && app.isPackaged ? readPlist('CFBundleDisplayName') : null;
    if (process.platform === 'darwin' && app.isPackaged) {
      assert.equal(bundleId, 'dev.cinemabar.verification');
      assert.equal(displayName, 'Cinema Bar Verification');
    }
    const role = process.env.CINEMA_SMOKE_SECONDARY === '1' ? 'secondary' : 'primary';
    const identity = {
      role,
      pid: process.pid,
      hasLock,
      bundleId,
      displayName,
      executable: process.execPath,
      appPath: app.getAppPath(),
      isolatedUserData: app.getPath('userData'),
      codec: codecEvidence.kind,
      realSafeStorageCalls: 0,
    };
    mkdirSync(output, { recursive: true });
    writeFileSync(
      path.join(output, `smoke-${role}-identity.json`),
      JSON.stringify(identity, null, 2),
    );
    return identity;
  };
  return {
    codec,
    codecEvidence,
    recordIdentity,
    updateOptions,
    updateBytes,
    updateObservations,
    updateIsolation,
  };
}

interface SmokeContext {
  app: App;
  updates: UpdateManager;
  window: BrowserWindow;
  tray: Tray;
  toggleWindow(): void;
  showWindow(bounds?: Rectangle): void;
  sampleTray(): void;
  traySamples: TraySample[];
  calculateWindowBounds(area: Rectangle, anchor?: Rectangle): Rectangle;
  engine: Engine;
  store: Store;
  login: LoginSettings;
  loginWrites: boolean[];
  securityPreferences: WebPreferences;
  popups: PopupAlerts;
  power: PowerPolicy;
  smokeRuntime: ReturnType<typeof createSmokeRuntime>;
}
export async function runSmoke({
  app,
  window,
  toggleWindow,
  showWindow,
  sampleTray,
  traySamples,
  calculateWindowBounds,
  tray,
  engine,
  store,
  login,
  loginWrites,
  securityPreferences,
  popups,
  power,
  smokeRuntime,
  updates,
}: SmokeContext) {
  const output = process.env.CINEMA_SMOKE_OUTPUT!;
  const actions: { name: string; passed: boolean; detail?: unknown }[] = [];
  const check = (name: string, condition: unknown, detail?: unknown) => {
    actions.push({ name, passed: !!condition, detail });
    assert.ok(condition, name);
  };
  const ui = <T>(code: string): Promise<T> => window.webContents.executeJavaScript(code, true);
  const waitFor = async (code: string) => {
    for (let i = 0; i < 100; i++) {
      if (await ui<boolean>(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`UI condition did not settle: ${code}`);
  };
  const runUpdateSmoke = async () => {
    const runtime = smokeRuntime;
    const observations = runtime.updateObservations;
    const flush = async () => {
      for (let i = 0; i < 12; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    };
    const until = async (condition: () => boolean) => {
      for (let i = 0; i < 200; i++) {
        if (condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('Updater fixture did not settle');
    };
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((yes) => {
        resolve = yes;
      });
      return { promise, resolve };
    };
    const fakeClock = () => {
      let now = Date.now();
      let id = 0;
      const timers = new Map<number, { at: number; callback: () => void }>();
      const clock: UpdateClock = {
        now: () => now,
        setTimeout(callback, delay) {
          const key = ++id;
          timers.set(key, { at: now + delay, callback });
          return key;
        },
        clearTimeout(timer) {
          timers.delete(timer as number);
        },
      };
      return {
        clock,
        advance(milliseconds: number) {
          now += milliseconds;
          for (const [key, timer] of [...timers])
            if (timer.at <= now) {
              timers.delete(key);
              timer.callback();
            }
        },
      };
    };
    const isolated = async (tag: string, patch: Partial<UpdateOptions> = {}) => {
      const directory = path.join(store.directory, `update-fixture-${tag}`);
      const downloadsPath = path.join(directory, 'Downloads');
      await mkdir(downloadsPath, { recursive: true });
      const options = {
        ...runtime.updateOptions,
        userDataPath: directory,
        downloadsPath,
        ...patch,
      };
      return { manager: new UpdateManager(options), options, directory, downloadsPath };
    };
    await ui(
      "Array.from(document.querySelectorAll('[role=tab]')).find(x=>x.textContent==='설정').click()",
    );
    await waitFor('!!document.querySelector(".updateCard")');
    const initial = await ui<{ currentVersion: string; phase: string }>(
      'window.cinema.getUpdateState()',
    );
    check(
      'update-state-current-version',
      initial.currentVersion === app.getVersion() &&
        initial.phase === 'idle' &&
        (await ui(
          `document.querySelector('.updateCard').textContent.includes(${JSON.stringify(app.getVersion())})`,
        )),
      initial,
    );
    const available = await ui<{ phase: string; availableVersion: string; platformLabel: string }>(
      'window.cinema.checkForUpdates()',
    );
    check(
      'update-check-stable-platform',
      available.phase === 'available' &&
        available.availableVersion === '0.3.0' &&
        available.platformLabel.includes(process.platform === 'darwin' ? 'DMG' : 'Setup'),
      { ...available, metadataCalls: observations.metadataCalls },
    );
    await ui('window.cinema.downloadUpdate()');
    const [folder] = await readdir(runtime.updateIsolation.downloadsPath);
    const [installer] = await readdir(path.join(runtime.updateIsolation.downloadsPath, folder));
    const readyFile = path.join(runtime.updateIsolation.downloadsPath, folder, installer);
    const readyBytes = await readFile(readyFile);
    check(
      'update-download-hash-ready',
      updates.snapshot().phase === 'ready' &&
        readyBytes.equals(runtime.updateBytes) &&
        !installer.endsWith('.part') &&
        (process.platform === 'win32' || ((await lstat(readyFile)).mode & 0o777) === 0o600),
      {
        state: updates.snapshot(),
        sha256: createHash('sha256').update(readyBytes).digest('hex'),
        bytes: readyBytes.length,
        file: readyFile,
      },
    );
    observations.hangDownload = true;
    const canceled = await isolated('cancel');
    await canceled.manager.check();
    const canceledJob = canceled.manager.download();
    await until(() => canceled.manager.snapshot().downloadedBytes === 2);
    await canceled.manager.cancel();
    await canceledJob;
    observations.hangDownload = false;
    const remaining = await readdir(canceled.downloadsPath);
    check(
      'update-download-cancel-cleans-partial',
      canceled.manager.snapshot().phase === 'available' && remaining.length === 0,
      { phase: canceled.manager.snapshot().phase, remaining },
    );
    await canceled.manager.dispose();
    const engineWasStarted = engine.isStarted;
    await ui('window.cinema.openUpdateInstaller()');
    check(
      'update-installer-open-failure-keeps-running',
      updates.snapshot().phase === 'ready' &&
        engine.isStarted === engineWasStarted &&
        (await readFile(readyFile)).equals(runtime.updateBytes),
      {
        phase: updates.snapshot().phase,
        engineWasStarted,
        engineStillStarted: engine.isStarted,
        openerCalls: observations.openerCalls.length,
      },
    );
    const beforeRetry = observations.downloadCalls;
    observations.failOpen = false;
    await ui('window.cinema.openUpdateInstaller()');
    check(
      'update-installer-open-retry-no-redownload',
      updates.snapshot().phase === 'opened' &&
        observations.downloadCalls === beforeRetry &&
        observations.openerCalls.length === 2 &&
        observations.openerCalls.every((file) => file === readyFile),
      {
        phase: updates.snapshot().phase,
        downloadsBefore: beforeRetry,
        downloadsAfter: observations.downloadCalls,
        openedPaths: observations.openerCalls,
      },
    );
    const payloads = [
      { url: 'https://evil.example' },
      { path: '/tmp/arbitrary' },
      { assetId: 99 },
      null,
    ];
    const channels = [
      'getUpdateState',
      'checkForUpdates',
      'downloadUpdate',
      'cancelUpdate',
      'openUpdateInstaller',
    ];
    let rejected = 0;
    for (const channel of channels)
      for (const payload of payloads) {
        assert.throws(() => validateIpc(channel, payload));
        rejected++;
      }
    assert.throws(() => validateSender({}, {}, 'file:///foreign', 'file:///owned'));
    check(
      'update-ipc-rejects-payload',
      rejected === 20 && channels.every((channel) => validateIpc(channel, undefined) === undefined),
      { channels, rejected, senderRejected: true },
    );
    const bounds = window.getBounds();
    const layouts = [];
    for (const width of [340, 440]) {
      window.setBounds({ ...bounds, width });
      await waitFor(
        `window.innerWidth === ${width} && document.querySelector('.updateCard [role=status]')?.textContent === '설치 파일을 열었어요' && document.querySelector('.updateCard button')?.textContent === '설치 파일 다시 열기'`,
      );
      await ui(`(async () => {
        document.querySelector('.updateCard').scrollIntoView({ block: 'start', behavior: 'instant' });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })()`);
      const layout = await ui<{
        innerWidth: number;
        belowHeader: boolean;
        fullWidth: boolean;
        visible: boolean;
        fits: boolean;
        live: boolean;
        button: string;
        headerBottom: number;
        cardTop: number;
        cardBottom: number;
        cardWidth: number;
        referenceWidth: number;
        contentWidth: number;
        cardLeft: number;
        referenceLeft: number;
      }>(`(() => {
        const panel = document.querySelector('[role=tabpanel]');
        const card = panel.querySelector('.updateCard');
        const header = panel.querySelector(':scope > .sectionTitle');
        const reference = panel.querySelector('.settingsCard:not(.updateCard)');
        const rect = card.getBoundingClientRect();
        const headerRect = header.getBoundingClientRect();
        const referenceRect = reference.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const style = getComputedStyle(panel);
        const paddingLeft = parseFloat(style.paddingLeft);
        const contentWidth = panel.clientWidth - paddingLeft - parseFloat(style.paddingRight);
        const buttons = Array.from(card.querySelectorAll('button'));
        return {
          innerWidth: window.innerWidth,
          belowHeader: card.previousElementSibling === header && rect.top >= headerRect.bottom - 0.5,
          fullWidth: Math.abs(rect.width - referenceRect.width) <= 1 && Math.abs(rect.left - referenceRect.left) <= 1 && Math.abs(rect.width - contentWidth) <= 1 && Math.abs(rect.left - panelRect.left - paddingLeft) <= 1,
          visible: rect.top >= panelRect.top - 0.5 && rect.bottom <= panelRect.bottom + 0.5 && rect.left >= 0 && rect.right <= window.innerWidth,
          fits: buttons.length > 0 && buttons.every(button => { const b = button.getBoundingClientRect(); return b.left >= rect.left && b.right <= rect.right && b.top >= rect.top && b.bottom <= rect.bottom && b.width > 0 && b.height > 0; }),
          live: !!card.querySelector('[role=status][aria-live=polite]'),
          button: buttons[0].textContent,
          headerBottom: headerRect.bottom, cardTop: rect.top, cardBottom: rect.bottom,
          cardWidth: rect.width, referenceWidth: referenceRect.width, contentWidth,
          cardLeft: rect.left, referenceLeft: referenceRect.left,
        };
      })()`);
      assert.ok(
        layout.innerWidth === width &&
          layout.belowHeader &&
          layout.fullWidth &&
          layout.visible &&
          layout.fits &&
          layout.live &&
          layout.button === '설치 파일 다시 열기',
        JSON.stringify(layout),
      );
      const screenshot = `update-opened-${width}.png`;
      const image = await window.webContents.capturePage();
      assert.ok(!image.isEmpty());
      await writeFile(path.join(output, screenshot), image.toPNG());
      layouts.push({ width, ...layout, screenshot });
    }
    window.setBounds(bounds);
    check(
      'update-isolation-no-real-side-effects',
      runtime.updateIsolation.realUpdateNetworkCalls === 0 &&
        runtime.updateIsolation.realInstallerOpens === 0 &&
        runtime.updateIsolation.updaterQuitRequests === 0 &&
        runtime.updateIsolation.downloadsPath.startsWith(`${store.directory}${path.sep}`) &&
        runtime.updateIsolation.metadataPath === path.join(store.directory, 'update-check.json') &&
        runtime.updateOptions.fetch !== fetch,
      { ...runtime.updateIsolation, layouts },
    );
    let cooldownCalls = 0;
    const cooldown = await isolated('cooldown', {
      fetch: async () => {
        cooldownCalls++;
        return new Response(null, { status: 429, headers: { 'retry-after': '172800' } });
      },
    });
    await cooldown.manager.check();
    const cooldownRecord = JSON.parse(await readFile(cooldown.manager.metadataPath, 'utf8'));
    await cooldown.manager.dispose();
    const restarted = new UpdateManager(cooldown.options);
    await restarted.check();
    check(
      'update-cooldown-survives-manager-restart',
      cooldownCalls === 1 &&
        restarted.snapshot().nextCheckAllowedAt === cooldownRecord.githubBlockedUntil &&
        cooldownRecord.githubBlockedUntil > Date.now() + 24 * 3_600_000,
      { calls: cooldownCalls, record: cooldownRecord, state: restarted.snapshot() },
    );
    await restarted.dispose();
    let invalidMetadataCalls = 0;
    const invalid = await isolated('metadata', {
      fetch: async () => {
        invalidMetadataCalls++;
        throw new Error('must never fetch');
      },
    });
    await writeFile(invalid.manager.metadataPath, '{');
    await writeFile(path.join(invalid.directory, 'state.json'), 'existing-user-state');
    await invalid.manager.initialize();
    const initialError = invalid.manager.snapshot().phase;
    await invalid.manager.check();
    const recoveryRecord = JSON.parse(await readFile(invalid.manager.metadataPath, 'utf8'));
    check(
      'update-metadata-failure-blocks-network',
      initialError === 'error' &&
        invalidMetadataCalls === 0 &&
        recoveryRecord.githubBlockedUntil > Date.now() + 23 * 3_600_000 &&
        (await readFile(path.join(invalid.directory, 'state.json'), 'utf8')) ===
          'existing-user-state',
      {
        initialError,
        calls: invalidMetadataCalls,
        record: recoveryRecord,
        existingDataPreserved: true,
      },
    );
    await invalid.manager.dispose();
    const quitFixture = async (
      tag: string,
      operation: 'write' | 'close' | 'rm',
      deadline: boolean,
      cleanupError = false,
    ) => {
      const reached = deferred();
      const releaseIo = deferred();
      const order: string[] = [];
      const time = fakeClock();
      let quits = 0;
      let prevented = 0;
      const item = await isolated(tag, {
        clock: time.clock,
        io: {
          ...updateIo,
          open: async (file, flags, mode) => {
            const handle = await updateIo.open(file, flags, mode);
            if (!file.endsWith('.part')) return handle;
            return {
              stat: () => handle.stat(),
              read: (...args) => handle.read(...args),
              sync: () => handle.sync(),
              write: async (...args) => {
                if (operation === 'write') {
                  order.push('write-wait');
                  reached.resolve();
                  await releaseIo.promise;
                }
                return handle.write(...args);
              },
              close: async () => {
                if (operation === 'close') {
                  order.push('close-wait');
                  reached.resolve();
                  await releaseIo.promise;
                }
                await handle.close();
                order.push('closed');
              },
            };
          },
          rm: async (file, options) => {
            if (file.endsWith('.part')) {
              if (operation === 'rm') {
                order.push('rm-wait');
                reached.resolve();
                await releaseIo.promise;
              }
              if (cleanupError) {
                order.push('rm-rejected');
                throw new Error('fixture cleanup denied');
              }
            }
            await updateIo.rm(file, options);
            if (file.endsWith('.part')) order.push('removed');
          },
        },
      });
      await item.manager.check();
      if (operation === 'rm') observations.hangDownload = true;
      const job = item.manager.download();
      if (operation === 'rm') {
        await until(() => item.manager.snapshot().downloadedBytes === 2);
        void item.manager.cancel();
      }
      await reached.promise;
      observations.hangDownload = false;
      const handleQuit = createUpdateQuitHandler({
        clock: time.clock,
        hasActiveIo: () => item.manager.hasActiveIo,
        dispose: () => item.manager.dispose(),
        stop: () => order.push('monitoring-stopped'),
        continueQuit: () => {
          quits++;
          order.push('quit-continuation');
        },
      });
      assert.equal(quits, 0);
      handleQuit({
        preventDefault: () => {
          prevented++;
        },
      });
      handleQuit({
        preventDefault: () => {
          prevented++;
        },
      });
      await flush();
      let beforeDeadline = 0;
      if (deadline) {
        time.advance(4999);
        beforeDeadline = quits;
        assert.equal(quits, 0);
        time.advance(1);
        assert.equal(quits, 1);
      }
      releaseIo.resolve();
      await job;
      await flush();
      time.advance(5000);
      handleQuit({
        preventDefault: () => {
          prevented++;
        },
      });
      assert.equal(quits, 1);
      assert.equal(prevented, 2);
      assert.ok(order.indexOf('monitoring-stopped') < order.indexOf('quit-continuation'));
      if (!cleanupError) assert.ok(order.indexOf('closed') < order.indexOf('removed'));
      if (!deadline && !cleanupError)
        assert.ok(order.indexOf('removed') < order.indexOf('quit-continuation'));
      const folders = await readdir(item.downloadsPath);
      const files = (
        await Promise.all(folders.map((folder) => readdir(path.join(item.downloadsPath, folder))))
      ).flat();
      return {
        operation,
        beforeDeadline,
        deadlineMilliseconds: deadline ? 5000 : undefined,
        quitContinuations: quits,
        prevented,
        order,
        remainingFiles: files,
      };
    };
    const cleanupOrder = await quitFixture('quit-order', 'write', false);
    check(
      'update-user-quit-cleanup-order',
      cleanupOrder.quitContinuations === 1 && cleanupOrder.remainingFiles.length === 0,
      cleanupOrder,
    );
    const deadlines = [];
    for (const operation of ['write', 'close', 'rm'] as const)
      deadlines.push(await quitFixture(`quit-deadline-${operation}`, operation, true));
    check(
      'update-user-quit-deadline-once',
      deadlines.length === 3 &&
        deadlines.every(
          (item) =>
            item.beforeDeadline === 0 &&
            item.quitContinuations === 1 &&
            item.deadlineMilliseconds === 5000,
        ),
      deadlines,
    );
    const cleanupError = await quitFixture('quit-error', 'write', false, true);
    check(
      'update-quit-cleanup-error-continues',
      cleanupError.quitContinuations === 1 &&
        cleanupError.order.includes('rm-rejected') &&
        cleanupError.remainingFiles.some((file) => file.endsWith('.part')),
      cleanupError,
    );
    await updates.dispose();
    check(
      'update-handed-off-file-retained',
      (await readFile(readyFile)).equals(runtime.updateBytes) &&
        updates.snapshot().phase === 'opened' &&
        runtime.updateIsolation.updaterQuitRequests === 0,
      {
        file: readyFile,
        retained: true,
        phase: updates.snapshot().phase,
        updaterQuitRequests: runtime.updateIsolation.updaterQuitRequests,
      },
    );
    await ui(
      "Array.from(document.querySelectorAll('[role=tab]')).find(x=>x.textContent==='대시보드').click()",
    );
  };
  try {
    await mkdir(output, { recursive: true });
    const identity = smokeRuntime.recordIdentity(true);
    check(
      'primary-smoke-identity-isolated',
      identity.isolatedUserData === store.directory,
      identity,
    );
    const encoded = smokeRuntime.codec.encrypt('smoke-only-value');
    check(
      'smoke-memory-codec-roundtrip',
      smokeRuntime.codec.isAvailable() &&
        !encoded.includes('smoke-only-value') &&
        smokeRuntime.codec.decrypt(encoded) === 'smoke-only-value',
      smokeRuntime.codecEvidence,
    );
    await waitFor('!!document.querySelector("[role=tab]")');
    check(
      'actual-renderer-mounted',
      await ui('document.querySelector("h1").textContent.includes("Cinema Bar")'),
    );
    const headerStyle = await ui<{
      region: string;
      selection: string;
      controlsExcluded: boolean;
      tabsRegion: string;
    }>(
      `(() => {
        const header = getComputedStyle(document.querySelector('.brand'));
        return {
          region: header.getPropertyValue('app-region'),
          selection: header.userSelect,
          controlsExcluded: Array.from(document.querySelectorAll('button, input, select, textarea, a')).every(node => getComputedStyle(node).getPropertyValue('app-region') === 'no-drag'),
          tabsRegion: getComputedStyle(document.querySelector('nav')).getPropertyValue('app-region')
        };
      })()`,
    );
    check(
      'header-native-drag-css-boundary',
      headerStyle.region === 'drag' &&
        headerStyle.selection === 'none' &&
        headerStyle.controlsExcluded &&
        headerStyle.tabsRegion !== 'drag' &&
        window.isMovable(),
      { ...headerStyle, isMovable: window.isMovable(), actualPointerDrag: 'requires-host-qa' },
    );
    const prefs = securityPreferences;
    check(
      'sandbox-contextIsolation-nodeIntegration',
      prefs.sandbox && prefs.contextIsolation && !prefs.nodeIntegration,
    );
    check(
      'renderer-narrow-api',
      await ui(
        'typeof require === "undefined" && typeof process === "undefined" && !window.cinema.invoke && !window.cinema.ipcRenderer && Object.keys(window.cinema).length===22',
      ),
    );
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    check(
      'reduced-motion-disables-decoration',
      await ui(
        "getComputedStyle(document.querySelector('.mascotStage img')).animationName==='none'",
      ),
    );
    window.webContents.debugger.detach();
    for (const name of ['감시 목록', '알림 기록', '설정', '대시보드']) {
      await ui(
        `Array.from(document.querySelectorAll('[role=tab]')).find(x=>x.textContent===${JSON.stringify(name)}).click()`,
      );
      await waitFor(
        `document.querySelector('[role=tab][aria-selected=true]').textContent===${JSON.stringify(name)}`,
      );
      check(`tab-${name}`, true);
    }
    await ui("document.querySelector('[role=tab]').focus()");
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
    await waitFor("document.activeElement.textContent==='감시 목록'");
    check('keyboard-tab-arrow', true);
    await ui(
      "Array.from(document.querySelectorAll('button')).find(x=>x.textContent.includes('＋ 추가')).click()",
    );
    await waitFor('!!document.querySelector(\'select[aria-label="지역"] option[value="01"]\')');
    check(
      'form-controls-excluded-from-native-drag',
      await ui(
        "Array.from(document.querySelectorAll('form input, form select, form button')).every(node => getComputedStyle(node).getPropertyValue('app-region') === 'no-drag')",
      ),
    );
    check(
      'catalog-no-manual-theater-inputs',
      await ui(
        '!document.querySelector(\'input[aria-label="극장 ID"], input[aria-label="극장 이름"]\')',
      ),
    );
    for (const [name, value] of [
      ['지역', '01'],
      ['극장', '0013'],
      ['작품 검색 결과', '30001367'],
    ]) {
      await ui(
        `(() => { const select=document.querySelector('select[aria-label="${name}"]'); const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; setter.call(select,${JSON.stringify(value)}); select.dispatchEvent(new Event('change',{bubbles:true})); })()`,
      );
    }
    await waitFor('!document.querySelector(\'button[type="submit"]\').disabled');
    await writeFile(
      path.join(output, 'catalog-form.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    const toggleSelector = 'button[aria-pressed]';
    await ui(`document.querySelector('${toggleSelector}').click()`);
    check(
      'earliest-button-click-selected',
      await ui(
        `document.querySelector('${toggleSelector}').getAttribute('aria-pressed') === 'true' && document.querySelector('${toggleSelector}').classList.contains('primary')`,
      ),
    );
    await ui(`document.querySelector('${toggleSelector}').focus()`);
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await waitFor(
      `document.querySelector('${toggleSelector}').getAttribute('aria-pressed') === 'false'`,
    );
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await waitFor(
      `document.querySelector('${toggleSelector}').getAttribute('aria-pressed') === 'true'`,
    );
    check(
      'earliest-button-keyboard-does-not-submit',
      store.state.rules.length === 0 &&
        (await ui(
          `document.querySelector('${toggleSelector}').textContent.trim() === '가장 빠른 회차만 알림'`,
        )),
    );
    await ui("document.querySelector('form').requestSubmit()");
    await waitFor('!document.querySelector(\'select[aria-label="지역"]\')');
    check(
      'ui-rule-form-save',
      store.state.rules.length === 1 &&
        store.state.rules[0].movieId === '30001367' &&
        store.state.rules[0].theaterId === '0013',
    );
    const preferenceReload = new Store(store.directory);
    await preferenceReload.load();
    check(
      'earliest-button-save-disk-reload',
      preferenceReload.state.rules[0].shouldNotifyEarliestOnly === true,
    );
    await ui(`document.querySelector('button[aria-label$="수정"]').click()`);
    await waitFor(`!!document.querySelector('${toggleSelector}')`);
    check(
      'earliest-button-edit-persisted',
      await ui(
        `document.querySelector('${toggleSelector}').getAttribute('aria-pressed') === 'true'`,
      ),
    );
    await ui(
      `Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '취소').click()`,
    );
    await waitFor(
      '!!document.querySelector(".ticketArt img") && document.querySelector(".ticketArt img").complete && document.querySelector(".ticketArt img").naturalWidth > 0',
    );
    type PosterRect = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>;
    interface PosterGeometry {
      naturalWidth: number;
      naturalHeight: number;
      viewport: { width: number; height: number };
      image: PosterRect;
      banner: PosterRect;
      card: PosterRect;
      badge: PosterRect;
      panel: PosterRect;
      cardInnerWidth: number;
      format: string;
      bodyBelowImage: boolean;
      controlsPresent: boolean;
      horizontalOverflow: { document: number; panel: number; card: number };
      panelScrollHeight: number;
      panelClientHeight: number;
      panelScrollTop: number;
      panelBetweenChrome: boolean;
    }
    const readPosterGeometry = () =>
      ui<PosterGeometry>(`(async () => {
        await new Promise(resolve => {
          const timer = setTimeout(resolve, 100);
          requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
        });
        const image = document.querySelector('.ticketArt img');
        const banner = image.parentElement;
        const card = image.closest('.rule');
        const panel = card.closest('[role=tabpanel]');
        const style = getComputedStyle(card);
        const rect = node => node.getBoundingClientRect().toJSON();
        return {
          naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
          viewport: {width: innerWidth, height: innerHeight},
          image: rect(image), banner: rect(banner), card: rect(card),
          badge: rect(banner.querySelector('span')), panel: rect(panel),
          cardInnerWidth: card.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth),
          format: banner.querySelector('span').textContent,
          bodyBelowImage: card.querySelector('h3').getBoundingClientRect().top >= banner.getBoundingClientRect().bottom,
          controlsPresent: card.querySelectorAll('.ruleTop button, .ruleActions input, .ruleActions button').length === 3,
          horizontalOverflow: {
            document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            panel: panel.scrollWidth - panel.clientWidth,
            card: card.scrollWidth - card.clientWidth
          },
          panelScrollHeight: panel.scrollHeight, panelClientHeight: panel.clientHeight,
          panelScrollTop: panel.scrollTop,
          panelBetweenChrome: panel.getBoundingClientRect().top >= document.querySelector('nav').getBoundingClientRect().bottom && panel.getBoundingClientRect().bottom <= document.querySelector('footer').getBoundingClientRect().top
        };
      })()`);
    const hasNaturalPosterLayout = (geometry: PosterGeometry) =>
      Math.abs(geometry.image.width - geometry.banner.width) <= 1 &&
      Math.abs(geometry.image.width - geometry.cardInnerWidth) <= 1 &&
      Math.abs(
        geometry.image.height -
          (geometry.image.width * geometry.naturalHeight) / geometry.naturalWidth,
      ) <= 1 &&
      Math.abs(geometry.banner.height - geometry.image.height) <= 1 &&
      geometry.badge.left >= geometry.image.left &&
      geometry.badge.right <= geometry.image.right &&
      geometry.badge.top >= geometry.image.top &&
      geometry.badge.bottom <= geometry.image.bottom &&
      geometry.bodyBelowImage &&
      geometry.controlsPresent &&
      geometry.format === 'ALL SCREENS' &&
      Object.values(geometry.horizontalOverflow).every((overflow) => overflow <= 1) &&
      geometry.panelBetweenChrome;
    const posterDom = await readPosterGeometry();
    check(
      'mock-poster-real-raster-decode-and-banner',
      posterDom.naturalWidth === 22 &&
        posterDom.naturalHeight === 22 &&
        hasNaturalPosterLayout(posterDom),
      { shape: 'square', fixture: 'existing-22x22-mock-raster', ...posterDom },
    );
    const originalBounds = window.getBounds();
    const originalPosterState = await ui<{
      src: string;
      tab: string;
      scrollTop: number;
      scrollX: number;
      scrollY: number;
    }>(`({src: document.querySelector('.ticketArt img').src,
      tab: document.querySelector('[role=tab][aria-selected=true]').textContent,
      scrollTop: document.querySelector('[role=tabpanel]').scrollTop, scrollX, scrollY})`);
    const restorePoster = async () => {
      await ui(
        "Array.from(document.querySelectorAll('[role=tab]')).find(node => node.textContent === '알림 기록').click()",
      );
      await waitFor(
        "document.querySelector('[role=tab][aria-selected=true]').textContent === '알림 기록'",
      );
      await ui(
        `Array.from(document.querySelectorAll('[role=tab]')).find(node => node.textContent === ${JSON.stringify(originalPosterState.tab)}).click()`,
      );
      await waitFor(
        `(() => { const image=document.querySelector('.ticketArt img'); return image && image.src === ${JSON.stringify(originalPosterState.src)} && image.complete && image.naturalWidth === 22 && image.naturalHeight === 22; })()`,
      );
    };
    const posterFixtures: { shape: string; width: number; height: number; src: string }[] = [
      {
        shape: 'portrait',
        width: 240,
        height: 480,
        src: createTrayIcon().resize({ width: 240, height: 480 }).toDataURL(),
      },
      { shape: 'square', width: 22, height: 22, src: originalPosterState.src },
      {
        shape: 'landscape',
        width: 360,
        height: 240,
        src: createTrayIcon().resize({ width: 360, height: 240 }).toDataURL(),
      },
    ];
    const posterLayouts: unknown[] = [];
    let posterFallback: unknown;
    try {
      for (const width of [440, 340]) {
        window.setBounds({ ...originalBounds, width });
        await waitFor(`innerWidth === ${width}`);
        for (const fixture of posterFixtures) {
          try {
            await ui(
              `document.querySelector('.ticketArt img').src = ${JSON.stringify(fixture.src)}`,
            );
            await waitFor(
              `(() => { const image=document.querySelector('.ticketArt img'); return image && image.complete && image.naturalWidth === ${fixture.width} && image.naturalHeight === ${fixture.height}; })()`,
            );
            await ui("document.querySelector('[role=tabpanel]').scrollTop = 0");
            const geometry = await readPosterGeometry();
            check(
              `poster-natural-ratio-${width}-${fixture.shape}`,
              geometry.viewport.width === width && hasNaturalPosterLayout(geometry),
              { shape: fixture.shape, controlledNativePng: true, ...geometry },
            );
            const imageCapture = `poster-${width}-${fixture.shape}.png`;
            await writeFile(
              path.join(output, imageCapture),
              (await window.webContents.capturePage()).toPNG(),
            );
            const controls = await ui<
              {
                name: string;
                rect: PosterRect;
                panel: PosterRect;
                scrollTop: number;
                visible: boolean;
                enabled: boolean;
                unobscured: boolean;
              }[]
            >(`(async () => {
              const panel = document.querySelector('[role=tabpanel]');
              const results = [];
              for (const control of document.querySelectorAll('.ruleTop button, .ruleActions input, .ruleActions button')) {
                control.scrollIntoView({block: 'center'});
                control.focus({preventScroll: true});
                const rect = control.getBoundingClientRect();
                const clip = panel.getBoundingClientRect();
                const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                results.push({name: control.getAttribute('aria-label'), rect: rect.toJSON(), panel: clip.toJSON(), scrollTop: panel.scrollTop,
                  visible: rect.width > 0 && rect.height > 0 && rect.top >= clip.top && rect.bottom <= clip.bottom && rect.left >= clip.left && rect.right <= clip.right,
                  enabled: !control.disabled, unobscured: hit === control || control.contains(hit)});
              }
              return results;
            })()`);
            check(
              `poster-controls-reachable-${width}-${fixture.shape}`,
              controls.length === 3 &&
                controls.every(
                  (control) => control.visible && control.enabled && control.unobscured,
                ),
              controls,
            );
            const controlsCapture = `poster-${width}-${fixture.shape}-controls.png`;
            await writeFile(
              path.join(output, controlsCapture),
              (await window.webContents.capturePage()).toPNG(),
            );
            posterLayouts.push({
              shape: fixture.shape,
              controlledNativePng: true,
              geometry,
              controls,
              imageCapture,
              controlsCapture,
            });
          } finally {
            await ui(
              `document.querySelector('.ticketArt img').src = ${JSON.stringify(originalPosterState.src)}`,
            );
            await waitFor(
              "(() => { const image=document.querySelector('.ticketArt img'); return image && image.complete && image.naturalWidth === 22 && image.naturalHeight === 22; })()",
            );
            await ui(
              `document.querySelector('[role=tabpanel]').scrollTop = ${originalPosterState.scrollTop}`,
            );
          }
        }
      }
      await ui("document.querySelector('.ticketArt img').src = 'data:image/png;base64,AAAA'");
      await waitFor(
        "!!document.querySelector('.ticketArt:not(.hasPoster)') && !document.querySelector('.ticketArt img')",
      );
      posterFallback = await ui(`(() => {
        const banner = document.querySelector('.ticketArt');
        const card = banner.closest('.rule');
        return {height: banner.getBoundingClientRect().height, text: banner.textContent,
          format: banner.querySelector('span').textContent,
          controls: card.querySelectorAll('.ruleTop button, .ruleActions input, .ruleActions button').length,
          hasImage: !!banner.querySelector('img')};
      })()`);
      check(
        'poster-decode-error-restores-70px-ticket-fallback',
        await ui(
          "(() => { const banner=document.querySelector('.ticketArt'); return banner.getBoundingClientRect().height === 70 && banner.textContent.includes('▥') && banner.querySelector('span').textContent === 'ALL SCREENS' && !banner.querySelector('img') && banner.closest('.rule').querySelectorAll('.ruleTop button, .ruleActions input, .ruleActions button').length === 3; })()",
        ),
        posterFallback,
      );
      await restorePoster();
      const recoveredPoster = await readPosterGeometry();
      check(
        'poster-recovers-after-decode-error-remount',
        hasNaturalPosterLayout(recoveredPoster),
        recoveredPoster,
      );
    } finally {
      window.setBounds(originalBounds);
      await restorePoster();
      await waitFor(`innerWidth === ${originalBounds.width}`);
      await ui(
        `document.querySelector('[role=tabpanel]').scrollTop = ${originalPosterState.scrollTop}; window.scrollTo(${originalPosterState.scrollX}, ${originalPosterState.scrollY})`,
      );
    }
    check(
      'poster-ipc-rejects-arbitrary-url',
      await ui(
        `(async()=>{try{await window.cinema.getPoster({provider:'cgv',movieId:'30001367',movieTitle:'x',requestId:'bad-poster',url:'https://example.com'});return false}catch{return true}})()`,
      ),
    );
    check(
      'renderer-csp-retains-image-and-network-boundary',
      await ui(
        `document.querySelector('meta[http-equiv="Content-Security-Policy"]').content.includes("img-src 'self' data:") && document.querySelector('meta[http-equiv="Content-Security-Policy"]').content.includes("connect-src 'none'")`,
      ),
    );
    await writeFile(
      path.join(output, 'poster-native.json'),
      JSON.stringify(
        {
          mockOfficialMetadata: true,
          mockRasterBytes: true,
          actualNativeDecode: true,
          actualOfficialDownload: false,
          posterDom,
          posterLayouts,
          posterFallback,
          restoredBounds: window.getBounds(),
        },
        null,
        2,
      ),
    );
    const nativePower = (await import('electron')).powerSaveBlocker;
    check(
      'native-keepawake-default-off',
      store.state.settings.shouldKeepAwake === false && power.blockerId === undefined,
    );
    await engine.updateSettings({ shouldKeepAwake: true });
    for (let i = 0; i < 100 && power.blockerId === undefined; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const blockerId = power.blockerId;
    check(
      'native-prevent-app-suspension-start',
      blockerId !== undefined &&
        nativePower.isStarted(blockerId) &&
        engine.snapshot().isKeepingAwake,
      { blockerId, pid: process.pid, type: 'prevent-app-suspension' },
    );
    await engine.setPaused(true);
    check(
      'native-blocker-released-on-pause',
      blockerId !== undefined &&
        !nativePower.isStarted(blockerId) &&
        !engine.snapshot().isKeepingAwake,
    );
    await engine.setPaused(false);
    const resumedId = power.blockerId;
    check(
      'native-blocker-resumes-for-active-rule',
      resumedId !== undefined && nativePower.isStarted(resumedId),
    );
    engine.suspend();
    check(
      'native-blocker-released-on-suspend',
      resumedId !== undefined && !nativePower.isStarted(resumedId),
    );
    engine.resume();
    await engine.updateSettings({ shouldKeepAwake: false });
    check(
      'native-blocker-explicit-optout',
      power.blockerId === undefined &&
        !engine.snapshot().isKeepingAwake &&
        !store.state.settings.shouldKeepAwake,
      {
        blockerId: power.blockerId,
        nativeActive: power.blockerId !== undefined && nativePower.isStarted(power.blockerId),
        snapshotActive: engine.snapshot().isKeepingAwake,
        optedIn: store.state.settings.shouldKeepAwake,
        isChecking: engine.snapshot().isChecking,
      },
    );
    await writeFile(
      path.join(output, 'power-native.json'),
      JSON.stringify(
        {
          pid: process.pid,
          type: 'prevent-app-suspension',
          blockerId,
          resumedId,
          nativeStartVerified: true,
          nativePauseStopVerified: true,
          nativeSuspendStopVerified: true,
          nativeOptoutVerified: true,
          pmsetVerified: false,
          manualSleepOrLidExecution: false,
          isolatedUserData: store.directory,
        },
        null,
        2,
      ),
    );
    check(
      'catalog-input-rejection',
      await ui(
        `(async()=>{try{await window.cinema.getCatalog({provider:'cgv',requestId:'smoke',url:'https://example.com'});return false}catch{return true}})()`,
      ),
    );
    const invalid = await ui<boolean>(
      `(async()=>{try{await window.cinema.saveRule({provider:'cgv'});return false}catch{return true}})()`,
    );
    check('invalid-ipc-rejected', invalid);
    const badLink = await ui<boolean>(
      `(async()=>{try{await window.cinema.openBooking({provider:'cgv',url:'https://example.com'});return false}catch{return true}})()`,
    );
    check('external-url-rejected', badLink);
    await login.apply(true);
    check('mock-login-enabled-roundtrip', store.state.settings.shouldStartAtLogin);
    await login.apply(false);
    check('mock-login-optout-persisted', !store.state.settings.shouldStartAtLogin);
    const writes = loginWrites.length;
    await login.initialize();
    check(
      'mock-login-optout-reinitialize',
      loginWrites.length === writes && !store.state.settings.shouldStartAtLogin,
    );
    const native = app.getLoginItemSettings();
    check('native-login-read-only', typeof native.openAtLogin === 'boolean', {
      queried: true,
      realWrites: 0,
    });
    engine.suspend();
    check('injected-suspend', engine.snapshot().isSuspended);
    engine.resume();
    engine.resume();
    engine.setOnline(false);
    check('injected-offline', !engine.snapshot().isOnline);
    engine.setOnline(true);
    engine.setOnline(true);
    await engine.refresh();
    check('injected-resume-online', !engine.snapshot().isSuspended && engine.snapshot().isOnline);
    const isVisible = window.isVisible();
    toggleWindow();
    check('tray-toggle-hide', isVisible && !window.isVisible());
    toggleWindow();
    check('tray-toggle-show', window.isVisible());
    window.close();
    check('close-hides-process-survives', !window.isDestroyed() && !window.isVisible());
    app.emit('activate', {}, false);
    check('dock-activate-reopens-visible', window.isVisible(), { focused: window.isFocused() });
    showWindow({ x: 0, y: 0, width: 0, height: 0 });
    const electronScreen = (await import('electron')).screen;
    const cursorArea = electronScreen.getDisplayNearestPoint(
      electronScreen.getCursorScreenPoint(),
    ).workArea;
    const fallback = window.getBounds();
    check(
      'invalid-tray-cursor-safe-placement',
      fallback.x >= cursorArea.x &&
        fallback.y >= cursorArea.y &&
        fallback.x + fallback.width <= cursorArea.x + cursorArea.width &&
        fallback.y + fallback.height <= cursorArea.y + cursorArea.height,
      { fallback, cursorArea },
    );
    for (const area of [
      { x: -900, y: -314, width: 800, height: 500 },
      { x: -320, y: -400, width: 320, height: 180 },
    ]) {
      const placed = calculateWindowBounds(area);
      check(
        `small-work-area-${area.width}`,
        placed.x >= area.x &&
          placed.y >= area.y &&
          placed.x + placed.width <= area.x + area.width &&
          placed.y + placed.height <= area.y + area.height,
        { area, placed },
      );
    }
    window.hide();
    const second = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [...(app.isPackaged ? [] : [app.getAppPath()]), '--cinema-smoke'],
        {
          env: { ...process.env, CINEMA_SMOKE_SECONDARY: '1' },
          stdio: 'ignore',
        },
      );
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    check('single-instance-second-exits', second === 0);
    check('second-instance-reopens-window', window.isVisible(), { focused: window.isFocused() });
    const secondIdentity = JSON.parse(
      await readFile(path.join(output, 'smoke-secondary-identity.json'), 'utf8'),
    );
    check(
      'second-instance-verification-identity',
      secondIdentity.bundleId === identity.bundleId &&
        secondIdentity.executable === identity.executable &&
        secondIdentity.isolatedUserData === store.directory &&
        secondIdentity.codec === 'in-memory' &&
        secondIdentity.realSafeStorageCalls === 0 &&
        !secondIdentity.hasLock,
      secondIdentity,
    );
    check(
      'single-instance-keeps-one-window',
      (await import('electron')).BrowserWindow.getAllWindows().length === 1,
    );
    const icon = createTrayIcon();
    const bitmap = icon.toBitmap();
    const alphaPixels = [...bitmap].filter((value, index) => index % 4 === 3 && value > 0).length;
    check(
      'tray-valid-template-bitmap',
      !icon.isEmpty() &&
        (process.platform !== 'darwin' || icon.isTemplateImage()) &&
        alphaPixels > 0,
      { size: icon.getSize(), alphaPixels },
    );
    check('tray-CB-identity', process.platform !== 'darwin' || tray.getTitle() === 'CB');
    sampleTray();
    for (
      let i = 0;
      i < 100 &&
      process.platform === 'darwin' &&
      (app.dock?.isVisible() !== !traySamples.at(-1)!.intersectsMenuBar ||
        !!engine.snapshot().trayWarning !== !traySamples.at(-1)!.intersectsMenuBar);
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    const isPlaced = traySamples.at(-1)!.intersectsMenuBar;
    await writeFile(
      path.join(output, 'tray-diagnostics.json'),
      JSON.stringify(
        {
          samples: traySamples,
          dockVisible: app.dock?.isVisible(),
          actualMenuBarVisibility: 'unconfirmed',
          trayWarning: engine.snapshot().trayWarning,
        },
        null,
        2,
      ),
    );
    check(
      'dock-and-warning-match-tray-placement',
      process.platform !== 'darwin' ||
        (isPlaced
          ? !app.dock?.isVisible() && !engine.snapshot().trayWarning
          : app.dock?.isVisible() && !!engine.snapshot().trayWarning),
      { isPlaced, dockVisible: app.dock?.isVisible(), trayWarning: engine.snapshot().trayWarning },
    );
    check(
      'tray-visibility-warning-factual',
      process.platform !== 'darwin' || !!engine.snapshot().trayWarning === !isPlaced,
    );
    if (process.platform === 'darwin' && app.dock) {
      const dock = app.dock;
      const readBounds = tray.getBounds;
      const hideDock = dock.hide;
      const primary = electronScreen.getPrimaryDisplay();
      const validBounds = { x: primary.bounds.x + 10, y: primary.bounds.y, width: 62, height: 22 };
      const invalidBounds = { ...validBounds, y: primary.bounds.y + primary.bounds.height + 10 };
      const warningText = '메뉴 막대 아이콘 위치를 확인하지';
      const observations: unknown[] = [];
      let hideCalls = 0;
      const sampleFixture = (bounds: Rectangle) => {
        tray.getBounds = () => bounds;
        sampleTray();
        observations.push({
          bounds,
          dockVisible: dock.isVisible(),
          trayWarning: engine.snapshot().trayWarning,
        });
      };
      const waitForDock = async (name: string, visible: boolean) => {
        for (let i = 0; i < 100 && dock.isVisible() !== visible; i++)
          await new Promise((resolve) => setTimeout(resolve, 20));
        check(name, dock.isVisible() === visible, {
          syntheticGeometry: true,
          dockVisible: dock.isVisible(),
        });
      };
      try {
        dock.hide = () => {
          hideCalls++;
          hideDock.call(dock);
        };
        sampleFixture(validBounds);
        await waitFor(`!document.body.textContent.includes(${JSON.stringify(warningText)})`);
        await waitForDock('synthetic-valid-tray-clears-warning-and-hides-dock', false);
        sampleFixture(invalidBounds);
        await waitFor(`document.body.textContent.includes(${JSON.stringify(warningText)})`);
        await waitForDock('synthetic-invalid-tray-publishes-warning-and-shows-dock', true);
        sampleFixture(validBounds);
        await waitFor(`!document.body.textContent.includes(${JSON.stringify(warningText)})`);
        await waitForDock('synthetic-valid-tray-restores-hidden-dock', false);
        await dock.show();
        check('synthetic-external-dock-show-observed', dock.isVisible(), {
          syntheticGeometry: true,
        });
        hideCalls = 0;
        sampleFixture(validBounds);
        sampleFixture(validBounds);
        await waitForDock('stable-tray-new-dock-show-settles-hidden', false);
        sampleFixture(validBounds);
        check(
          'stable-tray-reconciles-new-dock-show-once',
          !dock.isVisible() && hideCalls === 1 && !engine.snapshot().trayWarning,
          { syntheticGeometry: true, hideCalls, dockVisible: dock.isVisible() },
        );
      } finally {
        tray.getBounds = readBounds;
        dock.hide = hideDock;
        sampleTray();
        await writeFile(
          path.join(output, 'tray-policy-fixture.json'),
          JSON.stringify(
            {
              syntheticGeometry: true,
              actualMenuBarVisibility: 'unconfirmed',
              engineEventsRequested: 0,
              observations,
              restoredNativeBounds: tray.getBounds(),
            },
            null,
            2,
          ),
        );
      }
      await waitForDock(
        'native-dock-policy-restored-after-fixture',
        !traySamples.at(-1)!.intersectsMenuBar,
      );
    }
    await engine.deleteRule(store.state.rules[0].id);
    await engine.setPaused(false);
    await ui(
      "Array.from(document.querySelectorAll('[role=tab]')).find(x=>x.textContent==='대시보드').click()",
    );
    await waitFor(
      "document.querySelector('[role=tab][aria-selected=true]').textContent==='대시보드'",
    );
    window.show();
    window.focus();
    await ui('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await new Promise((resolve) => setTimeout(resolve, 250));
    check(
      'capture-dom-is-current-dashboard',
      await ui(
        "document.querySelector('[role=tab][aria-selected=true]').textContent==='대시보드' && !!Array.from(document.querySelectorAll('button')).find(x=>x.textContent.includes('첫 감시 추가'))",
      ),
    );
    const fixtureSession = {
      provider: 'cgv' as const,
      showingId: 'popup-fixture',
      theaterId: '0013',
      theaterName: 'CGV 용산아이파크몰',
      movieId: 'fixture',
      movieTitle:
        '별의 영화 <img src="https://invalid.example/" onerror="globalThis.injected=true">',
      date: koreanToday(),
      time: '24:10',
      screen: 'IMAX관',
      format: 'IMAX' as const,
      isBookable: true,
      bookingUrl: 'https://cgv.co.kr/cnm/movieBook/movie',
    };
    const focusedBefore = window.isFocused();
    const popupSignal = new AbortController();
    const shown = await popups.notify(fixtureSession, popupSignal.signal);
    check(
      'owned-popup-actual-show',
      shown.kind === 'requested' && popups.windows.length === 1 && popups.windows[0].isVisible(),
    );
    const popup = popups.windows[0];
    const popupPreferences = popups.preferences;
    check(
      'popup-security-preferences',
      popupPreferences.sandbox &&
        popupPreferences.contextIsolation &&
        !popupPreferences.nodeIntegration &&
        !popupPreferences.preload &&
        popupPreferences.devTools === false,
    );
    check('popup-no-focus-steal', (!focusedBefore || window.isFocused()) && !popup.isFocused(), {
      focusedBefore,
      focusedAfter: window.isFocused(),
      popupFocused: popup.isFocused(),
    });
    const popupDom = await popup.webContents.executeJavaScript(
      `({ title: document.querySelector('h1').textContent, imageCount: document.querySelectorAll('img,script,iframe').length, injected: !!globalThis.injected, hasCapability: typeof require !== 'undefined' || typeof process !== 'undefined' || !!window.cinema, policy: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content })`,
    );
    check(
      'popup-escaped-no-capabilities',
      popupDom.title === fixtureSession.movieTitle &&
        popupDom.imageCount === 0 &&
        !popupDom.injected &&
        !popupDom.hasCapability &&
        popupDom.policy.includes("connect-src 'none'"),
    );
    check(
      'popup-window-open-denied',
      await popup.webContents.executeJavaScript("window.open('https://invalid.example/') === null"),
    );
    const popupImage = await popup.webContents.capturePage();
    await writeFile(path.join(output, 'popup.png'), popupImage.toPNG());
    check('popup-real-capture', !popupImage.isEmpty());
    for (let index = 0; index < 3; index++)
      await popups.notify(
        { ...fixtureSession, movieTitle: `상영 알림 ${index}` },
        new AbortController().signal,
      );
    check('popup-limit-three', popups.windows.length <= 3 && popup.isDestroyed());
    const area = (await import('electron')).screen.getPrimaryDisplay().workArea;
    check(
      'popup-within-work-area',
      popups.windows.every((item) => {
        const b = item.getBounds();
        return (
          b.x >= area.x &&
          b.y >= area.y &&
          b.x + b.width <= area.x + area.width &&
          b.y + b.height <= area.y + area.height
        );
      }),
    );
    const oldCount = popups.windows.length;
    popups.windows[0].close();
    for (let i = 0; i < 50 && popups.windows.length === oldCount; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    check('popup-native-dismiss', popups.windows.length === oldCount - 1);
    const aborted = new AbortController();
    aborted.abort();
    check(
      'popup-pre-abort-no-window',
      (await popups.notify(fixtureSession, aborted.signal)).kind === 'failed' &&
        popups.windows.length === oldCount - 1,
    );
    const cancel = new AbortController();
    await popups.notify(fixtureSession, cancel.signal);
    const cancelledWindow = popups.windows.at(-1)!;
    cancel.abort();
    check('popup-cancel-closes-window', cancelledWindow.isDestroyed());
    const failureStarted = Date.now();
    const loading = popups.notify(fixtureSession, new AbortController().signal);
    popups.windows.at(-1)!.destroy();
    check(
      'popup-load-failure-bounded',
      (await loading).kind === 'failed' && Date.now() - failureStarted < 2000,
    );
    await new Promise((resolve) => setTimeout(resolve, 8200));
    check('popup-auto-close-eight-seconds', popups.windows.length === 0);
    const primaryDisplay = electronScreen.getPrimaryDisplay();
    const readPrimary = electronScreen.getPrimaryDisplay;
    const readDisplays = electronScreen.getAllDisplays;
    const capacityEvidence: unknown[] = [];
    try {
      electronScreen.getPrimaryDisplay = () => ({
        ...primaryDisplay,
        workArea: { ...primaryDisplay.workArea, width: 400, height: 240 },
      });
      const single = await popups.notify(fixtureSession, new AbortController().signal);
      check(
        'popup-single-slot-full-readiness',
        single.kind === 'requested' && popups.windows.length === 1 && !popups.isReady(),
      );
      capacityEvidence.push({
        case: 'one-slot-full',
        isReady: popups.isReady(),
        windows: popups.windows.length,
      });
      for (const popup of popups.windows) popup.destroy();
      electronScreen.getPrimaryDisplay = () => ({
        ...primaryDisplay,
        workArea: { ...primaryDisplay.workArea, width: 200, height: 240 },
      });
      check(
        'popup-zero-slot-processes-unsupported',
        popups.isReady() &&
          (await popups.notify(fixtureSession, new AbortController().signal)).kind ===
            'unsupported' &&
          popups.windows.length === 0,
      );
      capacityEvidence.push({
        case: 'zero-slot',
        isReady: popups.isReady(),
        windows: popups.windows.length,
      });
      electronScreen.getAllDisplays = () => [];
      check(
        'popup-no-screen-processes-unsupported',
        popups.isReady() &&
          !popups.isSupported() &&
          (await popups.notify(fixtureSession, new AbortController().signal)).kind ===
            'unsupported',
      );
      capacityEvidence.push({
        case: 'no-screen',
        isReady: popups.isReady(),
        windows: popups.windows.length,
      });
    } finally {
      electronScreen.getPrimaryDisplay = readPrimary;
      electronScreen.getAllDisplays = readDisplays;
      for (const popup of popups.windows) popup.destroy();
    }
    await writeFile(
      path.join(output, 'popup-capacity.json'),
      JSON.stringify(
        {
          syntheticScreenGeometry: true,
          actualNativePopupForOneSlot: true,
          cases: capacityEvidence,
        },
        null,
        2,
      ),
    );
    const burstStore = new Store(path.join(store.directory, 'popup-burst'));
    await burstStore.load();
    const burstDate = koreanToday(Date.now() + 86400000);
    const burstSessions = ['18:00', '14:00', '12:00', '10:00'].map((time, index) => ({
      ...fixtureSession,
      movieTitle: 'Popup pacing fixture',
      movieId: 'burst',
      date: burstDate,
      time,
      format: '2D' as const,
      showingId: `burst-${index}`,
    }));
    await burstStore.mutate((state) => {
      state.rules = [
        {
          id: 'burst-rule',
          revision: 1,
          provider: 'cgv',
          theaterId: fixtureSession.theaterId,
          theaterName: fixtureSession.theaterName,
          movieId: 'burst',
          movieTitle: 'Popup pacing fixture',
          date: burstDate,
          format: '2D',
          isEnabled: true,
        },
      ];
    });
    let isReady = false;
    let providerCalls = 0;
    const burstEngine = new Engine(burstStore, engine.secrets, {
      providers: {
        cgv: async () => {
          providerCalls++;
          return burstSessions;
        },
        megabox: async () => [],
        lottecinema: async () => [],
      },
      deliver: async () => ({ kind: 'sent' }),
      notifyLocal: popups.notify,
      isLocalAlertSupported: popups.isSupported,
      isLocalAlertReady: () => isReady && popups.isReady(),
    });
    try {
      await burstEngine.refresh();
      check(
        'popup-full-readiness-preserves-queue',
        burstStore.state.localOutbox.length === 4 &&
          Object.values(burstStore.state.localDedupe).every((at) => at === 0) &&
          popups.windows.length === 0,
      );
      isReady = true;
      for (let i = 0; i < 200 && popups.windows.length === 0; i++)
        await new Promise((resolve) => setTimeout(resolve, 15));
      const first = popups.windows[0];
      check(
        'engine-popup-earliest-actually-first',
        first &&
          (await first.webContents.executeJavaScript('document.body.textContent')).includes(
            '10:00',
          ),
      );
      const firstShownAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const capacity = popups.windows.length;
      check(
        'engine-popup-capacity-queues-overflow',
        capacity >= 1 &&
          capacity <= 3 &&
          burstStore.state.localOutbox.length === 4 - capacity &&
          providerCalls === 1,
        { capacity, pending: burstStore.state.localOutbox.length, providerCalls },
      );
      await new Promise((resolve) => setTimeout(resolve, 6500));
      check(
        'engine-popup-earliest-survives-later-burst',
        !first.isDestroyed() && first.isVisible() && Date.now() - firstShownAt < 8000,
        { elapsed: Date.now() - firstShownAt },
      );
      await writeFile(
        path.join(output, 'popup-paced.png'),
        (await first.webContents.capturePage()).toPNG(),
      );
      for (let i = 0; i < 350 && burstStore.state.localOutbox.length; i++)
        await new Promise((resolve) => setTimeout(resolve, 30));
      check(
        'engine-popup-next-slot-drains-without-repoll',
        burstStore.state.localOutbox.length === 0 && providerCalls === 1 && first.isDestroyed(),
        {
          providerCalls,
          pending: burstStore.state.localOutbox.length,
          elapsed: Date.now() - firstShownAt,
        },
      );
      for (let i = 0; i < 100 && burstEngine.snapshot().isChecking; i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      check(
        'engine-popup-burst-completes-before-history-assertion',
        !burstEngine.snapshot().isChecking,
      );
      const deliveredTimes = burstStore.state.history
        .filter((item) => item.kind === 'localRequested')
        .map((item) => item.detail)
        .reverse();
      check(
        'engine-popup-all-four-attempted-once',
        deliveredTimes.length === 4 && deliveredTimes[0].includes('10:00'),
      );
      await writeFile(
        path.join(output, 'popup-paced.json'),
        JSON.stringify(
          {
            actualPopupWindows: true,
            realClock: true,
            mockProvider: true,
            capacity,
            firstShownAt,
            earliestSurvivedBeforeEightSeconds: true,
            firstDestroyedAfterLifetime: first.isDestroyed(),
            providerCalls,
            deliveredTimes,
            pending: burstStore.state.localOutbox.length,
            isolatedUserData: burstStore.directory,
          },
          null,
          2,
        ),
      );
    } finally {
      burstEngine.stop();
      for (const popup of popups.windows) popup.destroy();
    }
    for (const shouldNotifyEarliestOnly of [false, true]) {
      const dayStore = new Store(
        path.join(store.directory, `day-popup-${shouldNotifyEarliestOnly}`),
      );
      await dayStore.load();
      const date = koreanToday(Date.now() + 86400000);
      await dayStore.mutate((state) => {
        state.rules = [
          {
            id: 'day',
            revision: 1,
            provider: 'cgv',
            theaterId: fixtureSession.theaterId,
            theaterName: fixtureSession.theaterName,
            movieId: 'day',
            movieTitle: 'Date alert fixture',
            date,
            format: 'ALL',
            isEnabled: true,
            shouldNotifyEarliestOnly,
          },
        ];
      });
      let values = ['18:00', '10:00', '12:00'].map((time, index) => ({
        ...fixtureSession,
        date,
        time,
        movieId: 'day',
        movieTitle: 'Date alert fixture',
        showingId: `day-${index}`,
        format: index === 1 ? ('IMAX' as const) : ('2D' as const),
      }));
      const dayEngine = new Engine(dayStore, engine.secrets, {
        providers: {
          cgv: async () => values,
          megabox: async () => [],
          lottecinema: async () => [],
        },
        deliver: async () => {
          throw new Error('Unexpected Discord in isolated day popup');
        },
        notifyLocal: popups.notify,
        isLocalAlertReady: popups.isReady,
      });
      try {
        await dayEngine.refresh();
        check(
          `day-popup-one-native-${shouldNotifyEarliestOnly}`,
          popups.windows.length === 1 &&
            dayStore.state.history.filter((item) => item.kind === 'localRequested').length === 1,
        );
        const popup = popups.windows[0];
        const text = await popup.webContents.executeJavaScript('document.body.textContent');
        check(
          `day-popup-wording-${shouldNotifyEarliestOnly}`,
          text.includes(
            shouldNotifyEarliestOnly
              ? '가장 빠른 예매 가능 회차를 찾았어요'
              : '지정 날짜 예매가 열렸어요',
          ) &&
            text.includes('10:00') &&
            text.includes('IMAX'),
        );
        await writeFile(
          path.join(output, `day-popup-${shouldNotifyEarliestOnly}.png`),
          (await popup.webContents.capturePage()).toPNG(),
        );
        values = [{ ...values[0], showingId: 'new-earlier', time: '09:30' }];
        await dayEngine.refresh();
        check(
          `day-popup-no-repeat-${shouldNotifyEarliestOnly}`,
          popups.windows.length === 1 &&
            dayStore.state.history.filter((item) => item.kind === 'localRequested').length === 1 &&
            dayEngine.snapshot().earliestByRule?.day.session?.time === '09:30',
        );
        await writeFile(
          path.join(output, `day-popup-${shouldNotifyEarliestOnly}.json`),
          JSON.stringify(
            {
              text,
              history: dayStore.state.history,
              syntheticProvider: true,
              realNativePopup: true,
            },
            null,
            2,
          ),
        );
      } finally {
        dayEngine.stop();
        for (const popup of popups.windows) popup.destroy();
      }
    }
    await popups.notify(
      { ...fixtureSession, movieTitle: '종료 정리 검사' },
      new AbortController().signal,
    );
    const quittingPopups = [...popups.windows];
    popups.dispose();
    check(
      'popup-quit-cleanup',
      quittingPopups.every((item) => item.isDestroyed()) && popups.windows.length === 0,
    );
    await writeFile(
      path.join(output, 'popup-metadata.json'),
      JSON.stringify(
        {
          observedAt: new Date().toISOString(),
          focusedBefore,
          mainStillFocused: window.isFocused(),
          popupPreferences,
          popupDom,
          workArea: area,
          realOsNotificationWrites: 0,
          realDiscordSends: 0,
        },
        null,
        2,
      ),
    );
    await runUpdateSmoke();
    const image = await window.webContents.capturePage();
    await writeFile(path.join(output, 'desktop.png'), image.toPNG());
    check('capturePage-real-electron', !image.isEmpty(), image.getSize());
    check(
      'snapshot-no-plaintext-webhook',
      !JSON.stringify(engine.snapshot()).includes('/webhooks/'),
    );
    await writeFile(
      path.join(output, 'desktop-smoke.json'),
      JSON.stringify(
        {
          passed: true,
          isPackaged: app.isPackaged,
          platform: process.platform,
          isolatedUserData: store.directory,
          updateIsolation: smokeRuntime.updateIsolation,
          mockProviders: true,
          mockDiscord: true,
          realDiscordSends: 0,
          realOsNotificationWrites: 0,
          mockLoginWrites: loginWrites,
          realLoginWrites: 0,
          nativeLoginReadOnly: true,
          identity,
          secondIdentity,
          secretCodec: smokeRuntime.codecEvidence,
          realSafeStorageCalls: 0,
          realSleepRebootLoginTested: false,
          actions,
          snapshot: engine.snapshot(),
        },
        null,
        2,
      ),
    );
    engine.stop();
    app.quit();
  } catch (error) {
    await mkdir(output, { recursive: true });
    await writeFile(
      path.join(output, 'desktop-smoke.json'),
      JSON.stringify(
        { passed: false, actions, error: error instanceof Error ? error.message : 'Smoke failed' },
        null,
        2,
      ),
    );
    app.exit(1);
  }
}

export const smokeCatalogFetch: Fetcher = async (url) => {
  if (url.includes('searchRegnList'))
    return Response.json({
      statusCode: 0,
      data: [
        {
          regnGrpCd: '01',
          regnGrpNm: '서울',
          siteList: [{ siteNo: '0013', siteNm: '용산아이파크몰' }],
        },
        {
          regnGrpCd: '02',
          regnGrpNm: '경기',
          siteList: [{ siteNo: '0056', siteNm: '스모크 경기' }],
        },
      ],
    });
  if (url.includes('searchAtktTopPostrList'))
    return Response.json({
      statusCode: 0,
      data: [
        { movNo: '30001367', movNm: '극장판 치이카와-인어 섬의 비밀', i320Fnm: '30001367_320.jpg' },
        { movNo: '30001450', movNm: '실낙원' },
      ],
    });
  throw new Error('Unexpected smoke catalog endpoint');
};

export const smokePosterFetch: Fetcher = async (url) => {
  assert.equal(
    url,
    'https://cdn.cgv.co.kr/cgvpomsfilm/Movie/Thumbnail/Poster/030001/30001367/30001367_320.jpg',
  );
  return new Response(new Uint8Array(createTrayIcon().toPNG()), {
    headers: { 'content-type': 'image/png' },
  });
};
