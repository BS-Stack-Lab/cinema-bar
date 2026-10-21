import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Engine } from '../electron/engine';
import { PowerPolicy } from '../electron/power';
import { Store } from '../electron/store';
import { SecretStore } from '../electron/secretStore';
import { sessionIdentity } from '../electron/validation';
import { compareSessions } from '../electron/sessionTiming';
import type { DeliveryResult } from '../electron/discord';
import type { LocalAlertResult, LocalOutboxItem, Session } from '../electron/types';
import { NOW, rule, session } from './fixtures';
const directories: string[] = [];
const engines: Engine[] = [];
const webhook = 'https://discord.com/api/webhooks/123456789/' + 'x'.repeat(40);
async function fixture(hasWebhook = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cinema-local-'));
  directories.push(directory);
  const store = new Store(directory);
  await store.load();
  const secrets = new SecretStore({
    isAvailable: () => hasWebhook,
    encrypt: (value) => Buffer.from(value),
    decrypt: (value) => value.toString(),
  });
  await store.mutate((s) => {
    s.rules = [structuredClone(rule)];
    if (hasWebhook)
      s.secret = { encrypted: secrets.encode(webhook), revision: 1, isTerminal: false };
  });
  let now = NOW;
  let sessions: Session[] = [structuredClone(session)];
  const trace: string[] = [];
  const provider = vi.fn(async () => sessions);
  const deliver = vi.fn<
    (url: string, session: Session, signal: AbortSignal) => Promise<DeliveryResult>
  >(async () => {
    trace.push('discord');
    return { kind: 'sent' };
  });
  const notifyLocal = vi.fn<(session: Session, signal: AbortSignal) => Promise<LocalAlertResult>>(
    async () => {
      trace.push('local');
      return { kind: 'requested' };
    },
  );
  const dependencies = {
    providers: { cgv: provider, megabox: provider, lottecinema: provider },
    deliver,
    notifyLocal,
    now: () => now,
    random: () => 0,
    isLocalAlertSupported: () => true,
    isLocalAlertReady: () => true,
  };
  const engine = new Engine(store, secrets, dependencies);
  engines.push(engine);
  return {
    store,
    engine,
    secrets,
    provider,
    notifyLocal,
    deliver,
    trace,
    dependencies,
    setSessions: (value: Session[]) => {
      sessions = value;
    },
    advance: (ms: number) => {
      now += ms;
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
describe('independent local destination', () => {
  it.each(['cgv', 'megabox', 'lottecinema'] as const)(
    '%s first successful query alerts already-bookable sessions locally before Discord',
    async (provider) => {
      const f = await fixture(true);
      const bookable = {
        ...session,
        provider,
        bookingUrl: {
          cgv: 'https://cgv.co.kr/cnm/movieBook/movie',
          megabox: 'https://www.megabox.co.kr/booking',
          lottecinema: 'https://www.lottecinema.co.kr/NLCHS/Ticketing',
        }[provider],
      };
      await f.store.mutate((s) => {
        s.rules = [{ ...rule, provider }];
      });
      f.setSessions([bookable]);
      await f.engine.refresh();
      expect(f.trace).toEqual(['local', 'discord']);
      expect(f.notifyLocal).toHaveBeenCalledWith(bookable, expect.any(AbortSignal));
      expect(f.deliver).toHaveBeenCalledWith(expect.any(String), bookable, expect.any(AbortSignal));
      expect(f.store.state.progress[rule.id].baseline?.[sessionIdentity(bookable)]).toBe(true);
      expect(f.store.state.history.map((item) => item.kind)).toEqual(['sent', 'localRequested']);
    },
  );
  it('catches up a persisted quiet baseline and preserves destination records across restart', async () => {
    const f = await fixture(true);
    const id = sessionIdentity(session);
    await f.store.mutate((s) => {
      s.progress[rule.id] = {
        revision: rule.revision,
        baseline: { [id]: true },
        lastSuccess: NOW - 120000,
        failures: 0,
        count: 1,
        nextAt: NOW,
      };
    });
    f.engine.stop();
    const restored = new Store(f.store.directory);
    await restored.load();
    const engine = new Engine(restored, f.secrets, f.dependencies);
    engines.push(engine);
    await engine.refresh();
    expect(f.trace).toEqual(['local', 'discord']);
    expect(restored.state.localDedupe[id]).toBe(NOW);
    expect(restored.state.dedupe[id]).toBe(NOW);
    await Promise.all([engine.refresh(), engine.refresh()]);
    const { revision: _revision, ...edited } = restored.state.rules[0];
    void _revision;
    await engine.saveRule(edited);
    await settle(engine);
    engine.stop();
    const restartedStore = new Store(f.store.directory);
    await restartedStore.load();
    const restart = new Engine(restartedStore, f.secrets, f.dependencies);
    engines.push(restart);
    await restart.refresh();
    expect(f.trace).toEqual(['local', 'discord']);
    expect(restartedStore.state.localOutbox).toHaveLength(0);
    expect(restartedStore.state.outbox).toHaveLength(0);
  });
  it('works without a webhook or encryption; first alert, repeat, overlap, new and unavailable-to-available', async () => {
    const f = await fixture();
    await f.store.mutate((s) => s.rules.push({ ...rule, id: 'overlap' }));
    await f.engine.refresh();
    await f.engine.refresh();
    expect(f.notifyLocal).toHaveBeenCalledTimes(1);
    f.setSessions([session, { ...session, showingId: 'b', isBookable: false }]);
    await f.engine.refresh();
    expect(f.notifyLocal).toHaveBeenCalledTimes(1);
    f.setSessions([session, { ...session, showingId: 'b' }]);
    await f.engine.refresh();
    await f.engine.refresh();
    expect(f.notifyLocal).toHaveBeenCalledTimes(2);
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.engine.snapshot().hasWebhook).toBe(false);
    expect(f.store.state.localDedupe[sessionIdentity({ ...session, showingId: 'b' })]).toBe(NOW);
    expect(f.store.state.history[0].kind).toBe('localRequested');
  });
  it('durably marks before displaying and awaits local result before Discord; retry/restart does not repeat local', async () => {
    const f = await fixture(true);
    await f.store.mutate((s) => s.rules.push({ ...rule, id: 'overlap' }));
    f.setSessions([{ ...session, showingId: 'new' }]);
    let release!: (result: LocalAlertResult) => void;
    f.notifyLocal.mockImplementationOnce(async () => {
      f.trace.push('local-pending');
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    f.deliver.mockImplementationOnce(async () => {
      f.trace.push('discord-retry');
      return { kind: 'retry', delayMs: 120000, detail: 'mock 429' };
    });
    const discovery = f.engine.refresh();
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(f.deliver).not.toHaveBeenCalled();
    const disk = JSON.parse(await readFile(f.store.file, 'utf8'));
    expect(disk.localOutbox).toHaveLength(0);
    expect(disk.localDedupe[sessionIdentity({ ...session, showingId: 'new' })]).toBe(NOW);
    expect(disk.outbox).toHaveLength(1);
    expect(disk.outbox[0].ruleRefs).toEqual([
      { id: rule.id, revision: 1 },
      { id: 'overlap', revision: 1 },
    ]);
    release({ kind: 'requested' });
    await discovery;
    expect(f.trace).toEqual(['local-pending', 'discord-retry']);
    f.engine.stop();
    const store = new Store(f.store.directory);
    await store.load();
    f.advance(120000);
    const restart = new Engine(store, f.secrets, f.dependencies);
    engines.push(restart);
    await restart.refresh();
    expect(f.notifyLocal).toHaveBeenCalledTimes(1);
    expect(f.deliver).toHaveBeenCalledTimes(2);
    expect(store.state.outbox).toHaveLength(0);
  });
  it('adding a webhook alerts only the previously unhandled Discord destination', async () => {
    const f = await fixture(true);
    await f.store.mutate((s) => {
      delete s.secret.encrypted;
    });
    await f.engine.refresh();
    expect(f.notifyLocal).toHaveBeenCalledTimes(1);
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.store.state.dedupe).toEqual({});
    await f.engine.saveWebhook(webhook);
    await settle(f.engine);
    await f.engine.refresh();
    expect(f.notifyLocal).toHaveBeenCalledTimes(1);
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(f.store.state.dedupe[sessionIdentity(session)]).toBe(NOW);
  });
  it.each([false, true])(
    're-enabling local alerts only the unhandled local destination (webhook=%s)',
    async (hasWebhook) => {
      const f = await fixture(hasWebhook);
      await f.store.mutate((s) => {
        s.settings.shouldNotifyLocally = false;
      });
      await f.engine.refresh();
      expect(f.notifyLocal).not.toHaveBeenCalled();
      expect(f.deliver).toHaveBeenCalledTimes(hasWebhook ? 1 : 0);
      expect(f.store.state.localDedupe).toEqual({});
      await f.engine.updateSettings({ shouldNotifyLocally: true });
      await settle(f.engine);
      await f.engine.refresh();
      expect(f.notifyLocal).toHaveBeenCalledTimes(1);
      expect(f.deliver).toHaveBeenCalledTimes(hasWebhook ? 1 : 0);
      expect(f.store.state.localDedupe[sessionIdentity(session)]).toBe(NOW);
    },
  );
  it('first-query backlog drains ten local identities per tick and Discord follows each local attempt', async () => {
    const f = await fixture(true);
    const sessions = Array.from({ length: 13 }, (_, index) => ({
      ...session,
      showingId: `bookable-${index}`,
    }));
    f.setSessions(sessions);
    f.deliver.mockImplementation(async (_url, delivered) => {
      expect(f.notifyLocal.mock.calls.map(([item]) => sessionIdentity(item))).toContain(
        sessionIdentity(delivered),
      );
      return { kind: 'sent' };
    });
    await f.engine.refresh();
    expect(f.notifyLocal).toHaveBeenCalledTimes(10);
    expect(f.store.state.localOutbox.map((item) => item.id)).toEqual(
      [...sessions].sort(compareSessions).slice(10).map(sessionIdentity),
    );
    expect(f.store.state.outbox).toHaveLength(12);
    f.advance(1000);
    await f.engine.refresh();
    const attempted = f.notifyLocal.mock.calls.map(([item]) => sessionIdentity(item));
    expect(attempted).toEqual([...sessions].sort(compareSessions).map(sessionIdentity));
    expect(new Set(attempted).size).toBe(13);
    expect(f.store.state.localOutbox).toHaveLength(0);
    expect(f.deliver).toHaveBeenCalledTimes(2);
    await f.engine.refresh();
    expect(f.notifyLocal).toHaveBeenCalledTimes(13);
  });
  it.each(['failed', 'unsupported'] as const)(
    'local %s falls back to Discord and reports an accurate warning',
    async (kind) => {
      const f = await fixture(true);
      f.notifyLocal.mockImplementationOnce(async () => {
        f.trace.push('local');
        return { kind };
      });
      f.setSessions([{ ...session, showingId: 'b' }]);
      await f.engine.refresh();
      expect(f.trace).toEqual(['local', 'discord']);
      expect(f.engine.snapshot().localAlertWarning).toBeTruthy();
      expect(f.store.state.history.some((h) => h.kind === 'localFailed')).toBe(true);
    },
  );
  it('webhook replacement does not cancel local display; local off cancels only local pending and completed attempts stay suppressed on enable', async () => {
    const f = await fixture(true);
    f.setSessions([]);
    await f.engine.refresh();
    f.setSessions([{ ...session, showingId: 'b' }]);
    let release!: (value: LocalAlertResult) => void;
    f.notifyLocal.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.engine.refresh();
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    const signal = f.notifyLocal.mock.calls[0][1];
    await f.engine.saveWebhook(webhook.replace(/x/gu, 'y'));
    expect(signal.aborted).toBe(false);
    release({ kind: 'requested' });
    await pending;
    await settle(f.engine);
    expect(f.notifyLocal).toHaveBeenCalledTimes(1);
    expect(f.store.state.localDedupe[sessionIdentity({ ...session, showingId: 'b' })]).toBe(NOW);
    await f.engine.setPaused(true);
    const q: LocalOutboxItem = {
      id: 'pending',
      session,
      ruleRefs: [{ id: rule.id, revision: 1 }],
      createdAt: NOW,
      nextAt: NOW,
      attempts: 0,
    };
    await f.store.mutate((s) => {
      s.localOutbox.push(q);
      s.localDedupe.pending = 0;
      s.outbox.push({ ...q, secretRevision: s.secret.revision });
    });
    await f.engine.updateSettings({ shouldNotifyLocally: false });
    expect(f.store.state.localOutbox).toHaveLength(0);
    expect(f.store.state.outbox).toHaveLength(1);
    await f.engine.updateSettings({ shouldNotifyLocally: true });
    await f.engine.setPaused(false);
    await settle(f.engine);
    expect(f.notifyLocal).toHaveBeenCalledTimes(1);
  });
  it('pause/rule invalidation aborts both destinations and late local result cannot commit history', async () => {
    const f = await fixture(true);
    f.setSessions([]);
    await f.engine.refresh();
    f.setSessions([{ ...session, showingId: 'b' }]);
    let release!: (value: LocalAlertResult) => void;
    f.notifyLocal.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.engine.refresh();
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    await f.engine.setPaused(true);
    expect(f.notifyLocal.mock.calls[0][1].aborted).toBe(true);
    release({ kind: 'requested' });
    await pending;
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.store.state.history).toHaveLength(0);
    await f.engine.deleteRule(rule.id);
    expect(f.store.state.outbox).toHaveLength(0);
    expect(f.store.state.localOutbox).toHaveLength(0);
  });
  it('bounds local queue/age/dedupe and drains a batch even when no webhook exists', async () => {
    const f = await fixture();
    f.setSessions([]);
    const q = (id: string, createdAt = NOW): LocalOutboxItem => ({
      id,
      session: { ...session, showingId: id },
      ruleRefs: [{ id: rule.id, revision: 1 }],
      createdAt,
      nextAt: NOW,
      attempts: 0,
    });
    await f.store.mutate((s) => {
      s.localOutbox = [
        q('expired', NOW - 86400000),
        ...Array.from({ length: 105 }, (_, index) => q(`q${index}`)),
      ];
      s.localDedupe = Object.fromEntries(s.localOutbox.map((item) => [item.id, 0]));
    });
    expect(f.engine.snapshot().nextAt).toBe(NOW);
    await f.engine.refresh();
    expect(f.notifyLocal).toHaveBeenCalledTimes(10);
    expect(f.store.state.localOutbox).toHaveLength(90);
    expect(f.engine.snapshot().localPendingCount).toBe(90);
    expect(f.store.state.history.some((h) => h.kind === 'overflow')).toBe(true);
    expect(f.store.state.history.some((h) => h.kind === 'expired')).toBe(true);
    expect(f.engine.snapshot().nextAt).toBe(NOW);
  });
});
describe('CGV business date engine scheduling', () => {
  it('queries the previous business date until 05:59 then removes it from deadlines at 06:00', async () => {
    const f = await fixture();
    await f.store.mutate((s) => {
      s.rules = [{ ...rule, provider: 'cgv', date: '2026-10-20' }];
    });
    f.advance(Date.parse('2026-10-20T15:00:00Z') - NOW);
    await f.engine.refresh();
    expect(f.provider).toHaveBeenCalledTimes(1);
    f.advance(6 * 3600000 - 1);
    await f.engine.refresh();
    expect(f.provider).toHaveBeenCalledTimes(2);
    f.advance(1);
    await f.engine.refresh();
    expect(f.provider).toHaveBeenCalledTimes(2);
    expect(f.engine.snapshot().nextAt).toBeUndefined();
  });
});

describe('earliest future priorities and local capacity', () => {
  it('orders all future formats and all rule queues globally, while snapshot summaries stay runtime-only', async () => {
    const f = await fixture(true);
    await f.store.mutate((state) => {
      state.rules = [
        { ...rule, format: 'ALL' },
        { ...rule, id: 'other', theaterId: 'other', format: 'ALL' },
      ];
    });
    const sessions = [
      { ...session, time: '18:00', showingId: 'late' },
      { ...session, time: '10:00', format: 'IMAX' as const, showingId: 'early' },
      { ...session, time: '12:00', format: 'DOLBY' as const, showingId: 'middle' },
      { ...session, time: '09:00', showingId: 'exact-now' },
      { ...session, time: '08:59', showingId: 'past' },
      {
        ...session,
        theaterId: 'other',
        time: '09:30',
        format: 'UNKNOWN' as const,
        showingId: 'global-earliest',
      },
    ];
    f.setSessions(sessions);
    await f.engine.refresh();
    expect(f.notifyLocal.mock.calls.map(([item]) => item.showingId)).toEqual([
      'global-earliest',
      'early',
    ]);
    expect(f.deliver.mock.calls[0][1].showingId).toBe('global-earliest');
    expect(f.engine.snapshot().earliestByRule?.[rule.id].session).toMatchObject({
      time: '10:00',
      format: 'IMAX',
    });
    expect(f.engine.snapshot().earliestByRule?.other.session).toMatchObject({
      time: '09:30',
      format: 'UNKNOWN',
    });
    expect(await readFile(f.store.file, 'utf8')).not.toContain('earliestByRule');
    f.advance(3600000);
    expect(f.engine.snapshot().earliestByRule?.[rule.id].session?.time).toBe('12:00');
    await f.engine.setPaused(true);
    const { revision: _revision, ...input } = f.store.state.rules[0];
    void _revision;
    await f.engine.saveRule({ ...input, format: 'IMAX' });
    expect(f.engine.snapshot().earliestByRule?.[rule.id]).toBeUndefined();
  });
  it('retains earliest 100 future candidates under reverse overflow and keeps all first-query alerts', async () => {
    const f = await fixture();
    f.dependencies.isLocalAlertReady = () => false;
    const sessions = Array.from({ length: 105 }, (_, i) => ({
      ...session,
      showingId: `show-${i}`,
      time: `${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
    }));
    f.setSessions([...sessions].reverse());
    await f.engine.refresh();
    expect(f.notifyLocal).not.toHaveBeenCalled();
    expect(f.store.state.localOutbox.map((item) => item.session.time)).toEqual(
      sessions.slice(0, 100).map((item) => item.time),
    );
    expect(f.store.state.history.filter((item) => item.kind === 'overflow')).toHaveLength(5);
    expect(f.store.state.history[0].detail).toContain('가장 늦은');
    expect(Object.values(f.store.state.localDedupe).every((value) => value === 0)).toBe(true);
    expect(f.engine.snapshot().nextAt).toBe(NOW + 1000);
  });
  it('does not consume a full popup queue, and scheduler retry resumes without provider polling', async () => {
    const f = await fixture(true);
    let ready = false;
    f.dependencies.isLocalAlertReady = () => ready;
    f.setSessions([
      { ...session, time: '18:00', showingId: 'later' },
      { ...session, time: '10:00', showingId: 'earliest' },
    ]);
    await f.engine.refresh();
    expect(f.store.state.localOutbox).toHaveLength(2);
    expect(f.notifyLocal).not.toHaveBeenCalled();
    expect(f.deliver).not.toHaveBeenCalled();
    expect(
      f.store.state.localDedupe[
        sessionIdentity({ ...session, time: '10:00', showingId: 'earliest' })
      ],
    ).toBe(0);
    ready = true;
    f.advance(1000);
    await new Promise((resolve) => setTimeout(resolve, 1050));
    await settle(f.engine);
    expect(f.provider).toHaveBeenCalledTimes(1);
    expect(f.notifyLocal.mock.calls.map(([item]) => item.showingId)).toEqual(['earliest', 'later']);
    expect(f.deliver.mock.calls[0][1].showingId).toBe('earliest');
  });
  it('skips a due Discord head blocked by its local queue and respects retry deadlines', async () => {
    const f = await fixture(true);
    f.dependencies.isLocalAlertReady = () => false;
    f.setSessions([]);
    const a = { ...session, time: '10:00', showingId: 'a' };
    const b = { ...session, time: '11:00', showingId: 'b' };
    const queue = (item: Session) => ({
      id: sessionIdentity(item),
      session: item,
      ruleRefs: [{ id: rule.id, revision: 1 }],
      createdAt: NOW,
      nextAt: NOW,
      attempts: 0,
    });
    await f.store.mutate((state) => {
      state.localOutbox = [queue(a)];
      state.localDedupe[sessionIdentity(a)] = 0;
      state.localDedupe[sessionIdentity(b)] = NOW - 1;
      state.outbox = [
        { ...queue(a), secretRevision: 1 },
        { ...queue(b), secretRevision: 1 },
      ];
      state.dedupe[sessionIdentity(a)] = 0;
      state.dedupe[sessionIdentity(b)] = 0;
    });
    await f.engine.refresh();
    expect(f.deliver.mock.calls.map(([, item]) => item.showingId)).toEqual(['b']);
    expect(f.store.state.outbox[0].session.showingId).toBe('a');
    expect(f.store.state.localOutbox).toHaveLength(1);
    f.dependencies.isLocalAlertReady = () => true;
    f.notifyLocal.mockResolvedValueOnce({ kind: 'unsupported' });
    await f.engine.refresh();
    expect(f.notifyLocal).toHaveBeenCalledTimes(1);
    expect(f.deliver).toHaveBeenCalledTimes(1);
    f.advance(1000);
    await f.engine.refresh();
    expect(f.deliver.mock.calls.map(([, item]) => item.showingId)).toEqual(['b', 'a']);
    expect(f.store.state.localOutbox).toHaveLength(0);
    expect(f.store.state.outbox).toHaveLength(0);
  });
  it('compares the CGV previous day at 00:30 and suppresses exact or past business-hour starts', async () => {
    const f = await fixture();
    await f.store.mutate((state) => {
      state.rules = [{ ...rule, provider: 'cgv', date: '2026-10-20', format: 'ALL' }];
    });
    f.advance(Date.parse('2026-10-20T15:30:00Z') - NOW);
    f.setSessions(
      ['29:00', '25:00', '24:30', '24:20', '23:00'].map((time) => ({
        ...session,
        provider: 'cgv',
        date: '2026-10-20',
        time,
        showingId: time,
        format: 'IMAX',
      })),
    );
    await f.engine.refresh();
    expect(f.notifyLocal.mock.calls.map(([item]) => item.time)).toEqual(['25:00']);
    expect(f.engine.snapshot().earliestByRule?.[rule.id].session?.time).toBe('25:00');
  });
});

describe('power lifecycle while provider work is outstanding', () => {
  it.each(['optout', 'delete-last-rule'] as const)(
    'publishes %s and releases immediately before a held provider returns',
    async (change) => {
      const f = await fixture();
      await f.store.mutate((state) => {
        state.settings.shouldKeepAwake = true;
      });
      let release!: (sessions: Session[]) => void;
      f.provider.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const active = new Set<number>();
      const policy = new PowerPolicy(
        {
          start: () => {
            active.add(1);
            return 1;
          },
          stop: (id) => {
            active.delete(id);
          },
          isStarted: (id) => active.has(id),
        },
        () => ({
          settings: f.store.state.settings,
          rules: f.store.state.rules,
          isStarted: f.engine.isStarted,
          isOnline: f.engine.isOnline,
          isSuspended: f.engine.isSuspended,
        }),
        (state) => {
          f.engine.isKeepingAwake = state.isKeepingAwake;
        },
      );
      const off = f.engine.subscribe(policy.reconcile);
      try {
        f.engine.start();
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        expect(active.size).toBe(1);
        if (change === 'optout') await f.engine.updateSettings({ shouldKeepAwake: false });
        else await f.engine.deleteRule(rule.id);
        expect(f.engine.snapshot().isChecking).toBe(true);
        expect(active.size).toBe(0);
        expect(f.engine.snapshot().isKeepingAwake).toBe(false);
        expect(f.provider).toHaveBeenCalledTimes(1);
      } finally {
        release([]);
        await settle(f.engine);
        off();
        policy.dispose();
      }
    },
  );
});
