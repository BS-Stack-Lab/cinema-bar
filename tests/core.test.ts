import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Store, createState } from '../electron/store.js';
import { SecretStore, type SecretCodec } from '../electron/secretStore.js';
import { Engine } from '../electron/engine.js';
import { LoginSettings } from '../electron/lifecycle.js';
import { createDiscord, discordPayload, type DeliveryResult } from '../electron/discord.js';
import {
  createProviders,
  parseCgv,
  parseLotte,
  parseMegabox,
  ProviderError,
  retryAfter,
  type ProviderAdapter,
} from '../electron/providers/index.js';
import {
  bookingUrl,
  koreanToday,
  matches,
  sessionIdentity,
  validateRule,
  validateSettings,
  validateState,
  validateWebhook,
} from '../electron/validation.js';
import { validateIpc, validateSender } from '../electron/ipc.js';
import type { OutboxItem, Session } from '../electron/types.js';
import { cgv, lotte, megabox, NOW, rule, session } from './fixtures.js';
const directories: string[] = [];
const engines: Engine[] = [];
function codec(isAvailable = true): SecretCodec {
  const key = randomBytes(32);
  return {
    isAvailable: () => isAvailable,
    encrypt(value) {
      const iv = randomBytes(16);
      const cipher = createCipheriv('aes-256-cbc', key, iv);
      return Buffer.concat([iv, cipher.update(value), cipher.final()]);
    },
    decrypt(value) {
      const cipher = createDecipheriv('aes-256-cbc', key, value.subarray(0, 16));
      return Buffer.concat([cipher.update(value.subarray(16)), cipher.final()]).toString();
    },
  };
}
function webhook(suffix = 'x') {
  return `https://discord.com/api/webhooks/123456789/${suffix.repeat(40)}`;
}
async function storeFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cinema-test-'));
  directories.push(directory);
  const store = new Store(directory);
  await store.load();
  return store;
}
async function fixture() {
  const store = await storeFixture();
  const secrets = new SecretStore(codec());
  await store.mutate((s) => {
    s.rules = [structuredClone(rule)];
    s.secret = { encrypted: secrets.encode(webhook()), revision: 1, isTerminal: false };
  });
  let now = NOW;
  let sessions: Session[] = [structuredClone(session)];
  const provider = vi.fn<ProviderAdapter>(async () => sessions);
  const deliver = vi.fn(async (): Promise<DeliveryResult> => ({ kind: 'sent' }));
  const engine = new Engine(store, secrets, {
    providers: { cgv: provider, megabox: provider, lottecinema: provider },
    deliver,
    now: () => now,
    random: () => 0,
  });
  engines.push(engine);
  return {
    store,
    secrets,
    provider,
    deliver,
    engine,
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
function pending(id: string, createdAt = NOW): OutboxItem {
  return {
    id,
    session: { ...session, showingId: id },
    ruleRefs: [{ id: rule.id, revision: rule.revision }],
    secretRevision: 1,
    createdAt,
    nextAt: NOW,
    attempts: 0,
  };
}
afterEach(async () => {
  engines.splice(0).forEach((engine) => engine.stop());
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
describe('QA provider and predicate boundaries', () => {
  it('provider fixture contracts: current routes, strict parsers and HTTP limits', async () => {
    expect(parseMegabox(megabox)[0]).toMatchObject(session);
    expect(parseCgv(cgv)[0]).toMatchObject({ provider: 'cgv', format: 'IMAX', isBookable: true });
    expect(
      parseLotte(
        lotte,
        { ...rule, provider: 'lottecinema' },
        { id: 'movie-1', title: '별의 영화' },
      )[0],
    ).toMatchObject({ provider: 'lottecinema', format: '2D', isBookable: true });
    expect(() => parseMegabox({ movieFormList: [] })).toThrow();
    expect(() => parseMegabox({ statCd: 4, movieFormList: [] })).toThrow();
    expect(() => parseCgv({ statusCode: 0, data: [{}] })).toThrow();
    expect(() => parseLotte({ IsOK: true }, rule, { id: '1', title: 'x' })).toThrow();
    const blocked = createProviders(async () => new Response('blocked', { status: 403 }));
    await expect(blocked.cgv(rule, new AbortController().signal)).rejects.toThrow('HTTP 403');
    const calls: string[] = [];
    const adapters = createProviders(async (url) => {
      calls.push(url);
      if (url.includes('megabox')) return Response.json(megabox);
      if (url.includes('cgv')) return Response.json(cgv);
      return Response.json({
        IsOK: true,
        Cinemas: {
          Cinemas: { Items: [{ CinemaID: '1016', DivisionCode: 1, DetailDivisionCode: 1 }] },
        },
        Movies: {
          Movies: { Items: [{ RepresentationMovieCode: 'movie-1', MovieNameKR: '별의 영화' }] },
        },
      });
    });
    await adapters.megabox(rule, new AbortController().signal);
    await adapters.cgv(rule, new AbortController().signal);
    expect(calls[0]).toContain('/selectBokdList.do');
    expect(calls[1]).toContain('/api/v1/booking/searchMovScnInfo?');
    const lotteFetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          IsOK: true,
          Cinemas: {
            Cinemas: { Items: [{ CinemaID: '1016', DivisionCode: 1, DetailDivisionCode: 1 }] },
          },
          Movies: {
            Movies: { Items: [{ RepresentationMovieCode: 'movie-1', MovieNameKR: '별의 영화' }] },
          },
        }),
      )
      .mockResolvedValueOnce(Response.json(lotte));
    expect(
      await createProviders(lotteFetch).lottecinema(
        { ...rule, provider: 'lottecinema', theaterId: '1016' },
        new AbortController().signal,
      ),
    ).toHaveLength(1);
    expect(String((lotteFetch.mock.calls[1][1].body as FormData).get('paramList'))).toContain(
      'GetPlaySequence',
    );
    const unknownFlag = structuredClone(megabox);
    unknownFlag.movieFormList[0].bokdAbleAt = '';
    expect(parseMegabox(unknownFlag)[0].isBookable).toBe(false);
    const unknownLotte = structuredClone(lotte);
    unknownLotte.PlaySeqs.Items[0].IsBookingYN = '';
    expect(parseLotte(unknownLotte, rule, { id: '1', title: 'x' })[0].isBookable).toBe(false);
  });
  it('predicate-cross-product: each saved field, exact title, unknown format, Korean date and identity', () => {
    expect(matches(rule, session)).toBe(true);
    for (const change of [
      { provider: 'cgv' },
      { theaterId: 'other' },
      { movieTitle: '별의 영화 확장' },
      { date: '2099-01-02' },
      { format: 'UNKNOWN' },
      { isBookable: false },
    ])
      expect(matches(rule, { ...session, ...change } as Session)).toBe(false);
    expect(matches({ ...rule, movieTitle: '  별의   영화  ' }, session)).toBe(true);
    expect(matches({ ...rule, movieId: 'movie-1' }, { ...session, movieTitle: '다른 번역' })).toBe(
      true,
    );
    expect(matches({ ...rule, movieId: 'different' }, session)).toBe(false);
    expect(koreanToday(Date.parse('2026-10-20T14:59:59Z'))).toBe('2026-10-20');
    expect(koreanToday(Date.parse('2026-10-20T15:00:00Z'))).toBe('2026-10-21');
    expect(sessionIdentity({ ...session, date: '2099-01-02' })).not.toBe(sessionIdentity(session));
    expect(sessionIdentity({ ...session, bookingUrl: session.bookingUrl + '?tracking=1' })).toBe(
      sessionIdentity(session),
    );
  });
  it('rule-validation: rejects invalid and oversized dates, fields and intervals', () => {
    for (const input of [
      { movieTitle: '' },
      { theaterId: '' },
      { theaterId: 'x'.repeat(25) },
      { date: '2020-01-01' },
      { date: '2099-02-30' },
      { format: '' },
      { isEnabled: 1 },
    ])
      expect(() =>
        validateRule({
          id: rule.id,
          provider: rule.provider,
          theaterId: rule.theaterId,
          theaterName: rule.theaterName,
          movieTitle: rule.movieTitle,
          date: rule.date,
          format: rule.format,
          isEnabled: rule.isEnabled,
          ...input,
        }),
      ).toThrow();
    const { revision: _r, ...input } = rule;
    void _r;
    expect(validateRule(input)).toMatchObject({ movieTitle: rule.movieTitle });
    for (const seconds of [0, 59, 3601, 1.5, '120'])
      expect(() => validateSettings({ intervalSeconds: seconds })).toThrow();
    expect(() => validateRule({ ...input, movieTitle: 'x'.repeat(121) })).toThrow();
  });
});
describe('QA engine durable state', () => {
  it('first-baseline-errors: errors never seed baseline; first revision is quiet', async () => {
    const f = await fixture();
    f.provider.mockRejectedValueOnce(new ProviderError('공급자 오류'));
    await f.engine.refresh();
    expect(f.store.state.progress[rule.id].baseline).toBeUndefined();
    expect(f.store.state.progress[rule.id].lastSuccess).toBeUndefined();
    await f.engine.refresh();
    expect(f.deliver).not.toHaveBeenCalled();
    const before = f.store.state.progress[rule.id].lastSuccess;
    f.provider.mockRejectedValueOnce(new Error('raw provider content'));
    await f.engine.refresh();
    expect(f.store.state.progress[rule.id].lastSuccess).toBe(before);
    expect(f.store.state.progress[rule.id].error).not.toContain('raw');
    f.setSessions([session, { ...session, showingId: 'new' }]);
    await f.engine.refresh();
    expect(f.deliver).toHaveBeenCalledTimes(1);
    await f.engine.refresh();
    expect(f.deliver).toHaveBeenCalledTimes(1);
    const { revision: _r, movieId: _m, ...input } = f.store.state.rules[0];
    void _r;
    void _m;
    await f.engine.saveRule({ ...input, movieTitle: '별의 영화' });
    await settle(f.engine);
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(f.store.state.rules[0].revision).toBe(2);
  });
  it('dedupe-and-old-rule-work: overlapping rules, merged refresh, edit/delete and pause', async () => {
    const f = await fixture();
    await f.store.mutate((s) => s.rules.push({ ...rule, id: 'rule-2' }));
    await f.engine.refresh();
    f.setSessions([session, { ...session, showingId: 'new' }]);
    await Promise.all([f.engine.refresh(), f.engine.refresh()]);
    expect(f.deliver).toHaveBeenCalledTimes(1);
    let release!: (value: Session[]) => void;
    f.provider.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const refresh = f.engine.refresh();
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    const deletion = f.engine.deleteRule(rule.id);
    release([{ ...session, showingId: 'stale' }]);
    await deletion;
    await refresh;
    await settle(f.engine);
    expect(f.store.state.progress[rule.id]).toBeUndefined();
    expect(f.store.state.outbox.some((q) => q.session.showingId === 'stale')).toBe(false);
    await f.engine.setPaused(true);
    const calls = f.provider.mock.calls.length;
    await f.engine.refresh();
    expect(f.provider).toHaveBeenCalledTimes(calls);
  });
  it('webhook-secret-boundary: encrypted bytes only, no snapshot secret, unavailable storage', async () => {
    const f = await fixture();
    await f.engine.setPaused(true);
    await f.engine.saveWebhook(webhook('y'));
    const disk = await readFile(f.store.file, 'utf8');
    expect(disk).not.toContain('yyyyyyyy');
    expect(JSON.stringify(f.engine.snapshot())).not.toContain('webhooks');
    expect(f.secrets.decode(f.store.state.secret.encrypted)).toContain('/api/v10/webhooks/');
    const unavailable = new SecretStore(codec(false));
    expect(() => unavailable.encode(webhook())).toThrow('OS 암호화');
    expect(() => unavailable.decode(f.store.state.secret.encrypted)).toThrow();
    await f.engine.deleteWebhook();
    expect(f.store.state.secret.encrypted).toBeUndefined();
    expect(f.store.state.outbox).toHaveLength(0);
  });
  it('secret-revision-regression: replace during delayed send never restores old pending', async () => {
    const f = await fixture();
    await f.engine.refresh();
    f.setSessions([session, { ...session, showingId: 'new' }]);
    let release!: (value: DeliveryResult) => void;
    f.deliver.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const refresh = f.engine.refresh();
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    await f.engine.saveWebhook(webhook('z'));
    release({ kind: 'sent' });
    await refresh;
    await settle(f.engine);
    expect(f.store.state.outbox).toHaveLength(0);
    expect(f.store.state.history.filter((h) => h.kind === 'sent')).toHaveLength(0);
    const restart = new Store(f.store.directory);
    await restart.load();
    expect(restart.state.secret.revision).toBe(2);
    expect(restart.state.outbox).toHaveLength(0);
  });
  it('durable-outbox-restart: production discovery persists B before delivery and recovers one success', async () => {
    const f = await fixture();
    await f.engine.refresh();
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.store.state.outbox).toHaveLength(0);
    const discovered = { ...session, showingId: 'discovered-b' };
    const discoveredId = sessionIdentity(discovered);
    f.setSessions([session, discovered]);
    let releaseDelivery!: (result: DeliveryResult) => void;
    let signalDeliveryStarted!: () => void;
    const deliveryStarted = new Promise<void>((resolve) => {
      signalDeliveryStarted = resolve;
    });
    f.deliver.mockImplementationOnce(
      () =>
        new Promise<DeliveryResult>((resolve) => {
          releaseDelivery = resolve;
          signalDeliveryStarted();
        }),
    );
    const discovery = f.engine.refresh();
    await deliveryStarted;
    const persisted = validateState(JSON.parse(await readFile(f.store.file, 'utf8')));
    expect(persisted.outbox).toHaveLength(1);
    expect(persisted.outbox[0]).toMatchObject({
      id: discoveredId,
      session: discovered,
      secretRevision: 1,
    });
    expect(persisted.dedupe[discoveredId]).toBe(0);
    expect(persisted.progress[rule.id].baseline?.[discoveredId]).toBe(true);
    expect(persisted.history.filter((item) => item.kind === 'sent')).toHaveLength(0);
    f.engine.stop();
    releaseDelivery({ kind: 'retry', delayMs: 0, detail: '중단된 모의 전송' });
    await discovery;
    const store = new Store(f.store.directory);
    await store.load();
    expect(store.state.outbox.map((item) => item.id)).toEqual([discoveredId]);
    const recoveredDelivery = vi.fn(async (): Promise<DeliveryResult> => ({ kind: 'sent' }));
    const engine = new Engine(store, f.secrets, {
      providers: { cgv: f.provider, megabox: f.provider, lottecinema: f.provider },
      deliver: recoveredDelivery,
      now: () => NOW,
      random: () => 0,
    });
    engines.push(engine);
    await engine.refresh();
    expect(recoveredDelivery).toHaveBeenCalledTimes(1);
    expect(recoveredDelivery).toHaveBeenCalledWith(
      expect.any(String),
      discovered,
      expect.any(AbortSignal),
    );
    expect(store.state.outbox).toHaveLength(0);
    expect(store.state.dedupe[discoveredId]).toBe(NOW);
    expect(store.state.history.filter((item) => item.kind === 'sent')).toHaveLength(1);
    await engine.refresh();
    expect(recoveredDelivery).toHaveBeenCalledTimes(1);
    expect(store.state.outbox).toHaveLength(0);
    expect(store.state.history.filter((item) => item.kind === 'sent')).toHaveLength(1);
    const payload = discordPayload({
      ...session,
      movieTitle: '@everyone ' + '長'.repeat(5000),
      bookingUrl: 'https://example.com',
    });
    expect(payload.allowed_mentions.parse).toEqual([]);
    expect(payload.content.length).toBeLessThanOrEqual(1900);
    expect(payload.content).not.toContain('example.com');
  });
  it('outbox-retention: 100 item limit, expiry, stale rule revisions and bounded history', async () => {
    const f = await fixture();
    await f.store.mutate((s) => {
      s.secret.isTerminal = true;
      s.outbox = [
        pending('old', NOW - 86400000),
        ...Array.from({ length: 105 }, (_, i) => pending(`q${i}`)),
        { ...pending('stale'), ruleRefs: [{ id: rule.id, revision: 9 }] },
      ];
    });
    await f.engine.refresh();
    expect(f.store.state.outbox).toHaveLength(100);
    expect(f.store.state.outbox.some((q) => ['old', 'stale'].includes(q.id))).toBe(false);
    expect(f.store.state.history.some((h) => h.kind === 'overflow')).toBe(true);
    expect(f.store.state.history.some((h) => h.kind === 'expired')).toBe(true);
    expect(f.store.state.history.length).toBeLessThanOrEqual(100);
  });
  it('discord-rate-and-terminal-errors: deadlines, backoff, permanent stop and replacement', async () => {
    const f = await fixture();
    await f.store.mutate((s) => s.outbox.push(pending('q')));
    f.deliver.mockResolvedValueOnce({ kind: 'retry', delayMs: 120000, detail: 'rate limit' });
    await f.engine.refresh();
    expect(f.store.state.outbox[0].nextAt).toBe(NOW + 120000);
    f.advance(119999);
    await f.engine.refresh();
    expect(f.deliver).toHaveBeenCalledTimes(1);
    f.advance(1);
    f.deliver.mockResolvedValueOnce({ kind: 'terminal', detail: '웹훅을 교체하세요.' });
    await f.engine.refresh();
    expect(f.engine.snapshot().isWebhookBlocked).toBe(true);
    f.advance(3600000);
    await f.engine.refresh();
    expect(f.deliver).toHaveBeenCalledTimes(2);
    await f.engine.saveWebhook(webhook('z'));
    await settle(f.engine);
    expect(f.engine.snapshot().isWebhookBlocked).toBe(false);
    expect(f.store.state.outbox).toHaveLength(0);
    const retry = createDiscord(async () =>
      Response.json({ retry_after: 12.5 }, { status: 429, headers: { 'Retry-After': '20' } }),
    );
    expect(await retry(webhook(), session, new AbortController().signal)).toMatchObject({
      kind: 'retry',
      delayMs: 20000,
    });
    for (const code of [401, 403, 404])
      expect(
        await createDiscord(async () => new Response('', { status: code }))(
          webhook(),
          session,
          new AbortController().signal,
        ),
      ).toMatchObject({ kind: 'terminal' });
    expect(
      await createDiscord(async () => new Response('', { status: 503 }))(
        webhook(),
        session,
        new AbortController().signal,
      ),
    ).toMatchObject({ kind: 'retry' });
    expect(
      await createDiscord(async () => {
        throw new Error('private response');
      })(webhook(), session, new AbortController().signal),
    ).toMatchObject({ kind: 'retry' });
    expect(retryAfter(new Date(NOW + 20000).toUTCString(), NOW)).toBe(20000);
  });
  it('suspend-generation-and-online: abort late callbacks and one recovery for bursts', async () => {
    const f = await fixture();
    let release!: (value: Session[]) => void;
    f.provider.mockImplementationOnce(
      (_r, signal) =>
        new Promise((resolve) => {
          expect(signal.aborted).toBe(false);
          release = resolve;
        }),
    );
    const request = f.engine.refresh();
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    f.engine.suspend();
    expect(f.provider.mock.calls[0][1].aborted).toBe(true);
    release([session]);
    await request;
    expect(f.store.state.progress[rule.id]).toBeUndefined();
    f.engine.resume();
    f.engine.resume();
    f.engine.setOnline(true);
    f.engine.setOnline(true);
    await settle(f.engine);
    expect(f.provider).toHaveBeenCalledTimes(2);
    f.engine.setOnline(false);
    await f.engine.refresh();
    expect(f.provider).toHaveBeenCalledTimes(2);
    f.engine.setOnline(true);
    f.engine.setOnline(true);
    await settle(f.engine);
    expect(f.provider).toHaveBeenCalledTimes(3);
  });
  it('empty-and-error-states / recovery-regression: factual timestamps and paused/missing/error metadata', async () => {
    const f = await fixture();
    f.setSessions([]);
    await f.engine.refresh();
    expect(f.store.state.progress[rule.id].count).toBe(0);
    const success = f.store.state.progress[rule.id].lastSuccess;
    f.provider.mockRejectedValueOnce(new ProviderError('HTTP 403'));
    f.advance(120000);
    await f.engine.refresh();
    expect(f.store.state.progress[rule.id].lastSuccess).toBe(success);
    expect(f.store.state.progress[rule.id].lastFailure).toBe(NOW + 120000);
    expect(f.store.state.progress[rule.id].error).toContain('403');
    await f.engine.deleteWebhook();
    await settle(f.engine);
    expect(f.engine.snapshot().hasWebhook).toBe(false);
    await f.engine.setPaused(true);
    expect(f.engine.snapshot().settings.isPaused).toBe(true);
  });
  it('rule-crud-restart: three providers, revisions, disable/delete and isolation', async () => {
    const f = await fixture();
    await f.engine.setPaused(true);
    const { id: _id, revision: _r, ...input } = rule;
    void _id;
    void _r;
    await f.engine.saveRule({ ...input, provider: 'cgv' });
    await f.engine.saveRule({ ...input, provider: 'lottecinema' });
    const current = f.store.state.rules[0];
    const { revision: _v, movieId: _m, ...edit } = current;
    void _v;
    void _m;
    await f.engine.saveRule({ ...edit, isEnabled: false });
    await f.engine.deleteRule(f.store.state.rules[1].id);
    const restart = new Store(f.store.directory);
    await restart.load();
    expect(restart.state.rules).toHaveLength(2);
    expect(restart.state.rules.find((r) => r.id === current.id)).toMatchObject({
      revision: 2,
      isEnabled: false,
    });
  });
});

