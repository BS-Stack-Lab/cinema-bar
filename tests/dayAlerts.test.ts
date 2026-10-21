import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../electron/engine';
import { Store } from '../electron/store';
import { SecretStore } from '../electron/secretStore';
import { dayAlertKey, reconcileDayAlerts } from '../electron/dayAlerts';
import { discordPayload, type DeliveryResult } from '../electron/discord';
import { sessionIdentity, validateRule, validateState } from '../electron/validation';
import type { LocalAlertResult, LocalOutboxItem, Rule, Session } from '../electron/types';
import { NOW, rule, session } from './fixtures';

const directories: string[] = [];
const engines: Engine[] = [];
const grouped: Rule = { ...rule, movieId: session.movieId, format: 'ALL' };
const sample = (overrides: Partial<Session> = {}): Session => ({ ...session, ...overrides });
const pending = (value: Session, refs: Rule[] = [grouped], attempts = 0): LocalOutboxItem => ({
  id: sessionIdentity(value),
  session: value,
  ruleRefs: refs.map(({ id, revision }) => ({ id, revision })),
  createdAt: NOW - 3000,
  nextAt: NOW,
  attempts,
});
async function fixture(rules: Rule[] = [grouped]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cinema-day-'));
  directories.push(directory);
  const store = new Store(directory);
  await store.load();
  const secrets = new SecretStore({
    isAvailable: () => true,
    encrypt: (value) => Buffer.from(value),
    decrypt: (value) => value.toString(),
  });
  await store.mutate((s) => {
    s.rules = structuredClone(rules);
    s.secret = {
      encrypted: secrets.encode('https://discord.com/api/webhooks/123456789/' + 'x'.repeat(40)),
      revision: 1,
      isTerminal: false,
    };
  });
  let now = NOW;
  let sessions = [sample()];
  let isReady = true;
  const trace: string[] = [];
  const provider = vi.fn(async () => sessions);
  const notifyLocal = vi.fn<(session: Session, signal: AbortSignal) => Promise<LocalAlertResult>>(
    async () => {
      trace.push('local');
      return { kind: 'requested' as const };
    },
  );
  const deliver = vi.fn<
    (url: string, session: Session, signal: AbortSignal) => Promise<DeliveryResult>
  >(async () => {
    trace.push('discord');
    return { kind: 'sent' };
  });
  const dependencies = {
    providers: { cgv: provider, megabox: provider, lottecinema: provider },
    notifyLocal,
    deliver,
    now: () => now,
    random: () => 0,
    isLocalAlertReady: () => isReady,
  };
  const engine = new Engine(store, secrets, dependencies);
  engines.push(engine);
  return {
    store,
    engine,
    provider,
    notifyLocal,
    deliver,
    trace,
    setSessions: (value: Session[]) => {
      sessions = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
    ready: (value: boolean) => {
      isReady = value;
    },
    restart: async () => {
      engine.stop();
      const nextStore = new Store(directory);
      await nextStore.load();
      const next = new Engine(nextStore, secrets, dependencies);
      engines.push(next);
      return { engine: next, store: nextStore };
    },
  };
}
async function settle(engine: Engine) {
  for (let i = 0; i < 100 && engine.snapshot().isChecking; i++)
    await new Promise((resolve) => setTimeout(resolve, 2));
}
afterEach(async () => {
  engines.splice(0).forEach((engine) => engine.stop());
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
describe('date subscription delivery', () => {
  it.each(['cgv', 'megabox', 'lottecinema'] as const)(
    '%s alerts first-open and empty→open once across formats with the minimum future start',
    async (provider) => {
      for (const firstEmpty of [false, true]) {
        const current = { ...grouped, provider };
        const f = await fixture([current]);
        const values = [
          sample({ provider, time: '17:00', format: 'IMAX' }),
          sample({ provider, showingId: 'unknown', time: '10:00', format: 'UNKNOWN' }),
          sample({ provider, showingId: 'sold', time: '09:30', isBookable: false }),
          sample({ provider, showingId: 'now', time: '09:00' }),
          sample({ provider, showingId: 'past', time: '08:59' }),
        ];
        f.setSessions(firstEmpty ? [] : values);
        await f.engine.refresh();
        if (firstEmpty) {
          expect(f.trace).toEqual([]);
          f.setSessions(values);
          await f.engine.refresh();
        }
        expect(f.trace).toEqual(['local', 'discord']);
        expect(f.notifyLocal.mock.calls[0][0]).toMatchObject({
          time: '10:00',
          format: 'UNKNOWN',
          notificationKind: 'dayOpen',
        });
        expect(f.store.state.dedupe[dayAlertKey(current)]).toBe(NOW);
        expect(f.store.state.localDedupe[dayAlertKey(current)]).toBe(NOW);
        expect(values.every((value) => !Object.hasOwn(value, 'notificationKind'))).toBe(true);
        const payload = discordPayload(f.deliver.mock.calls[0][1]);
        expect(payload.content).toContain('지정 날짜 예매가 열렸어요');
        expect(payload.content).toContain('가장 빠른 회차 10:00 · 포맷 미확인');
        expect(payload.allowed_mentions.parse).toEqual([]);
        expect(
          f.store.state.history.every((item) => item.detail.includes('지정 날짜 예매가 열렸어요')),
        ).toBe(true);
        f.engine.stop();
      }
    },
  );
  it('updates displayed earliest without repeating after new formats, reopen, overlap, edit, restart, pause or resume', async () => {
    const f = await fixture([
      grouped,
      { ...grouped, id: 'overlap', shouldNotifyEarliestOnly: true },
    ]);
    await f.engine.refresh();
    f.setSessions([
      sample({ showingId: 'earlier', time: '10:00', format: 'IMAX' }),
      sample({ isBookable: false }),
    ]);
    await f.engine.refresh();
    expect(f.engine.snapshot().earliestByRule?.[grouped.id].session?.time).toBe('10:00');
    f.setSessions([sample()]);
    await f.engine.refresh();
    const { revision: _revision, ...input } = f.store.state.rules[0];
    void _revision;
    await f.engine.saveRule({ ...input, shouldNotifyEarliestOnly: true });
    await settle(f.engine);
    await f.engine.setPaused(true);
    await f.engine.setPaused(false);
    await settle(f.engine);
    f.engine.suspend();
    f.engine.resume();
    await settle(f.engine);
    const restored = await f.restart();
    await restored.engine.refresh();
    expect(f.notifyLocal).toHaveBeenCalledTimes(1);
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(restored.store.state.rules[0].shouldNotifyEarliestOnly).toBe(true);
  });
  it('keeps separate dates, theaters, pinned same-title movies and requested formats independent', async () => {
    const rules: Rule[] = [
      grouped,
      { ...grouped, id: 'date', date: '2099-01-02' },
      { ...grouped, id: 'theater', theaterId: 'other' },
      { ...grouped, id: 'movie', movieId: 'movie-2' },
      { ...grouped, id: 'imax', format: 'IMAX', shouldNotifyEarliestOnly: true },
    ];
    const f = await fixture(rules);
    f.setSessions([
      sample(),
      sample({ date: '2099-01-02', showingId: 'date' }),
      sample({ theaterId: 'other', showingId: 'theater' }),
      sample({ movieId: 'movie-2', showingId: 'movie' }),
      sample({ format: 'IMAX', showingId: 'imax' }),
    ]);
    await f.engine.refresh();
    expect(f.notifyLocal).toHaveBeenCalledTimes(5);
    for (let i = 0; i < 4; i++) {
      f.advance(1000);
      await f.engine.refresh();
    }
    expect(f.deliver).toHaveBeenCalledTimes(5);
    expect(new Set(rules.map(dayAlertKey)).size).toBe(5);
  });
  it('explicit format stays per-session by default; earliest selection filters before choosing and uses earliest wording', async () => {
    for (const shouldNotifyEarliestOnly of [undefined, true]) {
      const f = await fixture([
        {
          ...grouped,
          format: '2D',
          ...(shouldNotifyEarliestOnly ? { shouldNotifyEarliestOnly } : {}),
        },
      ]);
      f.setSessions([
        sample({ showingId: 'later', time: '18:00' }),
        sample({ showingId: 'imax', format: 'IMAX', time: '10:00' }),
        sample({ showingId: 'first', time: '12:00' }),
      ]);
      await f.engine.refresh();
      f.advance(1000);
      await f.engine.refresh();
      expect(f.notifyLocal).toHaveBeenCalledTimes(shouldNotifyEarliestOnly ? 1 : 2);
      expect(f.deliver).toHaveBeenCalledTimes(shouldNotifyEarliestOnly ? 1 : 2);
      if (shouldNotifyEarliestOnly) {
        expect(f.notifyLocal.mock.calls[0][0]).toMatchObject({
          time: '12:00',
          notificationKind: 'earliest',
        });
        expect(discordPayload(f.deliver.mock.calls[0][1]).content).toContain(
          '가장 빠른 예매 가능 회차를 찾았어요',
        );
        expect(f.store.state.history[0].detail).toContain('가장 빠른 예매 가능 회차를 찾았어요');
      }
    }
  });
  it('legacy completed baseline seeds independent destinations before provider failure, even when the old session disappeared', async () => {
    for (const side of ['localDedupe', 'dedupe'] as const) {
      const f = await fixture();
      const old = sessionIdentity(sample({ showingId: 'gone' }));
      await f.store.mutate((s) => {
        s[side][old] = NOW - 100;
        s.progress[grouped.id] = {
          revision: 1,
          baseline: { [old]: false },
          failures: 0,
          nextAt: NOW,
          count: 0,
        };
        s.localOutbox = [pending(sample())];
        s.localDedupe[sessionIdentity(session)] = 0;
        s.outbox = [{ ...pending(sample()), secretRevision: 1 }];
        s.dedupe[sessionIdentity(session)] = 0;
      });
      f.provider.mockRejectedValueOnce(new Error('provider unavailable'));
      await f.engine.refresh();
      expect(f.store.state[side][dayAlertKey(grouped)]).toBe(NOW - 100);
      expect(side === 'localDedupe' ? f.notifyLocal : f.deliver).not.toHaveBeenCalled();
      expect(side === 'localDedupe' ? f.deliver : f.notifyLocal).toHaveBeenCalledTimes(1);
      f.setSessions([sample({ showingId: 'brand-new', time: '17:00' })]);
      f.advance(120000);
      await f.engine.refresh();
      expect(f.notifyLocal).toHaveBeenCalledTimes(side === 'localDedupe' ? 0 : 1);
      expect(f.deliver).toHaveBeenCalledTimes(side === 'dedupe' ? 0 : 1);
    }
  });
  it('quiet baselines and pending zero never imply completion; mixed refs split and retry state merges conservatively', async () => {
    const explicit = { ...grouped, id: 'explicit', format: '2D' as const };
    const f = await fixture([grouped, explicit]);
    f.ready(false);
    const a = sample({ showingId: 'a', time: '12:00' });
    const b = sample({ showingId: 'b', time: '18:00' });
    await f.store.mutate((s) => {
      s.progress[grouped.id] = {
        revision: 1,
        baseline: { [sessionIdentity(a)]: true },
        failures: 0,
        nextAt: NOW,
        count: 1,
      };
      s.localOutbox = [
        pending(a, [grouped, explicit]),
        { ...pending(b), createdAt: NOW - 7000, nextAt: NOW + 5000, attempts: 2 },
      ];
      s.outbox = s.localOutbox.map((item) => ({ ...item, secretRevision: 1 }));
      for (const item of s.localOutbox) {
        s.localDedupe[item.id] = 0;
        s.dedupe[item.id] = 0;
      }
    });
    f.provider.mockRejectedValue(new Error('offline fixture'));
    await f.engine.refresh();
    for (const queue of [f.store.state.localOutbox, f.store.state.outbox]) {
      expect(queue).toHaveLength(2);
      const item = queue.find((item) => item.id === dayAlertKey(grouped))!;
      expect(item).toMatchObject({
        attempts: 2,
        nextAt: NOW + 5000,
        createdAt: NOW - 7000,
        session: { time: '18:00', notificationKind: 'dayOpen' },
      });
      expect(queue.find((item) => item.id === sessionIdentity(a))?.ruleRefs).toEqual([
        { id: 'explicit', revision: 1 },
      ]);
    }
  });
  it('title-only completion aliases only when raw movie identity is unique; same-title pinned IDs remain separate', async () => {
    const { movieId: _movieId, ...titleRule } = grouped;
    void _movieId;
    const other = { ...grouped, id: 'other', movieId: 'movie-2' };
    const f = await fixture([titleRule, other]);
    await f.store.mutate((s) => {
      s.localDedupe[dayAlertKey(titleRule)] = NOW - 100;
      s.dedupe[dayAlertKey(titleRule)] = NOW - 100;
    });
    f.setSessions([sample(), sample({ movieId: 'movie-2', showingId: 'other' })]);
    await f.engine.refresh();
    expect(f.store.state.rules[0].movieId).toBeUndefined();
    expect(f.notifyLocal).toHaveBeenCalledTimes(1);
    f.setSessions([sample()]);
    f.advance(1000);
    await f.engine.refresh();
    expect(f.store.state.rules[0].movieId).toBe(session.movieId);
    expect(f.store.state.localDedupe[dayAlertKey(grouped)]).toBe(NOW - 100);
    expect(f.notifyLocal).toHaveBeenCalledTimes(1);
  });
  it('refreshes unattempted representative and freezes it after local consumption and Discord retry', async () => {
    const f = await fixture();
    f.ready(false);
    await f.engine.refresh();
    f.setSessions([sample({ showingId: 'early', time: '10:00' })]);
    await f.engine.refresh();
    expect(f.store.state.localOutbox[0].session.time).toBe('10:00');
    f.ready(true);
    f.deliver.mockResolvedValueOnce({ kind: 'retry', delayMs: 120000, detail: 'mock retry' });
    await f.engine.refresh();
    f.setSessions([sample({ showingId: 'earlier', time: '09:30' })]);
    await f.engine.refresh();
    expect(f.engine.snapshot().earliestByRule?.[grouped.id].session?.time).toBe('09:30');
    expect(f.store.state.outbox[0].session.time).toBe('10:00');
    const restored = await f.restart();
    f.advance(120000);
    await restored.engine.refresh();
    expect(f.notifyLocal).toHaveBeenCalledTimes(1);
    expect(f.deliver).toHaveBeenCalledTimes(2);
    expect(f.deliver.mock.calls[1][1].time).toBe('10:00');
  });
  it.each([true, false])(
    'retains completed explicit earliest markers across 31 days, toggle off, enabled=%s, 5001 newer keys and reload',
    async (isEnabled) => {
      const futureRule = {
        ...grouped,
        date: '2099-03-02',
        format: '2D' as const,
        shouldNotifyEarliestOnly: true,
      };
      const f = await fixture([futureRule]);
      f.setSessions([sample({ date: futureRule.date })]);
      await f.engine.refresh();
      const key = dayAlertKey(futureRule);
      const original = [f.store.state.localDedupe[key], f.store.state.dedupe[key]];
      f.setSessions([]);
      const { revision: _revision, ...input } = futureRule;
      void _revision;
      await f.engine.saveRule({ ...input, shouldNotifyEarliestOnly: false, isEnabled });
      await settle(f.engine);
      f.advance(31 * 86400000);
      await f.store.mutate((s) => {
        for (const dedupe of [s.dedupe, s.localDedupe]) {
          dedupe['expired-unmatched'] = NOW;
          for (let i = 0; i < 5001; i++) dedupe[`unrelated-${i}`] = NOW + 31 * 86400000;
        }
      });
      await f.engine.refresh();
      expect([f.store.state.localDedupe[key], f.store.state.dedupe[key]]).toEqual(original);
      expect(f.store.state.dedupe['expired-unmatched']).toBeUndefined();
      expect(Object.keys(f.store.state.dedupe)).toHaveLength(5001);
      const restored = await f.restart();
      f.setSessions([sample({ date: futureRule.date, time: '12:00', showingId: 'changed' })]);
      await restored.engine.saveRule({ ...input, isEnabled: true, shouldNotifyEarliestOnly: true });
      await settle(restored.engine);
      await restored.engine.refresh();
      expect([restored.store.state.localDedupe[key], restored.store.state.dedupe[key]]).toEqual(
        original,
      );
      expect(f.notifyLocal).toHaveBeenCalledTimes(1);
      expect(f.deliver).toHaveBeenCalledTimes(1);
      expect(validateState(restored.store.state)).toBe(restored.store.state);
    },
  );
  it('drops stale, expired, past and secret-mismatched pending without consuming the group, then reacquires its future representative', async () => {
    const f = await fixture();
    const key = dayAlertKey(grouped);
    await f.store.mutate((s) => {
      const item = {
        ...pending(sample({ time: '08:00' })),
        id: key,
        session: sample({ time: '08:00', notificationKind: 'dayOpen' }),
        createdAt: NOW - 86400000,
      };
      s.localOutbox = [item];
      s.localDedupe[key] = 0;
      s.outbox = [{ ...item, secretRevision: 0 }];
      s.dedupe[key] = 0;
    });
    f.provider.mockRejectedValueOnce(new Error('fixture'));
    await f.engine.refresh();
    expect(f.notifyLocal).not.toHaveBeenCalled();
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.store.state.localDedupe[key]).toBeUndefined();
    expect(f.store.state.dedupe[key]).toBeUndefined();
    f.advance(120000);
    await f.engine.refresh();
    expect(f.trace).toEqual(['local', 'discord']);
  });
  it('does not commit a Discord result after rule deletion aborts the request', async () => {
    const f = await fixture();
    let release!: () => void;
    f.deliver.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          release = () => resolve({ kind: 'sent' });
        }),
    );
    const work = f.engine.refresh();
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    await f.engine.deleteRule(grouped.id);
    release();
    await work;
    await settle(f.engine);
    expect(f.store.state.dedupe[dayAlertKey(grouped)]).toBeUndefined();
    expect(f.store.state.history.some((item) => item.kind === 'sent')).toBe(false);
  });
  it.each(['failed', 'unsupported'] as const)(
    'consumes a grouped local %s once and continues Discord with its own retry unit',
    async (kind) => {
      const f = await fixture();
      f.notifyLocal.mockResolvedValue({ kind });
      f.deliver.mockResolvedValueOnce({ kind: 'retry', delayMs: 120000, detail: '429 fixture' });
      await f.engine.refresh();
      expect(f.deliver).toHaveBeenCalledTimes(1);
      expect(f.notifyLocal).toHaveBeenCalledTimes(1);
      expect(f.store.state.outbox).toHaveLength(1);
      expect(f.store.state.outbox[0].attempts).toBe(1);
      expect(f.store.state.history.find((item) => item.kind === 'localFailed')?.detail).toContain(
        '지정 날짜 예매가 열렸어요',
      );
      const attempts = f.deliver.mock.calls.length;
      await f.engine.refresh();
      expect(f.deliver).toHaveBeenCalledTimes(attempts);
      f.advance(120000);
      await f.engine.refresh();
      expect(f.notifyLocal).toHaveBeenCalledTimes(1);
      expect(f.deliver).toHaveBeenCalledTimes(2);
    },
  );
  it('stops grouped Discord after the initial attempt and eight retries while local stays consumed', async () => {
    const tomorrow = { ...grouped, date: '2099-01-02' };
    const f = await fixture([tomorrow]);
    f.setSessions([sample({ date: tomorrow.date })]);
    f.deliver.mockResolvedValue({ kind: 'retry', delayMs: 0, detail: 'retry fixture' });
    for (let i = 0; i < 10; i++) {
      await f.engine.refresh();
      f.advance(3600001);
    }
    expect(f.notifyLocal).toHaveBeenCalledTimes(1);
    expect(f.deliver).toHaveBeenCalledTimes(9);
    expect(f.store.state.outbox).toHaveLength(0);
    expect(f.store.state.history.some((item) => item.detail.includes('재시도 한도 8회'))).toBe(
      true,
    );
  });
  it('aliases a legacy title pending group before delivery and keeps the attempted representative', async () => {
    const { movieId: _movieId, ...titleRule } = grouped;
    void _movieId;
    const f = await fixture([titleRule]);
    const oldKey = dayAlertKey(titleRule);
    await f.store.mutate((s) => {
      s.localDedupe[oldKey] = NOW - 10;
      s.outbox = [
        {
          ...pending(sample({ time: '18:00', notificationKind: 'earliest' }), [titleRule], 2),
          id: oldKey,
          nextAt: NOW + 1000,
          secretRevision: 1,
        },
      ];
      s.dedupe[oldKey] = 0;
    });
    f.setSessions([sample({ showingId: 'new-earliest', time: '10:00' })]);
    await f.engine.refresh();
    expect(f.store.state.outbox[0]).toMatchObject({
      id: dayAlertKey(grouped),
      attempts: 2,
      nextAt: NOW + 1000,
      session: { time: '18:00', notificationKind: 'earliest' },
    });
    expect(f.store.state.localDedupe[dayAlertKey(grouped)]).toBe(NOW - 10);
    f.advance(1000);
    await f.engine.refresh();
    expect(f.notifyLocal).not.toHaveBeenCalled();
    expect(f.deliver.mock.calls[0][1].time).toBe('18:00');
  });
  it('a stale revision queue is cancelled; a previously consumed side stays suppressed after pending representative expiry', async () => {
    const f = await fixture();
    const key = dayAlertKey(grouped);
    await f.store.mutate((s) => {
      s.localDedupe[key] = NOW - 10;
      s.outbox = [
        {
          ...pending(sample({ time: '08:00' })),
          id: key,
          secretRevision: 1,
          session: sample({ time: '08:00', notificationKind: 'dayOpen' }),
        },
      ];
      s.dedupe[key] = 0;
      s.localOutbox = [{ ...pending(sample()), ruleRefs: [{ id: grouped.id, revision: 999 }] }];
      s.localDedupe[sessionIdentity(session)] = 0;
    });
    await f.engine.refresh();
    expect(f.notifyLocal).not.toHaveBeenCalled();
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(f.deliver.mock.calls[0][1].time).toBe('15:30');
    expect(f.store.state.localDedupe[sessionIdentity(session)]).toBeUndefined();
  });
  it('preserves optional fields in schema2 and rejects non-boolean preferences and unsupported queued metadata', async () => {
    const { revision: _revision, ...input } = rule;
    void _revision;
    expect(Object.hasOwn(validateRule(input), 'shouldNotifyEarliestOnly')).toBe(false);
    for (const value of ['true', 1, null, undefined])
      expect(() => validateRule({ ...input, shouldNotifyEarliestOnly: value })).toThrow();
    const f = await fixture();
    for (const notificationKind of [undefined, 'dayOpen', 'earliest', 'invalid', null, 1]) {
      const state = structuredClone(f.store.state);
      const value = sample();
      if (notificationKind !== undefined) Object.assign(value, { notificationKind });
      state.localOutbox = [pending(value)];
      if (
        notificationKind === undefined ||
        notificationKind === 'dayOpen' ||
        notificationKind === 'earliest'
      )
        expect(validateState(state).schemaVersion).toBe(2);
      else expect(() => validateState(state)).toThrow();
    }
    await f.store.mutate((s) => {
      s.rules = [{ ...grouped, shouldNotifyEarliestOnly: true }];
      reconcileDayAlerts(s, NOW);
    });
    const restored = await f.restart();
    expect(restored.store.state.rules[0].shouldNotifyEarliestOnly).toBe(true);
  });
});
