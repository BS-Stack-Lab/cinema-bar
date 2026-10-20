import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import type { App, BrowserWindow, Tray, WebPreferences } from 'electron';
import type { Engine } from './engine.js';
import type { Store } from './store.js';
import type { LoginSettings } from './lifecycle.js';
import { koreanToday } from './validation.js';
interface SmokeContext {
  app: App;
  window: BrowserWindow;
  tray: Tray;
  toggleWindow(): void;
  engine: Engine;
  store: Store;
  login: LoginSettings;
  loginWrites: boolean[];
  securityPreferences: WebPreferences;
}
export async function runSmoke({
  app,
  window,
  toggleWindow,
  engine,
  store,
  login,
  loginWrites,
  securityPreferences,
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
        'typeof require === "undefined" && typeof process === "undefined" && !window.cinema.invoke && !window.cinema.ipcRenderer && Object.keys(window.cinema).length===12',
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
    await waitFor('!!document.querySelector(\'input[aria-label="극장 ID"]\')');
    await ui(
      `(() => { const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; for(const [name,value] of Object.entries({'극장 ID':'1372','극장 이름':'스모크 극장','작품 제목':'스모크 영화','상영일':${JSON.stringify(koreanToday())}})){const input=document.querySelector('input[aria-label="'+name+'"]'); setter.call(input,value); input.dispatchEvent(new Event('input',{bubbles:true}));} })()`,
    );
    await ui("document.querySelector('form').requestSubmit()");
    await waitFor('!document.querySelector(\'input[aria-label="극장 ID"]\')');
    check(
      'ui-rule-form-save',
      store.state.rules.length === 1 && store.state.rules[0].movieTitle === '스모크 영화',
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
    window.show();
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
