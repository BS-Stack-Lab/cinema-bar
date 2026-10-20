import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  safeStorage,
  powerMonitor,
  screen,
  shell,
  net,
} from 'electron';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { SecretStore } from './secretStore.js';
import { Engine } from './engine.js';
import { LoginSettings } from './lifecycle.js';
import { createTrayIcon } from './trayIcon.js';
import { createProviders } from './providers/index.js';
import { createCgvTransport } from './cgvTransport.js';
import { PopupAlerts } from './notifications.js';
import { createDiscord } from './discord.js';
import { CatalogService } from './catalog.js';
import { validateIpc, validateSender } from './ipc.js';
import type { CatalogRequest, Provider, RuleInput } from './types.js';
const directory = path.dirname(fileURLToPath(import.meta.url));
const isSmoke = process.env.CINEMA_SMOKE === '1' && process.argv.includes('--cinema-smoke');
if (isSmoke) {
  const profile = process.env.CINEMA_SMOKE_PROFILE;
  if (!profile || !path.resolve(profile).startsWith(`${os.tmpdir()}${path.sep}`))
    throw new Error('Smoke profile must be isolated in the temporary directory.');
  app.setPath('userData', profile);
}
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
let window: BrowserWindow;
let tray: Tray;
let engine: Engine;
let popups: PopupAlerts;
let catalog: CatalogService;
const traySamples: unknown[] = [];
let isQuitting = false;
let pageUrl = '';
function trayAtMenuBar(bounds: Electron.Rectangle) {
  return (
    bounds.width > 0 &&
    bounds.height > 0 &&
    screen.getAllDisplays().some((display) => {
      const topHeight = Math.max(24, display.workArea.y - display.bounds.y);
      return (
        bounds.x < display.bounds.x + display.bounds.width &&
        bounds.x + bounds.width > display.bounds.x &&
        bounds.y < display.bounds.y + topHeight &&
        bounds.y + bounds.height > display.bounds.y
      );
    })
  );
}
function calculateWindowBounds(area: Electron.Rectangle, anchor?: Electron.Rectangle) {
  const width = Math.min(440, area.width);
  const height = Math.min(740, Math.max(1, area.height - 24));
  const x = anchor ? anchor.x - width / 2 : area.x + (area.width - width) / 2;
  const y =
    anchor && process.platform !== 'darwin' ? area.y + area.height - height - 8 : area.y + 8;
  return {
    x: Math.round(Math.max(area.x, Math.min(x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - height))),
    width,
    height,
  };
}
function showWindow(trayBounds = tray?.getBounds()) {
  if (!window || window.isDestroyed()) return;
  sampleTray();
  const hasAnchor = trayBounds && trayAtMenuBar(trayBounds);
  const display = hasAnchor
    ? screen.getDisplayMatching(trayBounds)
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  window.setMinimumSize(Math.min(340, area.width), 0);
  window.setBounds(calculateWindowBounds(area, hasAnchor ? trayBounds : undefined));
  window.show();
  window.focus();
}
function toggleWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isVisible()) window.hide();
  else showWindow();
}
function sampleTray() {
  if (!tray || tray.isDestroyed()) return;
  const bounds = tray.getBounds();
  traySamples.push({
    at: Date.now(),
    bounds,
    intersectsMenuBar: trayAtMenuBar(bounds),
    displays: screen
      .getAllDisplays()
      .map(({ id, bounds, workArea, scaleFactor }) => ({ id, bounds, workArea, scaleFactor })),
  });
  if (traySamples.length > 8) traySamples.shift();
}
app.on('activate', () => showWindow());
app.on('second-instance', () => showWindow());
app.on('before-quit', () => {
  isQuitting = true;
  engine?.stop();
  popups?.dispose();
  catalog?.dispose();
});
app.on('window-all-closed', () => undefined);
if (hasLock)
  void app
    .whenReady()
    .then(async () => {
      if (process.platform === 'darwin') {
        app.setActivationPolicy('regular');
        await app.dock?.show();
      }
      const store = new Store(app.getPath('userData'));
      await store.load();
      const secrets = new SecretStore({
        isAvailable: () =>
          safeStorage.isEncryptionAvailable() &&
          (process.platform !== 'linux' ||
            safeStorage.getSelectedStorageBackend() !== 'basic_text'),
        encrypt: (value) => safeStorage.encryptString(value),
        decrypt: (value) => safeStorage.decryptString(value),
      });
      let mockLogin = false;
      const loginWrites: boolean[] = [];
      const login = new LoginSettings(
        isSmoke
          ? {
              isPackaged: true,
              set: (value) => {
                mockLogin = value;
                loginWrites.push(value);
              },
              get: () => mockLogin,
            }
          : {
              isPackaged: app.isPackaged,
              set: (value) => app.setLoginItemSettings({ openAtLogin: value }),
              get: () => app.getLoginItemSettings().openAtLogin,
            },
        store,
      );
      const cgvTransport = createCgvTransport();
      const providers = createProviders(fetch, cgvTransport);
      const catalogFetch = isSmoke ? (await import('./smoke.js')).smokeCatalogFetch : fetch;
      catalog = new CatalogService(catalogFetch, isSmoke ? catalogFetch : cgvTransport);
      popups = new PopupAlerts();
      engine = new Engine(
        store,
        secrets,
        isSmoke
          ? {
              providers: {
                cgv: async () => [],
                megabox: async () => [],
                lottecinema: async () => [],
              },
              deliver: async () => ({ kind: 'sent' }),
              notifyLocal: async () => ({ kind: 'requested' }),
              isLocalAlertSupported: popups.isSupported,
            }
          : {
              providers,
              deliver: createDiscord(),
              notifyLocal: popups.notify,
              isLocalAlertSupported: popups.isSupported,
            },
      );
      if (process.platform === 'darwin')
        engine.trayWarning =
          '메뉴 막대 아이콘 표시를 확인하지 못했어요. Dock의 Cinema Bar에서 다시 열 수 있어요. macOS 시스템 설정 → 메뉴 막대의 표시 허용 목록을 확인하세요. 항목이 없으면 Dock을 이용하세요.';
      try {
        await login.initialize();
      } catch {
        engine.loginWarning =
          '로그인 자동 시작을 적용하지 못했어요. 설정에서 다시 선택하거나 OS 로그인 항목을 확인하세요.';
      }
      const workArea = screen.getPrimaryDisplay().workArea;
      const securityPreferences = {
        preload: path.join(directory, 'preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: !isSmoke,
        devTools: !app.isPackaged,
      };
      window = new BrowserWindow({
        width: 440,
        height: Math.min(740, workArea.height - 24),
        minWidth: 340,
        show: false,
        frame: false,
        resizable: false,
        alwaysOnTop: true,
        backgroundColor: '#262628',
        webPreferences: securityPreferences,
      });
      pageUrl = new URL('../dist/index.html', import.meta.url).href;
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event) => {
        event.preventDefault();
      });
      window.webContents.on('will-attach-webview', (event) => event.preventDefault());
      window.on('close', (event) => {
        if (!isQuitting) {
          event.preventDefault();
          window.hide();
        }
      });
      if (!isSmoke) window.on('blur', () => window.hide());
      const icon = createTrayIcon();
      tray = new Tray(icon, '8eb79195-4284-4aa7-86f5-80d3c029fdbd');
      if (process.platform === 'darwin') tray.setTitle('CB');
      sampleTray();
      const trayTimer = setTimeout(sampleTray, 750);
      trayTimer.unref();
      window.on('closed', () => catalog.dispose());
      const onDisplayChange = () => {
        sampleTray();
        if (window && !window.isDestroyed() && window.isVisible()) showWindow();
      };
      screen.on('display-added', onDisplayChange);
      screen.on('display-removed', onDisplayChange);
      screen.on('display-metrics-changed', onDisplayChange);
      tray.setToolTip('Cinema Bar · 나만의 상영 레이더');
      tray.on('click', toggleWindow);
      tray.on('right-click', () =>
        tray.popUpContextMenu(
          Menu.buildFromTemplate([
            { label: 'Cinema Bar 열기', click: () => showWindow() },
            { label: '앱 종료', click: () => app.quit() },
          ]),
        ),
      );
      engine.subscribe(() => {
        if (!window.isDestroyed()) window.webContents.send('cinema:snapshot', engine.snapshot());
      });
      for (const channel of [
        'getCatalog',
        'cancelCatalog',
        'getSnapshot',
        'saveRule',
        'deleteRule',
        'setPaused',
        'saveWebhook',
        'deleteWebhook',
        'updateSettings',
        'refresh',
        'openBooking',
        'recoverStorage',
        'quit',
        'networkChanged',
      ])
        ipcMain.handle(`cinema:${channel}`, async (event, payload: unknown) => {
          validateSender(
            event.senderFrame,
            window.webContents.mainFrame,
            event.senderFrame?.url ?? '',
            pageUrl,
          );
          const value = validateIpc(channel, payload);
          switch (channel) {
            case 'getCatalog':
              return catalog.get(value as CatalogRequest);
            case 'cancelCatalog':
              catalog.cancel((value as { requestId: string }).requestId);
              return;
            case 'getSnapshot':
              return engine.snapshot();
            case 'saveRule':
              return engine.saveRule(value as RuleInput);
            case 'deleteRule':
              return engine.deleteRule(value as string);
            case 'setPaused':
              return engine.setPaused(value as boolean);
            case 'saveWebhook':
              return engine.saveWebhook(value as string);
            case 'deleteWebhook':
              return engine.deleteWebhook();
            case 'updateSettings': {
              const settings = value as {
                intervalSeconds?: number;
                shouldStartAtLogin?: boolean;
                shouldNotifyLocally?: boolean;
              };
              if (settings.shouldStartAtLogin !== undefined) {
                await login.apply(settings.shouldStartAtLogin);
                engine.loginWarning = undefined;
              }
              return engine.updateSettings(settings);
            }
            case 'refresh':
              return engine.refresh();
            case 'openBooking':
              await shell.openExternal((value as { provider: Provider; url: string }).url);
              return;
            case 'recoverStorage':
              return engine.recover();
            case 'networkChanged':
              engine.setOnline(net.isOnline());
              return;
            case 'quit':
              app.quit();
              return;
          }
        });
      powerMonitor.on('suspend', () => engine.suspend());
      powerMonitor.on('resume', () => engine.resume());
      await window.loadURL(pageUrl);
      engine.setOnline(net.isOnline());
      engine.start();
      if (isSmoke) {
        window.show();
        const { runSmoke } = await import('./smoke.js');
        await runSmoke({
          app,
          window,
          tray,
          toggleWindow,
          showWindow,
          traySamples,
          calculateWindowBounds,
          sampleTray,
          engine,
          store,
          login,
          loginWrites,
          securityPreferences,
          popups,
        });
      } else showWindow();
    })
    .catch(() => {
      process.stderr.write('Cinema Bar 시작에 실패했습니다. 앱 저장소와 OS 권한을 확인하세요.\n');
      app.exit(1);
    });
