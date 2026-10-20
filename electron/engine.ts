import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { SecretStore } from './secretStore.js';
import { eligibleSessions, ProviderError, type ProviderAdapter } from './providers/index.js';
import {
  sessionIdentity,
  validateRule,
  validateSettings,
  text,
  koreanToday,
} from './validation.js';
import type { DeliveryResult } from './discord.js';
import type { HistoryItem, Provider, RuleInput, Session, Snapshot, State } from './types.js';
const MAX_AGE = 24 * 60 * 60 * 1000;
export interface EngineDependencies {
  providers: Record<Provider, ProviderAdapter>;
  deliver: (url: string, session: Session, signal: AbortSignal) => Promise<DeliveryResult>;
  now?: () => number;
  random?: () => number;
}
export class Engine {
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private controller?: AbortController;
  private needsRefresh = false;
  private shouldForce = false;
  private isStopped = false;
  loginWarning?: string;
  private listeners = new Set<() => void>();
  isOnline = true;
  isSuspended = false;
  constructor(
    readonly store: Store,
    readonly secrets: SecretStore,
    private dependencies: EngineDependencies,
  ) {}
  private now() {
    return (this.dependencies.now ?? Date.now)();
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit() {
    this.listeners.forEach((listener) => listener());
  }
  snapshot(): Snapshot {
    const s = this.store.state;
    return {
      rules: s.rules,
      settings: s.settings,
      progress: Object.fromEntries(
        Object.entries(s.progress).map(([key, value]) => {
          const { baseline: _baseline, ...progress } = value;
          void _baseline;
          return [key, progress];
        }),
      ),
      history: s.history,
      pendingCount: s.outbox.length,
      hasWebhook: !!s.secret.encrypted,
      isWebhookBlocked: s.secret.isTerminal,
      isEncryptionAvailable: this.secrets.isAvailable(),
      isOnline: this.isOnline,
      isSuspended: this.isSuspended,
      isChecking: !!this.running,
      nextAt: this.nextDeadline(),
      recoveryError: this.store.recoveryError,
      loginWarning: this.loginWarning,
      storagePath: this.store.directory,
    };
  }
  private canRun() {
    return (
      !this.isStopped &&
      !this.isSuspended &&
      this.isOnline &&
      !this.store.state.settings.isPaused &&
      !this.store.recoveryError
    );
  }
  private invalidate() {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    this.needsRefresh = false;
  }
  stop() {
    this.isStopped = true;
    this.invalidate();
    this.emit();
  }
  suspend() {
    this.isSuspended = true;
    this.invalidate();
    this.emit();
  }
  resume() {
    if (!this.isSuspended) return;
    this.isSuspended = false;
    this.wake(true);
  }
  setOnline(value: boolean) {
    if (value === this.isOnline) return;
    this.isOnline = value;
    if (!value) this.invalidate();
    else this.wake(true);
    this.emit();
  }
  start() {
    this.isStopped = false;
    this.wake(false);
  }
  private wake(force: boolean) {
    this.shouldForce ||= force;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.canRun()) {
      this.emit();
      return;
    }
    if (this.running) {
      this.needsRefresh = true;
      return;
    }
    void this.tick().catch(() => {
      this.emit();
      this.schedule();
    });
  }
  async refresh() {
    if (!this.canRun()) return this.snapshot();
    if (this.running) {
      await this.running;
      return this.snapshot();
    }
    this.shouldForce = true;
    await this.tick();
    return this.snapshot();
  }
  async saveRule(input: RuleInput) {
    const value = validateRule(input);
    this.invalidate();
    await this.store.mutate((s) => {
      const previous = value.id ? s.rules.find((r) => r.id === value.id) : undefined;
      if (value.id && !previous) throw new Error('규칙을 찾을 수 없습니다.');
      if (!previous && s.rules.length >= 100)
        throw new Error('감시는 최대 100개까지 저장할 수 있습니다.');
      const id = previous?.id ?? randomUUID();
      const rule = { ...value, id, revision: (previous?.revision ?? 0) + 1 };
      s.rules = [...s.rules.filter((r) => r.id !== id), rule];
      delete s.progress[id];
      this.removeRuleQueue(s, id);
    });
    this.wake(true);
    return this.snapshot();
  }
  private removeRuleQueue(s: State, id: string) {
    s.outbox = s.outbox.flatMap((item) => {
      const ruleRefs = item.ruleRefs.filter((ref) => ref.id !== id);
      if (!ruleRefs.length) {
        if (s.dedupe[item.id] === 0) delete s.dedupe[item.id];
        return [];
      }
      return [{ ...item, ruleRefs }];
    });
  }
  async deleteRule(id: string) {
    text(id, 80);
    this.invalidate();
    await this.store.mutate((s) => {
      s.rules = s.rules.filter((r) => r.id !== id);
      delete s.progress[id];
      this.removeRuleQueue(s, id);
    });
    this.wake(true);
    return this.snapshot();
  }
  async setPaused(value: boolean) {
    if (typeof value !== 'boolean') throw new Error('올바른 정지 값이 필요합니다.');
    this.invalidate();
    await this.store.mutate((s) => {
      s.settings.isPaused = value;
    });
    this.wake(false);
    return this.snapshot();
  }
  async saveWebhook(value: string) {
    const encrypted = this.secrets.encode(value);
    this.invalidate();
    await this.store.mutate((s) => {
      s.secret = { encrypted, revision: s.secret.revision + 1, isTerminal: false };
      this.clearPending(s);
    });
    this.wake(false);
    return this.snapshot();
  }
  async deleteWebhook() {
    this.invalidate();
    await this.store.mutate((s) => {
      s.secret = { revision: s.secret.revision + 1, isTerminal: false };
      this.clearPending(s);
    });
    this.wake(false);
    return this.snapshot();
  }
  private clearPending(s: State) {
    s.outbox.forEach((item) => {
      if (s.dedupe[item.id] === 0) delete s.dedupe[item.id];
    });
    s.outbox = [];
  }
  async updateSettings(input: unknown) {
    const value = validateSettings(input);
    this.invalidate();
    await this.store.mutate((s) => {
      Object.assign(s.settings, value);
      for (const p of Object.values(s.progress))
        p.nextAt = this.now() + s.settings.intervalSeconds * 1000;
    });
    this.wake(false);
    return this.snapshot();
  }
  async recover() {
    this.invalidate();
    await this.store.recover();
    this.wake(true);
    return this.snapshot();
  }
  private history(s: State, item: HistoryItem) {
    s.history = [item, ...s.history].slice(0, 100);
  }
  private prune(s: State) {
    const now = this.now();
    s.outbox = s.outbox.filter((item) => {
      const isStale =
        item.secretRevision !== s.secret.revision ||
        !item.ruleRefs.some((ref) =>
          s.rules.some((r) => r.id === ref.id && r.revision === ref.revision && r.isEnabled),
        );
      const isExpired = now - item.createdAt >= MAX_AGE;
      if (isStale || isExpired) {
        if (s.dedupe[item.id] === 0) delete s.dedupe[item.id];
        if (isExpired)
          this.history(s, {
            id: randomUUID(),
            at: now,
            kind: 'expired',
            title: item.session.movieTitle,
            detail: '24시간 보존 기간이 지나 전송 대기를 종료했습니다.',
          });
        return false;
      }
      return true;
    });
    while (s.outbox.length > 100) {
      const item = s.outbox.shift()!;
      if (s.dedupe[item.id] === 0) delete s.dedupe[item.id];
      this.history(s, {
        id: randomUUID(),
        at: now,
        kind: 'overflow',
        title: item.session.movieTitle,
        detail: '대기 한도 100개를 초과해 가장 오래된 항목을 종료했습니다.',
      });
    }
    s.dedupe = Object.fromEntries(
      Object.entries(s.dedupe)
        .filter(([, at]) => at === 0 || now - at < 30 * MAX_AGE)
        .slice(-5000),
    );
  }
  private backoff(attempt: number) {
    return (
      Math.min(3600000, 30000 * 2 ** Math.min(attempt, 7)) +
      Math.round((this.dependencies.random ?? Math.random)() * 3000)
    );
  }
  private async tick() {
    if (this.running) return this.running;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const force = this.shouldForce;
    this.shouldForce = false;
    this.needsRefresh = false;
    const isCurrent = () =>
      generation === this.generation && this.canRun() && !controller.signal.aborted;
    const work = async () => {
      if (!isCurrent()) return;
      await this.store.mutate((s) => {
        if (isCurrent()) this.prune(s);
      }, isCurrent);
      const rules = [...this.store.state.rules];
      for (const rule of rules) {
        if (!isCurrent()) return;
        const progress = this.store.state.progress[rule.id];
        if (
          !rule.isEnabled ||
          rule.date < koreanToday(this.now()) ||
          (progress &&
            ((progress.retryUntil ?? 0) > this.now() || (!force && progress.nextAt > this.now())))
        )
          continue;
        try {
          const raw = await this.dependencies.providers[rule.provider](rule, controller.signal);
          if (!isCurrent()) return;
          const sessions = eligibleSessions(rule, raw);
          await this.store.mutate((s) => {
            if (
              !isCurrent() ||
              !s.rules.some((r) => r.id === rule.id && r.revision === rule.revision)
            )
              return;
            const previous = s.progress[rule.id];
            const now = this.now();
            const baseline = Object.fromEntries(
              sessions.map((session) => [sessionIdentity(session), session.isBookable]),
            );
            if (previous?.baseline && previous.revision === rule.revision)
              for (const session of sessions) {
                const id = sessionIdentity(session);
                if (
                  !session.isBookable ||
                  previous.baseline[id] === true ||
                  Object.hasOwn(s.dedupe, id) ||
                  s.outbox.some((item) => item.id === id)
                )
                  continue;
                if (!s.secret.encrypted) continue;
                s.dedupe[id] = 0;
                s.outbox.push({
                  id,
                  session,
                  ruleRefs: s.rules
                    .filter((r) => r.isEnabled && eligibleSessions(r, [session]).length)
                    .map((r) => ({ id: r.id, revision: r.revision })),
                  secretRevision: s.secret.revision,
                  createdAt: now,
                  nextAt: now,
                  attempts: 0,
                });
              }
            const exactMovieIds = new Set(sessions.map((item) => item.movieId));
            if (!rule.movieId && exactMovieIds.size === 1) {
              const current = s.rules.find((r) => r.id === rule.id)!;
              current.movieId = sessions[0].movieId;
            }
            s.progress[rule.id] = {
              revision: rule.revision,
              baseline,
              lastSuccess: now,
              lastFailure: previous?.lastFailure,
              failures: 0,
              nextAt: now + s.settings.intervalSeconds * 1000,
              count: sessions.filter((session) => session.isBookable).length,
            };
            this.prune(s);
          }, isCurrent);
        } catch (error) {
          if (!isCurrent()) return;
          await this.store.mutate((s) => {
            if (!isCurrent()) return;
            const previous = s.progress[rule.id];
            const failures = (previous?.failures ?? 0) + 1;
            const message =
              error instanceof ProviderError
                ? error.message
                : '공급자 응답 형식을 확인할 수 없습니다. 잠시 후 다시 시도하세요.';
            s.progress[rule.id] = {
              ...previous,
              revision: rule.revision,
              failures,
              nextAt:
                this.now() +
                Math.max(
                  this.backoff(failures),
                  error instanceof ProviderError ? error.retryAfterMs : 0,
                ),
              count: previous?.count ?? 0,
              lastFailure: this.now(),
              retryUntil: this.now() + (error instanceof ProviderError ? error.retryAfterMs : 0),
              error: message.slice(0, 240),
            };
          }, isCurrent);
        }
        this.emit();
      }
      if (!isCurrent()) return;
      const state = this.store.state;
      if (
        !state.secret.encrypted ||
        state.secret.isTerminal ||
        !this.secrets.isAvailable() ||
        (state.secret.retryAt ?? 0) > this.now()
      )
        return;
      const item = state.outbox.find((q) => q.nextAt <= this.now());
      if (!item) return;
      let url: string;
      try {
        url = this.secrets.decode(state.secret.encrypted);
      } catch {
        await this.store.mutate((s) => {
          if (isCurrent()) s.secret.isTerminal = true;
        }, isCurrent);
        return;
      }
      const result = await this.dependencies.deliver(url, item.session, controller.signal);
      if (!isCurrent()) return;
      await this.store.mutate((s) => {
        if (!isCurrent() || s.secret.revision !== item.secretRevision) return;
        const current = s.outbox.find((q) => q.id === item.id);
        if (!current) return;
        const now = this.now();
        if (result.kind === 'retry' && current.attempts < 8) {
          current.attempts++;
          current.nextAt = now + Math.max(this.backoff(current.attempts), result.delayMs);
          s.secret.retryAt = current.nextAt;
          this.history(s, {
            id: randomUUID(),
            at: now,
            kind: 'failed',
            title: item.session.movieTitle,
            detail: result.detail,
          });
        } else if (result.kind === 'terminal') {
          s.secret.isTerminal = true;
          this.history(s, {
            id: randomUUID(),
            at: now,
            kind: 'failed',
            title: item.session.movieTitle,
            detail: result.detail,
          });
        } else {
          s.outbox = s.outbox.filter((q) => q.id !== item.id);
          s.dedupe[item.id] = now;
          this.history(s, {
            id: randomUUID(),
            at: now,
            kind: result.kind === 'sent' ? 'sent' : 'failed',
            title: item.session.movieTitle,
            detail:
              result.kind === 'sent'
                ? `${item.session.theaterName} · ${item.session.date} ${item.session.time} · ${item.session.format}`
                : result.kind === 'retry'
                  ? '재시도 한도 8회에 도달했습니다. 웹훅과 연결을 확인하세요.'
                  : result.detail,
          });
          s.secret.retryAt = now + 1000;
        }
      }, isCurrent);
    };
    this.running = work();
    this.emit();
    try {
      await this.running;
    } finally {
      this.running = undefined;
      this.controller = undefined;
      this.emit();
      if (this.needsRefresh && this.canRun()) {
        this.needsRefresh = false;
        this.wake(true);
      } else if (generation === this.generation) this.schedule();
    }
  }
  private nextDeadline() {
    if (!this.canRun()) return undefined;
    const s = this.store.state;
    const times = s.rules
      .filter((r) => r.isEnabled && r.date >= koreanToday(this.now()))
      .map((r) =>
        Math.max(s.progress[r.id]?.nextAt ?? this.now(), s.progress[r.id]?.retryUntil ?? 0),
      );
    if (s.secret.encrypted && !s.secret.isTerminal && this.secrets.isAvailable())
      times.push(...s.outbox.map((q) => Math.max(q.nextAt, s.secret.retryAt ?? 0)));
    return times.length ? Math.min(...times) : undefined;
  }
  private schedule() {
    clearTimeout(this.timer);
    const next = this.nextDeadline();
    if (next === undefined) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.wake(false);
      },
      Math.max(1000, next - this.now()),
    );
    this.timer.unref?.();
  }
}
