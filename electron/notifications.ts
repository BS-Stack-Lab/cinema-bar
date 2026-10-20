import { BrowserWindow, screen, type WebPreferences } from 'electron';
import type { LocalAlertResult, Session } from './types.js';
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/gu,
    (letter) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[letter]!,
  );
export function popupHtml(session: Session) {
  return `<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>Cinema Bar 알림</title><style>html{background:#262628;color:#eee9ff;font:14px -apple-system,BlinkMacSystemFont,sans-serif}body{margin:0;padding:36px 20px 16px;border-left:4px solid #c5b5fc}small{color:#c5b5fc;font-size:10px;letter-spacing:1.5px}h1{font-size:18px;margin:8px 0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}p{margin:5px 0;color:#d6d0df;font-size:12px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}</style></head><body><small>CINEMA BAR · 새 예매 가능 상영</small><h1>${escapeHtml(session.movieTitle.slice(0, 120))}</h1><p>${escapeHtml(session.theaterName.slice(0, 80))} · ${escapeHtml(session.screen.slice(0, 80))}</p><p>${escapeHtml(session.date)} ${escapeHtml(session.time)} (한국) · ${escapeHtml(session.format)}</p></body></html>`;
}
export class PopupAlerts {
  private entries: { window: BrowserWindow; timer?: ReturnType<typeof setTimeout> }[] = [];
  private isDisposed = false;
  readonly preferences: WebPreferences = {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    devTools: false,
    backgroundThrottling: false,
    partition: 'cinema-popup',
  };
  constructor() {
    screen.on('display-metrics-changed', this.onDisplayChanged);
    screen.on('display-removed', this.onDisplayChanged);
  }
  private onDisplayChanged = () => this.arrange();
  get windows() {
    return this.entries.map((entry) => entry.window);
  }
  isSupported = () => !this.isDisposed && screen.getAllDisplays().length > 0;
  private arrange() {
    if (this.isDisposed) return;
    if (!screen.getAllDisplays().length) {
      while (this.entries.length) this.evictOldest();
      return;
    }
    const area = screen.getPrimaryDisplay().workArea;
    const height = Math.min(164, area.height - 32);
    const limit =
      area.width < 240 || height < 120
        ? 0
        : Math.max(1, Math.min(3, Math.floor((area.height - 20) / (height + 12))));
    while (this.entries.length > limit) this.evictOldest();
    this.entries.forEach(({ window }, index) => {
      window.setSize(Math.min(360, area.width - 32), height);
      const size = window.getBounds();
      window.setPosition(
        area.x + Math.max(0, area.width - size.width - 16),
        area.y + 16 + index * (size.height + 12),
      );
    });
  }
  private evictOldest() {
    const entry = this.entries.shift();
    if (entry) {
      clearTimeout(entry.timer);
      if (!entry.window.isDestroyed()) entry.window.destroy();
    }
  }
  notify = async (session: Session, signal: AbortSignal): Promise<LocalAlertResult> => {
    if (signal.aborted) return { kind: 'failed', detail: '표시 취소' };
    if (!this.isSupported()) return { kind: 'unsupported' };
    const area = screen.getPrimaryDisplay().workArea;
    const height = Math.min(164, area.height - 32);
    if (area.width < 240 || height < 120) return { kind: 'unsupported' };
    const limit = Math.max(1, Math.min(3, Math.floor((area.height - 20) / (height + 12))));
    while (this.entries.length >= limit) this.evictOldest();
    let popup: BrowserWindow;
    try {
      popup = new BrowserWindow({
        width: Math.min(360, area.width - 32),
        height,
        show: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        focusable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        title: 'Cinema Bar 알림',
        titleBarStyle: 'hiddenInset',
        backgroundColor: '#262628',
        webPreferences: this.preferences,
      });
    } catch {
      return { kind: 'failed' };
    }
    const entry: { window: BrowserWindow; timer?: ReturnType<typeof setTimeout> } = {
      window: popup,
    };
    this.entries.push(entry);
    popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    popup.webContents.on('will-navigate', (event) => event.preventDefault());
    popup.webContents.on('will-attach-webview', (event) => event.preventDefault());
    popup.on('closed', () => {
      clearTimeout(entry.timer);
      this.entries = this.entries.filter((item) => item !== entry);
      signal.removeEventListener('abort', cancel);
      if (!this.isDisposed) this.arrange();
    });
    const cancel = () => {
      if (!popup.isDestroyed()) popup.destroy();
    };
    signal.addEventListener('abort', cancel, { once: true });
    this.arrange();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      popup
        .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(popupHtml(session))}`)
        .then((): LocalAlertResult => {
          if (signal.aborted || this.isDisposed || popup.isDestroyed()) return { kind: 'failed' };
          popup.showInactive();
          entry.timer = setTimeout(cancel, 8000);
          return { kind: 'requested' };
        })
        .catch((): LocalAlertResult => ({ kind: 'failed' })),
      new Promise<LocalAlertResult>((resolve) => {
        deadline = setTimeout(() => resolve({ kind: 'failed' }), 1900);
      }),
    ]);
    clearTimeout(deadline);
    if (result.kind !== 'requested') cancel();
    return result;
  };
  dispose() {
    this.isDisposed = true;
    screen.removeListener('display-metrics-changed', this.onDisplayChanged);
    screen.removeListener('display-removed', this.onDisplayChanged);
    for (const entry of [...this.entries]) {
      clearTimeout(entry.timer);
      entry.window.destroy();
    }
    this.entries = [];
  }
}
