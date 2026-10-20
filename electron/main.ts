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
import { validateIpc, validateSender } from './ipc.js';
import type { Provider, RuleInput } from './types.js';
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
let isQuitting = false;
let pageUrl = '';
function toggleWindow() {
  if (window.isVisible()) window.hide();
  else {
    const trayBounds = tray.getBounds();
    const bounds = screen.getDisplayMatching(trayBounds).workArea;
    const size = window.getBounds();
    window.setPosition(
      Math.max(
        bounds.x,
        Math.min(trayBounds.x - size.width / 2, bounds.x + bounds.width - size.width),
      ),
      process.platform === 'darwin'
        ? bounds.y + 8
        : Math.max(bounds.y, bounds.y + bounds.height - size.height - 8),
    );
    window.show();
    window.focus();
  }
}
app.on('second-instance', () => {
  if (window) {
    window.show();
    window.focus();
  }
});
app.on('before-quit', () => {
  isQuitting = true;
  engine?.stop();
  popups?.dispose();
});
app.on('window-all-closed', () => undefined);
if (hasLock)
  void app
    .whenReady()
    .then(async () => {
      if (process.platform === 'darwin') app.dock?.hide();
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
      const providers = createProviders(fetch, createCgvTransport());
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
      tray = new Tray(icon);
      tray.setToolTip('Cinema Bar · 나만의 상영 레이더');
      tray.on('click', toggleWindow);
      tray.on('right-click', () =>
        tray.popUpContextMenu(
          Menu.buildFromTemplate([
            { label: 'Cinema Bar 열기', click: () => window.show() },
            { label: '앱 종료', click: () => app.quit() },
          ]),
        ),
      );
      engine.subscribe(() => {
        if (!window.isDestroyed()) window.webContents.send('cinema:snapshot', engine.snapshot());
      });
      for (const channel of [
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
          engine,
          store,
          login,
          loginWrites,
          securityPreferences,
          popups,
        });
      } else toggleWindow();
    })
    .catch(() => {
      process.stderr.write('Cinema Bar 시작에 실패했습니다. 앱 저장소와 OS 권한을 확인하세요.\n');
      app.exit(1);
    });
