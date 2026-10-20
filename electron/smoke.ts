import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import type { App, BrowserWindow, Tray, WebPreferences, Rectangle } from 'electron';
import type { Engine } from './engine.js';
import type { Store } from './store.js';
import { PopupAlerts } from './notifications.js';
import type { LoginSettings } from './lifecycle.js';
import type { Fetcher } from './providers/index.js';
import { createTrayIcon } from './trayIcon.js';
import { koreanToday } from './validation.js';
interface SmokeContext {
  app: App;
  window: BrowserWindow;
  tray: Tray;
  toggleWindow(): void;
  showWindow(bounds?: Rectangle): void;
  sampleTray(): void;
  traySamples: unknown[];
  calculateWindowBounds(area: Rectangle, anchor?: Rectangle): Rectangle;
  engine: Engine;
  store: Store;
  login: LoginSettings;
  loginWrites: boolean[];
  securityPreferences: WebPreferences;
  popups: PopupAlerts;
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
}: SmokeContext) {
  const output = process.env.CINEMA_SMOKE_OUTPUT!;
  const actions: { name: string; passed: boolean; detail?: unknown }[] = [];
  const check = (name: string, condition: unknown, detail?: unknown) => {
    assert.ok(condition, name);
    actions.push({ name, passed: true, detail });
  };
  const ui = <T>(code: string): Promise<T> => window.webContents.executeJavaScript(code, true);
  const waitFor = async (code: string) => {
    for (let i = 0; i < 100; i++) {
      if (await ui<boolean>(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`UI condition did not settle: ${code}`);
  };
  try {
    await mkdir(output, { recursive: true });
    await waitFor('!!document.querySelector("[role=tab]")');
    check(
      'actual-renderer-mounted',
      await ui('document.querySelector("h1").textContent.includes("Cinema Bar")'),
    );
    const prefs = securityPreferences;
    check(
      'sandbox-contextIsolation-nodeIntegration',
      prefs.sandbox && prefs.contextIsolation && !prefs.nodeIntegration,
    );
    check(
      'renderer-narrow-api',
      await ui(
        'typeof require === "undefined" && typeof process === "undefined" && !window.cinema.invoke && !window.cinema.ipcRenderer && Object.keys(window.cinema).length===14',
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
    await ui("document.querySelector('form').requestSubmit()");
    await waitFor('!document.querySelector(\'select[aria-label="지역"]\')');
    check(
      'ui-rule-form-save',
      store.state.rules.length === 1 &&
        store.state.rules[0].movieId === '30001367' &&
        store.state.rules[0].theaterId === '0013',
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
    check('dock-activate-reopens-focus', window.isVisible() && window.isFocused());
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
    const second = await new Promise<number | null>((resolve) => {
      const child = spawn(
        process.execPath,
        [...(app.isPackaged ? [] : [app.getAppPath()]), '--cinema-smoke'],
        {
          env: process.env,
          stdio: 'ignore',
        },
      );
      child.on('exit', resolve);
    });
    check('single-instance-second-exits', second === 0);
    check('second-instance-reopens-window', window.isVisible());
    const icon = createTrayIcon();
    const bitmap = icon.toBitmap();
    const alphaPixels = [...bitmap].filter((value, index) => index % 4 === 3 && value > 0).length;
    check(
      'tray-valid-template-bitmap',
      !icon.isEmpty() && icon.isTemplateImage() && alphaPixels > 0,
      { size: icon.getSize(), alphaPixels },
    );
    check('dock-visible', process.platform !== 'darwin' || app.dock?.isVisible());
    check('tray-CB-identity', process.platform !== 'darwin' || tray.getTitle() === 'CB');
    sampleTray();
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
      'tray-visibility-warning-factual',
      process.platform !== 'darwin' || !!engine.snapshot().trayWarning,
    );
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
    check('popup-no-focus-steal', focusedBefore && window.isFocused() && !popup.isFocused());
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
          mockProviders: true,
          mockDiscord: true,
          realDiscordSends: 0,
          realOsNotificationWrites: 0,
          mockLoginWrites: loginWrites,
          realLoginWrites: 0,
          nativeLoginReadOnly: true,
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
        { movNo: '30001367', movNm: '극장판 치이카와-인어 섬의 비밀' },
        { movNo: '30001450', movNm: '실낙원' },
      ],
    });
  throw new Error('Unexpected smoke catalog endpoint');
};
