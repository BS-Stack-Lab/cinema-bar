import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Engine } from '../electron/engine';
import { Store } from '../electron/store';
import { SecretStore } from '../electron/secretStore';
import { sessionIdentity } from '../electron/validation';
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
  const deliver = vi.fn(async (): Promise<DeliveryResult> => {
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
  it('works without a webhook or encryption; quiet first baseline, repeat, overlap, new and unavailable-to-available', async () => {
    const f = await fixture();
    await f.store.mutate((s) => s.rules.push({ ...rule, id: 'overlap' }));
    await f.engine.refresh();
    await f.engine.refresh();
    expect(f.notifyLocal).not.toHaveBeenCalled();
    f.setSessions([session, { ...session, showingId: 'b', isBookable: false }]);
    await f.engine.refresh();
    expect(f.notifyLocal).not.toHaveBeenCalled();
    f.setSessions([session, { ...session, showingId: 'b' }]);
    await f.engine.refresh();
    await f.engine.refresh();
    expect(f.notifyLocal).toHaveBeenCalledTimes(1);
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.engine.snapshot().hasWebhook).toBe(false);
    expect(f.store.state.localDedupe[sessionIdentity({ ...session, showingId: 'b' })]).toBe(NOW);
    expect(f.store.state.history[0].kind).toBe('localRequested');
  });
  it('durably marks before displaying and awaits local result before Discord; retry/restart does not repeat local', async () => {
    const f = await fixture(true);
    await f.engine.refresh();
    f.setSessions([session, { ...session, showingId: 'new' }]);
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
  it.each(['failed', 'unsupported'] as const)(
    'local %s falls back to Discord and reports an accurate warning',
    async (kind) => {
      const f = await fixture(true);
      await f.engine.refresh();
      f.notifyLocal.mockImplementationOnce(async () => {
        f.trace.push('local');
        return { kind };
      });
      f.setSessions([session, { ...session, showingId: 'b' }]);
      await f.engine.refresh();
      expect(f.trace).toEqual(['local', 'discord']);
      expect(f.engine.snapshot().localAlertWarning).toBeTruthy();
      expect(f.store.state.history.some((h) => h.kind === 'localFailed')).toBe(true);
    },
  );
  it('webhook replacement does not cancel local display; local off cancels only local pending and does not replay baseline on enable', async () => {
    const f = await fixture(true);
    await f.engine.refresh();
    f.setSessions([session, { ...session, showingId: 'b' }]);
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
    await f.engine.refresh();
    f.setSessions([session, { ...session, showingId: 'b' }]);
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
