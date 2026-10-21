import { randomUUID } from 'node:crypto';
import {
  alertHistory,
  alertSummary,
  dayAlertKey,
  enqueueDayAlert,
  isDayAlert,
  pinDayAlert,
  pruneAlertDedupe,
  reconcileDayAlerts,
} from './dayAlerts.js';
import { Store } from './store.js';
import { SecretStore } from './secretStore.js';
import { eligibleSessions, ProviderError, type ProviderAdapter } from './providers/index.js';
import { sessionIdentity, validateRule, validateSettings, text } from './validation.js';
import type { DeliveryResult } from './discord.js';
import { isRuleEligible } from './eligibility.js';
import { compareSessions, isFutureSession, sessionStartsAt } from './sessionTiming.js';
import type {
  HistoryItem,
  LocalAlertResult,
  Provider,
  RuleInput,
  Session,
  Snapshot,
  State,
} from './types.js';
const MAX_AGE = 24 * 60 * 60 * 1000;
export interface EngineDependencies {
  providers: Record<Provider, ProviderAdapter>;
  deliver: (url: string, session: Session, signal: AbortSignal) => Promise<DeliveryResult>;
  notifyLocal?: (session: Session, signal: AbortSignal) => Promise<LocalAlertResult>;
  isLocalAlertSupported?: () => boolean;
  isLocalAlertReady?: () => boolean;
  now?: () => number;
  random?: () => number;
}
export class Engine {
  private generation = 0;
  private candidates = new Map<
    string,
    { revision: number; checkedAt: number; sessions: Session[] }
  >();
  isStarted = false;
  isKeepingAwake = false;
  keepAwakeWarning?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private controller?: AbortController;
  private discordController?: AbortController;
  private localController?: AbortController;
  private localRevision = 0;
  localAlertWarning?: string;
  private needsRefresh = false;
  private shouldForce = false;
  private isStopped = false;
  loginWarning?: string;
  trayWarning?: string;
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
      earliestByRule: Object.fromEntries(
        s.rules.flatMap((rule) => {
          const current = this.candidates.get(rule.id);
          if (!current || current.revision !== rule.revision || !isRuleEligible(rule, this.now()))
            return [];
          const session = current.sessions.find((item) => isFutureSession(item, this.now()));
          return [
            [
              rule.id,
              {
                revision: rule.revision,
                checkedAt: current.checkedAt,
                ...(session
                  ? {
                      session: {
                        identity: sessionIdentity(session),
                        startsAt: sessionStartsAt(session)!,
                        date: session.date,
                        time: session.time,
                        format: session.format,
                        screen: session.screen,
                      },
                    }
                  : {}),
              },
            ],
          ];
        }),
      ),
      isKeepingAwake: this.isKeepingAwake,
      keepAwakeWarning: this.keepAwakeWarning,
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
      localPendingCount: s.localOutbox.length,
      isLocalAlertSupported:
        this.dependencies.isLocalAlertSupported?.() ?? !!this.dependencies.notifyLocal,
      localAlertWarning: this.localAlertWarning,
      hasWebhook: !!s.secret.encrypted,
      isWebhookBlocked: s.secret.isTerminal,
      isEncryptionAvailable: this.secrets.isAvailable(),
      isOnline: this.isOnline,
      isSuspended: this.isSuspended,
      isChecking: !!this.running,
      nextAt: this.nextDeadline(),
      recoveryError: this.store.recoveryError,
      loginWarning: this.loginWarning,
      trayWarning: this.trayWarning,
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
    this.discordController?.abort();
    this.localController?.abort();
    this.needsRefresh = false;
  }
  stop() {
    this.isStarted = false;
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
    this.isStarted = true;
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
      this.emit();
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
      reconcileDayAlerts(s, this.now());
      const previous = value.id ? s.rules.find((r) => r.id === value.id) : undefined;
      if (value.id && !previous) throw new Error('규칙을 찾을 수 없습니다.');
      if (!previous && s.rules.length >= 100)
        throw new Error('감시는 최대 100개까지 저장할 수 있습니다.');
      const id = previous?.id ?? randomUUID();
      if (previous && isDayAlert(value) && dayAlertKey(previous) === dayAlertKey(value)) {
        if (value.shouldNotifyEarliestOnly === undefined) delete previous.shouldNotifyEarliestOnly;
        else previous.shouldNotifyEarliestOnly = value.shouldNotifyEarliestOnly;
        reconcileDayAlerts(s, this.now());
      }
      const rule = { ...value, id, revision: (previous?.revision ?? 0) + 1 };
      s.rules = [...s.rules.filter((r) => r.id !== id), rule];
      delete s.progress[id];
      this.candidates.delete(id);
      this.removeRuleQueue(s, id);
    });
    this.wake(true);
    return this.snapshot();
  }
  private removeRuleQueue(s: State, id: string) {
    for (const destination of ['outbox', 'localOutbox'] as const) {
      const dedupe = destination === 'outbox' ? s.dedupe : s.localDedupe;
      const queue = s[destination].flatMap((item) => {
        const ruleRefs = item.ruleRefs.filter((ref) => ref.id !== id);
        if (!ruleRefs.length) {
          if (dedupe[item.id] === 0) delete dedupe[item.id];
          return [];
        }
        return [{ ...item, ruleRefs }];
      });
      if (destination === 'outbox') s.outbox = queue as State['outbox'];
      else s.localOutbox = queue;
    }
  }

  async deleteRule(id: string) {
    text(id, 80);
    this.invalidate();
    await this.store.mutate((s) => {
      s.rules = s.rules.filter((r) => r.id !== id);
      delete s.progress[id];
      this.candidates.delete(id);
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
    this.discordController?.abort();
    await this.store.mutate((s) => {
      s.secret = { encrypted, revision: s.secret.revision + 1, isTerminal: false };
      this.clearPending(s);
    });
    this.wake(false);
    return this.snapshot();
  }
  async deleteWebhook() {
    this.discordController?.abort();
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
    if (value.shouldNotifyLocally === false) {
      this.localRevision++;
      this.localController?.abort();
    }
    await this.store.mutate((s) => {
      Object.assign(s.settings, value);
      if (value.shouldNotifyLocally === false) {
        s.localOutbox.forEach((item) => {
          if (s.localDedupe[item.id] === 0) delete s.localDedupe[item.id];
        });
        s.localOutbox = [];
      }
      if (value.intervalSeconds !== undefined)
        for (const p of Object.values(s.progress))
          p.nextAt = this.now() + s.settings.intervalSeconds * 1000;
    });
    this.wake(false);
    return this.snapshot();
  }
  async recover() {
    this.invalidate();
    this.candidates.clear();
    await this.store.recover();
    this.wake(true);
    return this.snapshot();
  }
  private history(s: State, item: HistoryItem) {
    s.history = [item, ...s.history].slice(0, 100);
  }
  private prune(s: State) {
    const now = this.now();
    s.localOutbox = s.localOutbox.filter((item) => {
      const isValid =
        s.settings.shouldNotifyLocally &&
        item.ruleRefs.some((ref) =>
          s.rules.some(
            (r) => r.id === ref.id && r.revision === ref.revision && isRuleEligible(r, now),
          ),
        );
      const isExpired = now - item.createdAt >= MAX_AGE;
      if (!isValid || isExpired || !isFutureSession(item.session, now)) {
        if (s.localDedupe[item.id] === 0) delete s.localDedupe[item.id];
        if (isExpired)
          this.history(s, {
            id: randomUUID(),
            at: now,
            kind: 'expired',
            title: item.session.movieTitle,
            detail: '앱 알림: 24시간 보존 기간이 지나 대기를 종료했습니다.',
          });
        return false;
      }
      return true;
    });
    s.localOutbox.sort((a, b) => compareSessions(a.session, b.session));
    while (s.localOutbox.length > 100) {
      const item = s.localOutbox.pop()!;
      if (s.localDedupe[item.id] === 0) delete s.localDedupe[item.id];
      this.history(s, {
        id: randomUUID(),
        at: now,
        kind: 'overflow',
        title: item.session.movieTitle,
        detail: '앱 알림: 대기 한도 100개를 초과해 가장 늦은 회차의 대기를 종료했습니다.',
      });
    }
    s.localDedupe = pruneAlertDedupe(s.localDedupe, s.rules, now);
    s.outbox = s.outbox.filter((item) => {
      const isStale =
        item.secretRevision !== s.secret.revision ||
        !item.ruleRefs.some((ref) =>
          s.rules.some(
            (r) => r.id === ref.id && r.revision === ref.revision && isRuleEligible(r, now),
          ),
        );
      const isExpired = now - item.createdAt >= MAX_AGE;
      if (isStale || isExpired || !isFutureSession(item.session, now)) {
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
    s.outbox.sort((a, b) => compareSessions(a.session, b.session));
    while (s.outbox.length > 100) {
      const item = s.outbox.pop()!;
      if (s.dedupe[item.id] === 0) delete s.dedupe[item.id];
      this.history(s, {
        id: randomUUID(),
        at: now,
        kind: 'overflow',
        title: item.session.movieTitle,
        detail: '대기 한도 100개를 초과해 가장 늦은 회차의 대기를 종료했습니다.',
      });
    }
    s.dedupe = pruneAlertDedupe(s.dedupe, s.rules, now);
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
        if (isCurrent()) {
          reconcileDayAlerts(s, this.now());
          this.prune(s);
        }
      }, isCurrent);
      const rules = [...this.store.state.rules];
      for (const rule of rules) {
        if (!isCurrent()) return;
        const progress = this.store.state.progress[rule.id];
        if (
          !isRuleEligible(rule, this.now()) ||
          (progress &&
            ((progress.retryUntil ?? 0) > this.now() || (!force && progress.nextAt > this.now())))
        )
          continue;
        try {
          const raw = await this.dependencies.providers[rule.provider](rule, controller.signal);
          if (!isCurrent()) return;
          const sessions = eligibleSessions(rule, raw).sort(compareSessions);
          await this.store.mutate((s) => {
            if (
              !isCurrent() ||
              !s.rules.some((r) => r.id === rule.id && r.revision === rule.revision)
            )
              return;
            const previous = s.progress[rule.id];
            const now = this.now();
            reconcileDayAlerts(s, now, raw);
            const currentRule = s.rules.find((r) => r.id === rule.id)!;
            const exactMovieIds = new Set(
              eligibleSessions({ ...rule, format: 'ALL' }, raw).map((item) => item.movieId),
            );
            if (!currentRule.movieId && sessions.length && exactMovieIds.size === 1) {
              pinDayAlert(s, currentRule, sessions[0].movieId);
              reconcileDayAlerts(s, now, raw);
            }
            const baseline = Object.fromEntries(
              sessions.map((session) => [sessionIdentity(session), session.isBookable]),
            );
            const future = sessions.filter(
              (session) => session.isBookable && isFutureSession(session, now),
            );
            if (isDayAlert(currentRule) && future[0])
              enqueueDayAlert(s, currentRule, future[0], now);
            for (const session of isDayAlert(currentRule) ? [] : sessions) {
              const id = sessionIdentity(session);
              if (!session.isBookable || !isFutureSession(session, now)) continue;
              const common = {
                id,
                session,
                ruleRefs: s.rules
                  .filter(
                    (r) =>
                      !isDayAlert(r) &&
                      isRuleEligible(r, now) &&
                      eligibleSessions(r, [session]).length,
                  )
                  .map((r) => ({ id: r.id, revision: r.revision })),
                createdAt: now,
                nextAt: now,
                attempts: 0,
              };
              if (
                s.settings.shouldNotifyLocally &&
                !Object.hasOwn(s.localDedupe, id) &&
                !s.localOutbox.some((q) => q.id === id)
              ) {
                s.localDedupe[id] = 0;
                s.localOutbox.push(common);
              }
              if (
                s.secret.encrypted &&
                !Object.hasOwn(s.dedupe, id) &&
                !s.outbox.some((q) => q.id === id)
              ) {
                s.dedupe[id] = 0;
                s.outbox.push({ ...common, secretRevision: s.secret.revision });
              }
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
            this.candidates.set(rule.id, {
              revision: rule.revision,
              checkedAt: now,
              sessions: sessions.filter(
                (session) => session.isBookable && isFutureSession(session, now),
              ),
            });
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
      for (let attempt = 0; attempt < 10 && isCurrent(); attempt++) {
        const item = this.store.state.localOutbox.find((q) => q.nextAt <= this.now());
        if (!item || !this.store.state.settings.shouldNotifyLocally) break;
        if (!(this.dependencies.isLocalAlertReady?.() ?? true)) break;
        const localRevision = this.localRevision;
        const localController = new AbortController();
        this.localController = localController;
        await this.store.mutate(
          (s) => {
            if (!isCurrent() || localController.signal.aborted || !s.settings.shouldNotifyLocally)
              return;
            s.localOutbox = s.localOutbox.filter((q) => q.id !== item.id);
            // Persist before showing: a crash here can lose one popup, but never replay it.
            s.localDedupe[item.id] = this.now();
          },
          () => isCurrent() && !localController.signal.aborted,
        );
        if (!isCurrent() || localController.signal.aborted) return;
        let result: LocalAlertResult;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          result = await Promise.race([
            this.dependencies.notifyLocal?.(item.session, localController.signal) ??
              Promise.resolve<LocalAlertResult>({ kind: 'unsupported' }),
            new Promise<LocalAlertResult>((resolve) => {
              timeout = setTimeout(() => {
                localController.abort();
                resolve({ kind: 'failed', detail: '앱 알림 표시 시간이 초과되었습니다.' });
              }, 2000);
            }),
          ]);
        } catch {
          result = { kind: 'failed' };
        } finally {
          clearTimeout(timeout);
          this.localController = undefined;
        }
        if (!isCurrent()) return;
        if (!this.store.state.settings.shouldNotifyLocally || localRevision !== this.localRevision)
          continue;
        this.localAlertWarning =
          result.kind === 'requested'
            ? undefined
            : result.kind === 'unsupported'
              ? '앱 팝업을 사용할 수 없어요. Discord 연결을 확인하세요.'
              : '앱 팝업을 표시하지 못했어요. Discord 전송은 계속합니다.';
        await this.store.mutate((s) => {
          if (!isCurrent() || !s.settings.shouldNotifyLocally) return;
          this.history(s, {
            id: randomUUID(),
            at: this.now(),
            kind: result.kind === 'requested' ? 'localRequested' : 'localFailed',
            title: item.session.movieTitle,
            detail:
              result.kind === 'requested'
                ? alertHistory(item.session, `앱 알림 표시 요청 · ${alertSummary(item.session)}`)
                : alertHistory(item.session, this.localAlertWarning!),
          });
        }, isCurrent);
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
      const item = state.outbox.find(
        (q) => q.nextAt <= this.now() && !state.localOutbox.some((local) => local.id === q.id),
      );
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
      const discordController = new AbortController();
      this.discordController = discordController;
      await this.store.mutate(
        (s) => {
          if (
            !isCurrent() ||
            discordController.signal.aborted ||
            s.secret.revision !== item.secretRevision
          )
            return;
          const current = s.outbox.find((candidate) => candidate.id === item.id);
          if (current) current.attempts++;
        },
        () => isCurrent() && !discordController.signal.aborted,
      );
      if (!isCurrent() || discordController.signal.aborted) return;
      const result = await this.dependencies.deliver(url, item.session, discordController.signal);
      this.discordController = undefined;
      if (!isCurrent()) return;
      await this.store.mutate((s) => {
        if (!isCurrent() || s.secret.revision !== item.secretRevision) return;
        const current = s.outbox.find((q) => q.id === item.id);
        if (!current) return;
        const now = this.now();
        if (result.kind === 'retry' && current.attempts <= 8) {
          current.nextAt = now + Math.max(this.backoff(current.attempts), result.delayMs);
          s.secret.retryAt = current.nextAt;
          this.history(s, {
            id: randomUUID(),
            at: now,
            kind: 'failed',
            title: item.session.movieTitle,
            detail: alertHistory(item.session, result.detail),
          });
        } else if (result.kind === 'terminal') {
          s.secret.isTerminal = true;
          this.history(s, {
            id: randomUUID(),
            at: now,
            kind: 'failed',
            title: item.session.movieTitle,
            detail: alertHistory(item.session, result.detail),
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
                ? alertHistory(item.session, alertSummary(item.session))
                : alertHistory(
                    item.session,
                    result.kind === 'retry'
                      ? '재시도 한도 8회에 도달했습니다. 웹훅과 연결을 확인하세요.'
                      : result.detail,
                  ),
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
      .filter((r) => isRuleEligible(r, this.now()))
      .map((r) =>
        Math.max(s.progress[r.id]?.nextAt ?? this.now(), s.progress[r.id]?.retryUntil ?? 0),
      );
    if (s.settings.shouldNotifyLocally)
      times.push(
        ...s.localOutbox.map((q) =>
          Math.max(
            q.nextAt,
            (this.dependencies.isLocalAlertReady?.() ?? true) ? 0 : this.now() + 1000,
          ),
        ),
      );
    if (s.secret.encrypted && !s.secret.isTerminal && this.secrets.isAvailable())
      times.push(
        ...s.outbox
          .filter((q) => !s.localOutbox.some((local) => local.id === q.id))
          .map((q) => Math.max(q.nextAt, s.secret.retryAt ?? 0)),
      );
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
