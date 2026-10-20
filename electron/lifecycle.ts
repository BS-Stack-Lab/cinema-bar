import type { Store } from './store.js';
export interface LoginAdapter {
  isPackaged: boolean;
  set(value: boolean): void;
  get(): boolean;
}
export class LoginSettings {
  constructor(
    private adapter: LoginAdapter,
    private store: Store,
  ) {}
  async initialize() {
    if (!this.adapter.isPackaged || this.store.recoveryError) return;
    if (!this.store.state.settings.hasConfiguredLogin) await this.apply(true);
  }
  async apply(value: boolean) {
    if (this.adapter.isPackaged) {
      this.adapter.set(value);
      if (this.adapter.get() !== value) throw new Error('OS 로그인 시작 설정을 확인하세요.');
    }
    await this.store.mutate((s) => {
      s.settings.shouldStartAtLogin = value;
      s.settings.hasConfiguredLogin = true;
    });
  }
}