describe('QA deadline and commit regressions', () => {
  it('provider Retry-After survives manual refresh and restart', async () => {
    const f = await fixture();
    f.provider.mockRejectedValueOnce(new ProviderError('HTTP 429', 240000));
    await f.engine.refresh();
    await f.engine.refresh();
    expect(f.provider).toHaveBeenCalledTimes(1);
    f.advance(239999);
    await f.engine.refresh();
    expect(f.provider).toHaveBeenCalledTimes(1);
    f.engine.stop();
    const store = new Store(f.store.directory);
    await store.load();
    const engine = new Engine(store, f.secrets, {
      providers: { cgv: f.provider, megabox: f.provider, lottecinema: f.provider },
      deliver: f.deliver,
      now: () => NOW + 239999,
    });
    engines.push(engine);
    await engine.refresh();
    expect(f.provider).toHaveBeenCalledTimes(1);
    f.advance(1);
    const restored = new Engine(store, f.secrets, {
      providers: { cgv: f.provider, megabox: f.provider, lottecinema: f.provider },
      deliver: f.deliver,
      now: () => NOW + 240000,
    });
    engines.push(restored);
    await restored.refresh();
    expect(f.provider).toHaveBeenCalledTimes(2);
  });
  it('Discord 429 global deadline survives restart with another queued item', async () => {
    const f = await fixture();
    await f.store.mutate((s) => {
      s.outbox = [pending('q1'), pending('q2')];
    });
    f.deliver.mockResolvedValueOnce({ kind: 'retry', delayMs: 240000, detail: 'rate limit' });
    await f.engine.refresh();
    f.engine.stop();
    const store = new Store(f.store.directory);
    await store.load();
    const engine = new Engine(store, f.secrets, {
      providers: { cgv: f.provider, megabox: f.provider, lottecinema: f.provider },
      deliver: f.deliver,
      now: () => NOW + 239999,
    });
    engines.push(engine);
    await engine.refresh();
    expect(f.deliver).toHaveBeenCalledTimes(1);
    const after = new Engine(store, f.secrets, {
      providers: { cgv: f.provider, megabox: f.provider, lottecinema: f.provider },
      deliver: f.deliver,
      now: () => NOW + 240000,
    });
    engines.push(after);
    await after.refresh();
    expect(f.deliver).toHaveBeenCalledTimes(2);
  });
  it('cancelled generation cannot commit while atomic write is preparing', async () => {
    const store = await storeFixture();
    await store.mutate((s) => {
      s.secret.revision = 1;
    });
    let release!: () => void;
    let hasEntered = false;
    const delayed = new Store(
      store.directory,
      () =>
        new Promise<void>((resolve) => {
          hasEntered = true;
          release = resolve;
        }),
    );
    await delayed.load();
    let isCurrent = true;
    const mutation = delayed.mutate(
      (s) => {
        s.secret.revision = 2;
      },
      () => isCurrent,
    );
    while (!hasEntered) await new Promise((resolve) => setTimeout(resolve, 1));
    isCurrent = false;
    release();
    await mutation;
    expect(delayed.state.secret.revision).toBe(1);
    expect(JSON.parse(await readFile(store.file, 'utf8')).secret.revision).toBe(1);
  });
});

