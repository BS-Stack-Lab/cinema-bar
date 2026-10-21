import { isRuleEligible } from './eligibility.js';
import type { Rule, Settings } from './types.js';
export interface PowerState {
  settings: Settings;
  rules: Rule[];
  isStarted: boolean;
  isOnline: boolean;
  isSuspended: boolean;
  recoveryError?: string;
}
export interface PowerAdapter {
  start(type: 'prevent-app-suspension'): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}
export class PowerPolicy {
  private id?: number;
  private timer?: ReturnType<typeof setTimeout>;
  private isDisposed = false;
  private current = { isKeepingAwake: false, keepAwakeWarning: undefined as string | undefined };
  constructor(
    private adapter: PowerAdapter,
    private read: () => PowerState,
    private publish: (state: { isKeepingAwake: boolean; keepAwakeWarning?: string }) => void,
    private now: () => number = Date.now,
  ) {}
  get blockerId() {
    return this.id;
  }
  reconcile = () => {
    if (this.isDisposed) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const state = this.read();
    const isEligible =
      state.settings.shouldKeepAwake === true &&
      state.isStarted &&
      state.isOnline &&
      !state.isSuspended &&
      !state.settings.isPaused &&
      !state.recoveryError &&
      state.rules.some((rule) => isRuleEligible(rule, this.now()));
    let isKeepingAwake = false;
    let keepAwakeWarning: string | undefined;
    try {
      if (this.id !== undefined && !this.adapter.isStarted(this.id)) this.id = undefined;
      if (isEligible && this.id === undefined)
        this.id = this.adapter.start('prevent-app-suspension');
      if (!isEligible && this.id !== undefined) {
        this.adapter.stop(this.id);
        if (this.adapter.isStarted(this.id)) throw new Error('blocker remains active');
        this.id = undefined;
      }
      isKeepingAwake = this.id !== undefined && this.adapter.isStarted(this.id);
      if (isEligible && !isKeepingAwake) throw new Error('blocker not active');
    } catch {
      isKeepingAwake = this.id !== undefined && this.safeIsStarted(this.id);
      keepAwakeWarning = '자동 잠자기 방지를 적용하지 못했어요. 전원 설정을 확인하세요.';
    }
    this.update(isKeepingAwake, keepAwakeWarning);
    if (state.settings.shouldKeepAwake === true || this.id !== undefined) {
      this.timer = setTimeout(this.reconcile, 60000);
      this.timer.unref?.();
    }
  };
  private safeIsStarted(id: number) {
    try {
      return this.adapter.isStarted(id);
    } catch {
      return false;
    }
  }
  private update(isKeepingAwake: boolean, keepAwakeWarning?: string) {
    if (
      this.current.isKeepingAwake === isKeepingAwake &&
      this.current.keepAwakeWarning === keepAwakeWarning
    )
      return;
    this.current = { isKeepingAwake, keepAwakeWarning };
    this.publish(this.current);
  }
  dispose() {
    if (this.isDisposed) return;
    this.isDisposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.id !== undefined) {
      try {
        this.adapter.stop(this.id);
      } catch {
        this.update(false, '자동 잠자기 방지 해제를 확인하지 못했어요.');
      }
      this.id = undefined;
    }
    this.update(false);
  }
}
