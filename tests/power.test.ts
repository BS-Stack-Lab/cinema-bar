import { afterEach, describe, expect, it, vi } from 'vitest';
import { PowerPolicy, type PowerState } from '../electron/power';
import { createState } from '../electron/store';
import { rule, NOW } from './fixtures';
afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  let now = NOW;
  const state: PowerState = {
    settings: { ...createState().settings, shouldKeepAwake: true },
    rules: [structuredClone(rule)],
    isStarted: true,
    isOnline: true,
    isSuspended: false,
  };
  const ids = new Set<number>();
  let last = 0;
  const adapter = {
    start: vi.fn(() => {
      ids.add(++last);
      return last;
    }),
    stop: vi.fn((id: number) => {
      ids.delete(id);
    }),
    isStarted: vi.fn((id: number) => ids.has(id)),
  };
  const publish = vi.fn();
  const policy = new PowerPolicy(
    adapter,
    () => state,
    publish,
    () => now,
  );
  return {
    state,
    ids,
    adapter,
    publish,
    policy,
    setNow: (value: number) => {
      now = value;
    },
  };
}
describe('optional native power policy', () => {
  it('owns exactly one prevent-app-suspension ID and publishes only changes', () => {
    const f = fixture();
    f.policy.reconcile();
    f.policy.reconcile();
    expect(f.adapter.start).toHaveBeenCalledExactlyOnceWith('prevent-app-suspension');
    expect(f.publish).toHaveBeenCalledExactlyOnceWith({
      isKeepingAwake: true,
      keepAwakeWarning: undefined,
    });
    f.state.settings.isPaused = true;
    f.policy.reconcile();
    f.policy.reconcile();
    expect(f.ids.size).toBe(0);
    expect(f.adapter.stop).toHaveBeenCalledTimes(1);
    f.state.settings.isPaused = false;
    f.policy.reconcile();
    expect(f.ids.size).toBe(1);
    f.policy.dispose();
    f.policy.dispose();
    expect(f.ids.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    'offline',
    'suspend',
    'stopped',
    'recovery',
    'disabled',
    'deleted',
    'optout',
    'missing',
  ] as const)('releases on %s and resumes only for eligible active work', (condition) => {
    const f = fixture();
    f.policy.reconcile();
    if (condition === 'offline') f.state.isOnline = false;
    if (condition === 'suspend') f.state.isSuspended = true;
    if (condition === 'stopped') f.state.isStarted = false;
    if (condition === 'recovery') f.state.recoveryError = 'recovery';
    if (condition === 'disabled') f.state.rules[0].isEnabled = false;
    if (condition === 'deleted') f.state.rules = [];
    if (condition === 'optout') f.state.settings.shouldKeepAwake = false;
    if (condition === 'missing') delete f.state.settings.shouldKeepAwake;
    f.policy.reconcile();
    expect(f.ids.size).toBe(0);
    f.policy.dispose();
  });
  it('rechecks midnight and the CGV business cutoff within 60 seconds', () => {
    const f = fixture();
    f.state.rules = [{ ...rule, provider: 'cgv', date: '2026-10-20' }];
    f.setNow(Date.parse('2026-10-20T20:59:59Z'));
    f.policy.reconcile();
    expect(f.ids.size).toBe(1);
    f.setNow(Date.parse('2026-10-20T21:00:00Z'));
    vi.advanceTimersByTime(60000);
    expect(f.ids.size).toBe(0);
    f.state.rules = [{ ...rule, date: '2026-10-21' }];
    f.setNow(Date.parse('2026-10-21T14:59:59Z'));
    f.policy.reconcile();
    expect(f.ids.size).toBe(1);
    f.setNow(Date.parse('2026-10-21T15:00:00Z'));
    vi.advanceTimersByTime(60000);
    expect(f.ids.size).toBe(0);
    f.policy.dispose();
  });
  it('reports start failure without changing opt-in and recovers an externally lost ID', () => {
    const f = fixture();
    f.adapter.start.mockImplementationOnce(() => {
      throw new Error('native failed');
    });
    f.policy.reconcile();
    expect(f.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ isKeepingAwake: false, keepAwakeWarning: expect.any(String) }),
    );
    expect(f.state.settings.shouldKeepAwake).toBe(true);
    vi.advanceTimersByTime(60000);
    expect(f.ids.size).toBe(1);
    f.ids.clear();
    f.policy.reconcile();
    expect(f.ids.size).toBe(1);
    f.policy.dispose();
  });
});

describe('native power release failure', () => {
  it('reports the actual owned blocker and retries release after opt-out without changing the setting', () => {
    const f = fixture();
    f.policy.reconcile();
    f.adapter.stop.mockImplementationOnce(() => {
      throw new Error('native busy');
    });
    f.state.settings.shouldKeepAwake = false;
    f.policy.reconcile();
    expect(f.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ isKeepingAwake: true, keepAwakeWarning: expect.any(String) }),
    );
    expect(f.state.settings.shouldKeepAwake).toBe(false);
    vi.advanceTimersByTime(60000);
    expect(f.ids.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    f.policy.dispose();
  });
});