describe('QA persistence, login and IPC', () => {
  it('atomic-storage-recovery: serialization, write failure, backup, double corruption and future schema', async () => {
    const store = await storeFixture();
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.mutate((s) => {
          s.secret.revision++;
        }),
      ),
    );
    expect(store.state.secret.revision).toBe(20);
    expect(JSON.parse(await readFile(store.file, 'utf8')).secret.revision).toBe(20);
    const failing = new Store(store.directory, async () => {
      throw new Error('before rename');
    });
    await failing.load();
    await expect(
      failing.mutate((s) => {
        s.secret.revision++;
      }),
    ).rejects.toThrow('before rename');
    expect(JSON.parse(await readFile(store.file, 'utf8')).secret.revision).toBe(20);
    await writeFile(store.file, 'broken');
    const recovered = new Store(store.directory);
    await recovered.load();
    expect(recovered.recoveryError).toBeUndefined();
    expect(recovered.state.secret.revision).toBe(19);
    await writeFile(store.file, 'broken-primary');
    await writeFile(`${store.file}.backup`, 'broken-backup');
    const blocked = new Store(store.directory);
    await blocked.load();
    expect(blocked.recoveryError).toBeTruthy();
    await expect(
      blocked.mutate((s) => {
        s.rules = [];
      }),
    ).rejects.toThrow();
    expect(await readFile(store.file, 'utf8')).toBe('broken-primary');
    await blocked.recover();
    expect(blocked.recoveryError).toBeUndefined();
    await writeFile(store.file, JSON.stringify({ schemaVersion: 99 }));
    const future = new Store(store.directory);
    await future.load();
    expect(future.recoveryError).toContain('새 버전');
    expect(JSON.parse(await readFile(store.file, 'utf8')).schemaVersion).toBe(99);
    expect(() => validateState({ ...createState(), settings: {} })).toThrow();
  });
  it('user-data-isolation / manual-network-and-resource-scope: profiles never share state or recipient', async () => {
    const first = await fixture();
    const second = await fixture();
    await first.engine.setPaused(true);
    await second.engine.setPaused(true);
    await first.engine.saveWebhook(webhook('a'));
    await second.engine.saveWebhook(webhook('b'));
    expect(first.secrets.decode(first.store.state.secret.encrypted)).not.toBe(
      second.secrets.decode(second.store.state.secret.encrypted),
    );
    await first.engine.deleteRule(rule.id);
    expect(second.store.state.rules).toHaveLength(1);
    first.engine.setOnline(false);
    expect(first.engine.snapshot().isOnline).toBe(false);
    expect(second.engine.snapshot().isOnline).toBe(true);
  });
  it('ipc-and-url-rejection: strict payload, exact sender, allowed origins and no redirects', () => {
    const frame = {};
    expect(() => validateSender(frame, frame, 'file://app', 'file://app')).not.toThrow();
    expect(() => validateSender({}, frame, 'file://app', 'file://app')).toThrow();
    expect(() => validateSender(frame, frame, 'https://evil.test', 'file://app')).toThrow();
    for (const [channel, value] of [
      ['unknown', {}],
      ['getSnapshot', {}],
      ['saveRule', { path: '/etc/passwd' }],
      ['setPaused', 1],
      ['deleteRule', 'x'.repeat(1000)],
      ['updateSettings', { file: '/tmp/a' }],
      ['openBooking', { provider: 'megabox', url: 'https://evil.test/booking' }],
    ])
      expect(() => validateIpc(String(channel), value)).toThrow();
    for (const value of [
      'http://discord.com/api/webhooks/123456/' + 'x'.repeat(40),
      webhook() + '?redirect=1',
      webhook().replace('discord.com', 'user@discord.com'),
      webhook().replace('discord.com', 'discord.com:444'),
      'https://example.com/a',
    ])
      expect(() => validateWebhook(value)).toThrow();
    for (const url of [
      'https://www.megabox.co.kr/booking?redirect=https://evil.test',
      'https://a@www.megabox.co.kr/booking',
      'https://www.megabox.co.kr:444/booking',
      'https://www.megabox.co.kr/not-booking',
    ])
      expect(bookingUrl('megabox', url)).toBe('');
  });
  it('login-setting-roundtrip: packaged default, persisted opt-out, dev never registers', async () => {
    const store = await storeFixture();
    let value = false;
    const set = vi.fn((next: boolean) => {
      value = next;
    });
    const login = new LoginSettings({ isPackaged: true, set, get: () => value }, store);
    await login.initialize();
    expect(value).toBe(true);
    await login.apply(false);
    const restart = new Store(store.directory);
    await restart.load();
    await new LoginSettings({ isPackaged: true, set, get: () => value }, restart).initialize();
    expect(set).toHaveBeenCalledTimes(2);
    expect(restart.state.settings.shouldStartAtLogin).toBe(false);
    const dev = new LoginSettings({ isPackaged: false, set, get: () => value }, restart);
    await dev.initialize();
    await dev.apply(true);
    expect(set).toHaveBeenCalledTimes(2);
  });
});
