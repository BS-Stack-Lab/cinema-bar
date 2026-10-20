// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App';
import { status } from '../src/status';
import type { CinemaApi, Snapshot } from '../electron/types';
import { rule, NOW } from './fixtures';
const empty: Snapshot = {
  rules: [],
  settings: {
    intervalSeconds: 120,
    isPaused: false,
    shouldStartAtLogin: true,
    hasConfiguredLogin: true,
  },
  progress: {},
  history: [],
  pendingCount: 0,
  hasWebhook: false,
  isWebhookBlocked: false,
  isEncryptionAvailable: true,
  isOnline: true,
  isSuspended: false,
  isChecking: false,
  storagePath: '/tmp/isolated-user-data',
};
function mount(snapshot = empty) {
  const saveRule = vi.fn(async (input) => ({
    ...snapshot,
    rules: [{ ...input, id: 'saved', revision: 1 }],
  }));
  const api = {
    getSnapshot: vi.fn(async () => snapshot),
    onSnapshot: vi.fn(() => () => undefined),
    saveRule,
    deleteRule: vi.fn(async () => snapshot),
    setPaused: vi.fn(async () => snapshot),
    saveWebhook: vi.fn(async () => ({ ...snapshot, hasWebhook: true })),
    deleteWebhook: vi.fn(async () => snapshot),
    updateSettings: vi.fn(async () => snapshot),
    refresh: vi.fn(async () => snapshot),
    openBooking: vi.fn(),
    recoverStorage: vi.fn(async () => snapshot),
    quit: vi.fn(),
  } as CinemaApi;
  window.cinema = api;
  render(<App />);
  return { api, saveRule };
}
afterEach(cleanup);
describe('QA accessible renderer', () => {
  it('tray-and-tabs: four named tabs, keyboard arrow focus and first empty state', async () => {
    mount();
    await screen.findByRole('heading', { name: /Cinema Bar/ });
    expect(screen.getByRole('button', { name: /첫 감시 추가/ })).toBeTruthy();
    const user = userEvent.setup();
    const dashboard = screen.getByRole('tab', { name: '대시보드' });
    dashboard.focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: '감시 목록' }));
    expect(screen.getByRole('tab', { name: '감시 목록' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    await user.click(screen.getByRole('tab', { name: '알림 기록' }));
    expect(screen.getByText('아직 보낸 알림이 없어요')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: '설정' }));
    expect(screen.getByLabelText('개인 웹훅 주소').getAttribute('type')).toBe('password');
  });
  it('UI-1: pausing the dashboard reports zero operating rules and preserves the saved total', async () => {
    const snapshot = { ...empty, rules: [rule], hasWebhook: true };
    const { api } = mount(snapshot);
    await screen.findByRole('heading', { name: /Cinema Bar/ });
    const card = screen.getByRole('article', { name: '감시 상태 요약' });
    expect(within(card).getByText('01')).toBeTruthy();
    expect(within(card).getByText('/ 1')).toBeTruthy();
    vi.mocked(api.setPaused).mockResolvedValueOnce({
      ...snapshot,
      settings: { ...snapshot.settings, isPaused: true },
    });
    await userEvent.setup().click(screen.getByRole('button', { name: '전체 감시 일시 정지' }));
    await waitFor(() => expect(within(card).getByText('00')).toBeTruthy());
    expect(api.setPaused).toHaveBeenCalledWith(true);
    expect(within(card).getByText('/ 1')).toBeTruthy();
    expect(screen.getByRole('button', { name: '감시 재개' })).toBeTruthy();
  });
  it.each([
    ['offline', { isOnline: false }],
    ['suspended', { isSuspended: true }],
    ['recovery', { recoveryError: '저장 파일 복구 필요' }],
    ['expired', { rules: [{ ...rule, date: '2000-01-01' }] }],
  ] satisfies [string, Partial<Snapshot>][])(
    'UI-1: %s rules are not counted as operating',
    async (_name, patch) => {
      mount({ ...empty, rules: [rule], hasWebhook: true, ...patch });
      await screen.findByRole('heading', { name: /Cinema Bar/ });
      const card = screen.getByRole('article', { name: '감시 상태 요약' });
      expect(within(card).getByText('00')).toBeTruthy();
      expect(within(card).getByText('/ 1')).toBeTruthy();
    },
  );
  it('rule-validation: actionable inline rejection and canceled edits never save', async () => {
    const { saveRule } = mount();
    await screen.findByRole('heading', { name: /Cinema Bar/ });
    fireEvent.click(screen.getByRole('button', { name: /첫 감시 추가/ }));
    fireEvent.change(screen.getByLabelText('극장 ID'), { target: { value: '1372' } });
    fireEvent.change(screen.getByLabelText('극장 이름'), { target: { value: '코엑스' } });
    fireEvent.change(screen.getByLabelText('작품 제목'), { target: { value: '   ' } });
    fireEvent.submit(screen.getByRole('button', { name: '감시 저장' }).closest('form')!);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(saveRule).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(screen.queryByLabelText('작품 제목')).toBeNull();
  });
  it('rule-crud-restart: form submits only saved validated fields and secret input clears', async () => {
    const { api, saveRule } = mount();
    await screen.findByRole('heading', { name: /Cinema Bar/ });
    fireEvent.click(screen.getByRole('button', { name: /첫 감시 추가/ }));
    for (const [label, value] of [
      ['극장 ID', '1372'],
      ['극장 이름', '코엑스'],
      ['작품 제목', '별의 영화'],
      ['상영일', '2099-01-01'],
    ])
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    expect(saveRule).not.toHaveBeenCalled();
    fireEvent.submit(screen.getByRole('button', { name: '감시 저장' }).closest('form')!);
    await waitFor(() => expect(saveRule).toHaveBeenCalledTimes(1));
    expect(saveRule.mock.calls[0][0]).toMatchObject({ theaterId: '1372', movieTitle: '별의 영화' });
    fireEvent.click(screen.getByRole('tab', { name: '설정' }));
    fireEvent.change(screen.getByLabelText('개인 웹훅 주소'), {
      target: { value: 'fixture-input' },
    });
    fireEvent.submit(screen.getByRole('button', { name: '안전하게 연결' }).closest('form')!);
    await waitFor(() => expect(api.saveWebhook).toHaveBeenCalled());
    expect((screen.getByLabelText('개인 웹훅 주소') as HTMLInputElement).value).toBe('');
  });
  it('empty-and-error-states: distinct provider/offline/pause/webhook labels and timestamps', () => {
    const current = {
      ...empty,
      rules: [rule],
      hasWebhook: true,
      progress: {
        [rule.id]: {
          revision: 1,
          failures: 1,
          nextAt: NOW + 120000,
          count: 0,
          lastSuccess: NOW,
          lastFailure: NOW + 1000,
          error: 'HTTP 403',
        },
      },
    };
    expect(status(current, rule)).toBe('공급자 오류');
    expect(status({ ...current, isOnline: false }, rule)).toBe('네트워크 대기');
    expect(status({ ...current, settings: { ...current.settings, isPaused: true } }, rule)).toBe(
      '일시 정지',
    );
    expect(status({ ...empty, rules: [rule], hasWebhook: false })).toBe('웹훅 연결 필요');
    expect(status({ ...empty, hasWebhook: true, isWebhookBlocked: true })).toBe('웹훅 오류');
    expect(status({ ...current, isChecking: true }, rule)).toBe('확인 중');
  });
  it('render-regression: long collections and history retain named controls and text', async () => {
    const rules = Array.from({ length: 40 }, (_, i) => ({
      ...rule,
      id: `r${i}`,
      movieTitle: `긴 작품 ${i}`,
    }));
    mount({
      ...empty,
      rules,
      history: [{ id: 'h1', kind: 'failed', at: NOW, title: '작품', detail: '웹훅을 교체하세요.' }],
    });
    await screen.findByRole('heading', { name: /Cinema Bar/ });
    fireEvent.click(screen.getByRole('tab', { name: '감시 목록' }));
    expect(screen.getAllByRole('checkbox', { name: /감시 활성화/ })).toHaveLength(40);
    expect(screen.getByRole('button', { name: '긴 작품 39 수정' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '알림 기록' }));
    expect(screen.getByText('웹훅을 교체하세요.')).toBeTruthy();
  });
});
