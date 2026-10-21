import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createState, migrateState, Store } from '../electron/store';
import { validateState, sessionIdentity } from '../electron/validation';
import { Engine } from '../electron/engine';
import { SecretStore } from '../electron/secretStore';
import type { Session, State } from '../electron/types';
import { NOW, rule, session } from './fixtures';
const directories: string[] = [];
const engines: Engine[] = [];
const cgvRule = { ...rule, id: 'cgv-rule', provider: 'cgv' as const, theaterId: '0013' };
const cgvSession = {
  ...session,
  provider: 'cgv' as const,
  theaterId: '0013',
  showingId: '2099-01-01-0013-1',
  bookingUrl: 'https://www.cgv.co.kr/cnm/booking',
};
function legacy() {
  const state = createState();
  state.rules = [structuredClone(rule), cgvRule];
  state.secret = { encrypted: 'c2VjcmV0', revision: 7, isTerminal: false };
  state.progress = {
    [rule.id]: {
      revision: 1,
      baseline: { [sessionIdentity(session)]: true },
      failures: 0,
      nextAt: NOW + 100000,
      count: 1,
      lastSuccess: NOW,
    },
    [cgvRule.id]: {
      revision: 1,
      baseline: { [sessionIdentity(cgvSession)]: true },
      failures: 0,
      nextAt: NOW + 100000,
      count: 1,
      lastSuccess: NOW,
    },
  };
  state.outbox = [session, cgvSession].map((item, index) => ({
    id: sessionIdentity(item),
    session: item,
    ruleRefs: [{ id: index === 0 ? rule.id : cgvRule.id, revision: 1 }],
    secretRevision: 7,
    createdAt: NOW,
    nextAt: NOW,
    attempts: 0,
  }));
  state.dedupe = Object.fromEntries(state.outbox.map((item) => [item.id, 0]));
  state.dedupe.completed = NOW - 1000;
  state.history = [
    { id: 'past', at: NOW - 1000, kind: 'sent', title: '기존 전송', detail: '보존 이력' },
  ];
  const { localDedupe: _dedupe, localOutbox: _outbox, ...old } = state;
  void _dedupe;
  void _outbox;
  const { shouldNotifyLocally: _setting, ...settings } = old.settings;
  void _setting;
  return { ...old, schemaVersion: 1, settings };
}
async function directory() {
  const value = await mkdtemp(path.join(os.tmpdir(), 'cinema-migration-'));
  directories.push(value);
  return value;
}
afterEach(async () => {
  engines.splice(0).forEach((engine) => engine.stop());
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
describe('explicit schema one to two migration', () => {
  it('preserves full non-CGV state and secret, quietly resets CGV identity and seeds only valid pending local work', async () => {
    const old = legacy();
    const migrated = migrateState(old, NOW);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.secret).toEqual(old.secret);
    expect(migrated.settings).toMatchObject(old.settings);
    expect(migrated.settings.shouldNotifyLocally).toBe(true);
    expect(migrated.rules).toEqual(old.rules);
    expect(migrated.progress[rule.id]).toEqual(old.progress[rule.id]);
    expect(migrated.progress[cgvRule.id].baseline).toBeUndefined();
    expect(migrated.progress[cgvRule.id].nextAt).toBe(NOW);
    expect(migrated.outbox).toEqual([old.outbox[0]]);
    expect(migrated.localOutbox).toHaveLength(1);
    expect(migrated.localOutbox[0].id).toBe(old.outbox[0].id);
    expect(migrated.localDedupe.completed).toBeUndefined();
    expect(migrated.dedupe.completed).toBe(old.dedupe.completed);
    expect(migrated.history).toContainEqual(old.history[0]);
    expect(migrated.history[0].kind).toBe('cancelled');
    expect(migrated.history[0].detail).toContain('CGV');
    const dir = await directory();
    const file = path.join(dir, 'state.json');
    const bytes = JSON.stringify(old);
    await writeFile(file, bytes);
    const store = new Store(dir);
    await store.load();
    expect(store.recoveryError).toBeUndefined();
    expect(store.state.schemaVersion).toBe(2);
    expect(await readFile(`${file}.backup`, 'utf8')).toBe(bytes);
    const restart = new Store(dir);
    await restart.load();
    expect(restart.state).toEqual(store.state);
  });
  it('recovers pending work and alerts first-query CGV while preserving destination-specific completed records', async () => {
    const dir = await directory();
    const completed = { ...session, showingId: 'already-sent-discord' };
    const completedId = sessionIdentity(completed);
    const recoveredId = sessionIdentity(session);
    const old = legacy();
    old.dedupe[completedId] = NOW - 1000;
    await writeFile(path.join(dir, 'state.json'), JSON.stringify(old));
    const store = new Store(dir);
    await store.load();
    const trace: { destination: 'local' | 'discord'; id: string }[] = [];
    let now = NOW;
    let cgvSessions = [{ ...cgvSession, showingId: '0013-2099-01-01-001-1' }];
    const firstCgvId = sessionIdentity(cgvSessions[0]);
    const secrets = new SecretStore({
      isAvailable: () => true,
      encrypt: (value) => Buffer.from(value),
      decrypt: () => 'https://discord.com/api/webhooks/123456789/' + 'x'.repeat(40),
    });
    const dependencies = {
      providers: {
        cgv: async () => cgvSessions,
        megabox: async () => [session, completed],
        lottecinema: async () => [],
      },
      deliver: async (_url: string, item: Session) => {
        trace.push({ destination: 'discord', id: sessionIdentity(item) });
        return { kind: 'sent' as const };
      },
      notifyLocal: async (item: Session) => {
        trace.push({ destination: 'local', id: sessionIdentity(item) });
        return { kind: 'requested' as const };
      },
      now: () => now,
      random: () => 0,
    };
    const engine = new Engine(store, secrets, dependencies);
    engines.push(engine);
    await engine.refresh();
    const expected: typeof trace = [
      { destination: 'local', id: firstCgvId },
      // Schema one has no local completion record, even when Discord was already sent.
      { destination: 'local', id: completedId },
      { destination: 'local', id: recoveredId },
      { destination: 'discord', id: firstCgvId },
    ];
    expect(trace).toEqual(expected);
    expect(store.state.progress[cgvRule.id].baseline?.[firstCgvId]).toBe(true);
    expect(store.state.localDedupe).toMatchObject({
      [recoveredId]: NOW,
      [completedId]: NOW,
      [firstCgvId]: NOW,
    });
    expect(store.state.dedupe[completedId]).toBe(NOW - 1000);
    expect(store.state.dedupe[firstCgvId]).toBe(NOW);
    expect(store.state.outbox.map((item) => item.id)).toEqual([recoveredId]);
    expect(store.state.localOutbox).toHaveLength(0);
    await engine.refresh();
    expect(trace).toEqual(expected);
    now += 1000;
    await engine.refresh();
    expected.push({ destination: 'discord', id: recoveredId });
    expect(trace).toEqual(expected);
    expect(store.state.outbox).toHaveLength(0);
    cgvSessions = [...cgvSessions, { ...cgvSessions[0], showingId: '0013-2099-01-01-002-1' }];
    const nextCgvId = sessionIdentity(cgvSessions[1]);
    await engine.refresh();
    expected.push({ destination: 'local', id: nextCgvId });
    expect(trace).toEqual(expected);
    now += 1000;
    await engine.refresh();
    expected.push({ destination: 'discord', id: nextCgvId });
    expect(trace).toEqual(expected);
    const persisted = validateState(JSON.parse(await readFile(store.file, 'utf8')));
    expect(persisted.localOutbox).toHaveLength(0);
    expect(persisted.outbox).toHaveLength(0);
    expect(persisted.dedupe).toMatchObject({
      [completedId]: NOW - 1000,
      [recoveredId]: NOW + 1000,
      [firstCgvId]: NOW,
      [nextCgvId]: NOW + 2000,
    });
    expect(persisted.localDedupe).toMatchObject({
      [recoveredId]: NOW,
      [completedId]: NOW,
      [firstCgvId]: NOW,
      [nextCgvId]: NOW + 1000,
    });
    expect(store.state.dedupe.completed).toBe(NOW - 1000);
    engine.stop();
    const restored = new Store(dir);
    await restored.load();
    const restarted = new Engine(restored, secrets, dependencies);
    engines.push(restarted);
    now += 1000;
    await restarted.refresh();
    expect(trace).toEqual(expected);
    expect(restored.state.outbox).toHaveLength(0);
    expect(restored.state.localOutbox).toHaveLength(0);
  });
  it('rejects incomplete legacy or present modern fields, and validates every new field instead of overwriting it', () => {
    for (const patch of [
      { localOutbox: null },
      { localOutbox: [] },
      { localDedupe: {} },
      { settings: { ...legacy().settings, shouldNotifyLocally: 'false' } },
      { settings: {} },
    ])
      expect(() => migrateState({ ...legacy(), ...patch }, NOW)).toThrow();
    for (const patch of [
      { localOutbox: null },
      { localDedupe: null },
      { localDedupe: { x: -1 } },
      { settings: { ...createState().settings, shouldNotifyLocally: 1 } },
    ])
      expect(() => validateState({ ...createState(), ...patch })).toThrow();
    const invalid = createState() as Partial<State>;
    delete invalid.localOutbox;
    expect(() => validateState(invalid)).toThrow();
  });
  it('migration write failure preserves originals and blocks monitoring instead of falling back to a backup', async () => {
    const dir = await directory();
    const file = path.join(dir, 'state.json');
    const primary = JSON.stringify(legacy());
    const backup = JSON.stringify({ ...legacy(), secret: { revision: 0, isTerminal: false } });
    await writeFile(file, primary);
    await writeFile(`${file}.backup`, backup);
    const store = new Store(dir, async () => {
      throw new Error('injected before rename');
    });
    await store.load();
    expect(store.recoveryError).toContain('변환');
    expect(await readFile(file, 'utf8')).toBe(primary);
    expect(await readFile(`${file}.backup`, 'utf8')).toBe(backup);
    await expect(store.mutate(() => undefined)).rejects.toThrow();
  });
  it('recovers JSON or shape-corrupt primary from last valid backup while preserving corrupt bytes', async () => {
    for (const primary of ['invalid-json', JSON.stringify({ ...createState(), settings: {} })]) {
      const dir = await directory();
      const file = path.join(dir, 'state.json');
      const backup = createState();
      backup.secret.revision = 8;
      await writeFile(file, primary);
      await writeFile(`${file}.backup`, JSON.stringify(backup));
      const store = new Store(dir);
      await store.load();
      expect(store.recoveryError).toBeUndefined();
      expect(store.state.secret.revision).toBe(8);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(backup);
      const { readdir } = await import('node:fs/promises');
      const preserved = (await readdir(dir)).find((name) => name.includes('.corrupt-'))!;
      expect(await readFile(path.join(dir, preserved), 'utf8')).toBe(primary);
    }
  });
  it('future schema and double corruption stop without replacing either original', async () => {
    for (const [primary, backup] of [
      [JSON.stringify({ schemaVersion: 3 }), JSON.stringify(createState())],
      [JSON.stringify({ ...createState(), localOutbox: null }), 'bad-backup'],
      [JSON.stringify({ ...legacy(), localDedupe: null }), 'bad-backup'],
    ]) {
      const dir = await directory();
      const file = path.join(dir, 'state.json');
      await writeFile(file, primary);
      await writeFile(`${file}.backup`, backup);
      const store = new Store(dir);
      await store.load();
      expect(store.recoveryError).toBeTruthy();
      expect(await readFile(file, 'utf8')).toBe(primary);
      expect(await readFile(`${file}.backup`, 'utf8')).toBe(backup);
    }
  });
});

describe('optional keep-awake compatibility', () => {
  it.each([undefined, false, true])(
    'reads schema 2 value %s without rewriting normal old bytes',
    async (value) => {
      const state = createState();
      state.rules = [structuredClone(rule)];
      state.history = [
        { id: 'preserved', at: NOW, kind: 'sent', title: 'keep', detail: 'preserved' },
      ];
      if (value === undefined) delete state.settings.shouldKeepAwake;
      else state.settings.shouldKeepAwake = value;
      const dir = await directory();
      const file = path.join(dir, 'state.json');
      const bytes = JSON.stringify(state);
      await writeFile(file, bytes);
      const store = new Store(dir);
      await store.load();
      expect(store.recoveryError).toBeUndefined();
      expect(store.state.settings.shouldKeepAwake === true).toBe(value === true);
      expect(await readFile(file, 'utf8')).toBe(bytes);
      expect(store.state.rules).toEqual(state.rules);
      expect(store.state.history).toEqual(state.history);
    },
  );
  it('defaults new profiles to false and leaves absent schema 1 settings absent through migration', () => {
    expect(createState().settings.shouldKeepAwake).toBe(false);
    const old = legacy();
    delete old.settings.shouldKeepAwake;
    const state = migrateState(old, NOW);
    expect(state.settings.shouldKeepAwake === true).toBe(false);
    expect(state.secret).toEqual(old.secret);
  });
  it.each(['true', 0, null])(
    'rejects present non-boolean %s without replacing corrupt source',
    async (value) => {
      for (const base of [createState(), legacy()]) {
        const state = { ...base, settings: { ...base.settings, shouldKeepAwake: value } };
        expect(() => validateState(state, base.schemaVersion === 1)).toThrow();
        const dir = await directory();
        const file = path.join(dir, 'state.json');
        const bytes = JSON.stringify(state);
        await writeFile(file, bytes);
        const store = new Store(dir);
        await store.load();
        expect(store.recoveryError).toBeTruthy();
        expect(await readFile(file, 'utf8')).toBe(bytes);
      }
    },
  );
});
