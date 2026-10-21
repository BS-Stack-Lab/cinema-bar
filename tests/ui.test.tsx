// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App';
import { UpdateCard } from '../src/UpdateCard';
import { status } from '../src/status';
import type { CinemaApi, Snapshot, UpdateState } from '../electron/types';
import { catalogFixture, rule, NOW } from './fixtures';
const empty: Snapshot = {
  rules: [],
  settings: {
    intervalSeconds: 120,
    isPaused: false,
    shouldStartAtLogin: true,
    hasConfiguredLogin: true,
    shouldNotifyLocally: true,
  },
  progress: {},
  history: [],
  pendingCount: 0,
  localPendingCount: 0,
  isLocalAlertSupported: true,
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
    getUpdateState: vi.fn(async () => ({
      revision: 0,
      phase: 'idle',
      currentVersion: '0.2.0',
      platformLabel: 'macOS · Apple Silicon · DMG',
    })),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    cancelUpdate: vi.fn(),
    openUpdateInstaller: vi.fn(),
    onUpdateState: vi.fn(() => () => undefined),
    getSnapshot: vi.fn(async () => snapshot),
    getPoster: vi.fn(async () => ({})),
    cancelPoster: vi.fn(async () => undefined),
    getCatalog: vi.fn(async ({ provider }) => catalogFixture(provider)),
    cancelCatalog: vi.fn(async () => undefined),
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
    expect(screen.getByText('첫 성공 조회부터 이미 예매 가능한 상영도 알려드려요.')).toBeTruthy();
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
    await screen.findByRole('option', { name: '서울' });
    fireEvent.change(screen.getByLabelText('작품 검색'), { target: { value: '   ' } });
    fireEvent.submit(screen.getByRole('button', { name: '감시 저장' }).closest('form')!);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(saveRule).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(screen.queryByLabelText('작품 검색')).toBeNull();
  });
  it('rule-crud-restart: form submits only saved validated fields and secret input clears', async () => {
    const { api, saveRule } = mount();
    await screen.findByRole('heading', { name: /Cinema Bar/ });
    fireEvent.click(screen.getByRole('button', { name: /첫 감시 추가/ }));
    await screen.findByRole('option', { name: '서울' });
    fireEvent.change(screen.getByLabelText('지역'), { target: { value: '01' } });
    fireEvent.change(screen.getByLabelText('극장'), { target: { value: '0013' } });
    fireEvent.change(screen.getByLabelText('작품 검색 결과'), { target: { value: 'movie-1' } });
    fireEvent.change(screen.getByLabelText('상영일'), { target: { value: '2099-01-01' } });
    expect(saveRule).not.toHaveBeenCalled();
    fireEvent.submit(screen.getByRole('button', { name: '감시 저장' }).closest('form')!);
    await waitFor(() => expect(saveRule).toHaveBeenCalledTimes(1));
    expect(saveRule.mock.calls[0][0]).toMatchObject({
      theaterId: '0013',
      theaterName: '용산아이파크몰',
      movieId: 'movie-1',
      movieTitle: '별의 영화',
    });
    fireEvent.click(screen.getByRole('tab', { name: '설정' }));
    fireEvent.change(screen.getByLabelText('개인 웹훅 주소'), {
      target: { value: 'fixture-input' },
    });
    fireEvent.submit(screen.getByRole('button', { name: '안전하게 연결' }).closest('form')!);
    await waitFor(() => expect(api.saveWebhook).toHaveBeenCalled());
    expect((screen.getByLabelText('개인 웹훅 주소') as HTMLInputElement).value).toBe('');
  });
  it('earliest toggle supports click, Enter and Space without submitting and persists through editing and remount', async () => {
    const user = userEvent.setup();
    const { saveRule } = mount({ ...empty, rules: [rule] });
    await screen.findByRole('heading', { name: /Cinema Bar/ });
    await user.click(screen.getByRole('tab', { name: '감시 목록' }));
    await user.click(screen.getByRole('button', { name: `${rule.movieTitle} 수정` }));
    let toggle = screen.getByRole('button', { name: '가장 빠른 회차만 알림' });
    expect(toggle.getAttribute('type')).toBe('button');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    toggle.focus();
    await user.keyboard(' ');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.classList.contains('primary')).toBe(true);
    await user.keyboard('{Enter}');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await user.click(toggle);
    expect(saveRule).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '감시 저장' }));
    await waitFor(() => expect(saveRule).toHaveBeenCalledTimes(1));
    expect(saveRule.mock.calls[0][0].shouldNotifyEarliestOnly).toBe(true);
    expect(screen.getByText(/· 가장 빠른 회차만 알림/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: `${rule.movieTitle} 수정` }));
    toggle = screen.getByRole('button', { name: '가장 빠른 회차만 알림' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByRole('button', { name: '취소' }));
    const saved = { ...rule, ...saveRule.mock.calls[0][0] };
    cleanup();
    const remounted = mount({ ...empty, rules: [saved] });
    await screen.findByRole('heading', { name: /Cinema Bar/ });
    await user.click(screen.getByRole('tab', { name: '감시 목록' }));
    await user.click(screen.getByRole('button', { name: `${rule.movieTitle} 수정` }));
    toggle = screen.getByRole('button', { name: '가장 빠른 회차만 알림' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: '감시 저장' }));
    await waitFor(() => expect(remounted.saveRule).toHaveBeenCalledTimes(1));
    expect(remounted.saveRule.mock.calls[0][0].shouldNotifyEarliestOnly).toBe(false);
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
    expect(status({ ...empty, rules: [rule], hasWebhook: false })).toBe('앱 알림 감시 중');
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
describe('local alert settings and factual status', () => {
  it('allows webhook-free monitoring and persists a strict local toggle through the narrow settings API', async () => {
    const snapshot = { ...empty, rules: [rule] };
    const { api } = mount(snapshot);
    await screen.findByRole('heading', { name: /Cinema Bar/ });
    expect(screen.getByText('앱 알림 감시 중')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '설정' }));
    const toggle = screen.getByRole('checkbox', { name: '앱 알림' });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({ shouldNotifyLocally: false }),
    );
    expect(screen.getByText(/OS 알림센터에는 남지 않아요/)).toBeTruthy();
    expect(
      status({ ...snapshot, settings: { ...snapshot.settings, shouldNotifyLocally: false } }),
    ).toBe('알림 꺼짐');
    expect(status({ ...snapshot, isLocalAlertSupported: false })).toBe('앱 알림 오류');
  });
  it('identifies local failures and Discord/local history as separate outcomes', async () => {
    mount({
      ...empty,
      hasWebhook: true,
      localAlertWarning: '앱 팝업을 표시하지 못했어요. Discord 전송은 계속합니다.',
      history: [
        { id: 'local', kind: 'localRequested', at: NOW, title: '영화', detail: '앱 표시 요청' },
        { id: 'discord', kind: 'sent', at: NOW, title: '영화', detail: 'Discord 완료' },
      ],
    });
    await screen.findByRole('heading', { name: /Cinema Bar/ });
    expect(screen.getByText(/Discord 전송은 계속합니다/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '알림 기록' }));
    expect(screen.getByText('앱 알림 표시 요청')).toBeTruthy();
    expect(screen.getByText('Discord 전송 완료')).toBeTruthy();
  });
  it.each([
    ['2026-10-20T14:59:59Z', '01'],
    ['2026-10-20T15:00:00Z', '01'],
    ['2026-10-20T20:59:59Z', '01'],
    ['2026-10-20T21:00:00Z', '00'],
  ])('dashboard uses the same CGV business-date eligibility at %s', async (now, count) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(now));
    try {
      mount({ ...empty, rules: [{ ...rule, provider: 'cgv', date: '2026-10-20' }] });
      await screen.findByRole('heading', { name: /Cinema Bar/ });
      expect(
        within(screen.getByRole('article', { name: '감시 상태 요약' })).getByText(count),
      ).toBeTruthy();
    } finally {
      clock.mockRestore();
    }
  });
});

describe('official catalog selection and legacy compatibility', () => {
  async function openNew() {
    const result = mount();
    await screen.findByRole('heading', { name: /Cinema Bar/ });
    fireEvent.click(screen.getByRole('button', { name: /첫 감시 추가/ }));
    await screen.findByRole('option', { name: '서울' });
    return result;
  }
  function choose() {
    fireEvent.change(screen.getByLabelText('지역'), { target: { value: '01' } });
    fireEvent.change(screen.getByLabelText('극장'), { target: { value: '0013' } });
    fireEvent.change(screen.getByLabelText('작품 검색 결과'), { target: { value: 'anime-2' } });
  }
  it('searches anime locally, requires explicit identity and invalidates it on query edits', async () => {
    const { api, saveRule } = await openNew();
    expect(screen.queryByLabelText('극장 ID')).toBeNull();
    expect(screen.queryByLabelText('극장 이름')).toBeNull();
    fireEvent.change(screen.getByLabelText('작품 검색'), { target: { value: '치이카와' } });
    expect(within(screen.getByLabelText('작품 검색 결과')).getAllByRole('option')).toHaveLength(3);
    choose();
    expect(screen.getByText(/선택: 극장판 치이카와/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '감시 저장' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.change(screen.getByLabelText('작품 검색'), {
      target: { value: '극장판 치이카와: 인어 섬의 비밀' },
    });
    expect((screen.getByLabelText('작품 검색 결과') as HTMLSelectElement).value).toBe('');
    expect((screen.getByRole('button', { name: '감시 저장' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(api.getCatalog).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('작품 검색 결과'), { target: { value: 'anime-2' } });
    fireEvent.submit(screen.getByRole('button', { name: '감시 저장' }).closest('form')!);
    await waitFor(() => expect(saveRule).toHaveBeenCalledTimes(1));
    expect(saveRule.mock.calls[0][0]).toMatchObject({
      movieId: 'anime-2',
      movieTitle: '극장판 치이카와: 인어 섬의 비밀',
      theaterId: '0013',
    });
  });
  it('resets only the theater on region changes and resets all selections on provider changes', async () => {
    const { api } = await openNew();
    choose();
    fireEvent.change(screen.getByLabelText('지역'), { target: { value: '02' } });
    expect((screen.getByLabelText('극장') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('작품 검색 결과') as HTMLSelectElement).value).toBe('anime-2');
    expect(
      within(screen.getByLabelText('극장')).queryByRole('option', { name: '용산아이파크몰' }),
    ).toBeNull();
    fireEvent.change(screen.getByLabelText('영화관'), { target: { value: 'megabox' } });
    await waitFor(() => expect(api.getCatalog).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect((screen.getByLabelText('지역') as HTMLSelectElement).disabled).toBe(false),
    );
    expect((screen.getByLabelText('지역') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('작품 검색 결과') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('작품 검색') as HTMLInputElement).value).toBe('');
    expect(api.cancelCatalog).toHaveBeenCalledWith({ requestId: expect.any(String) });
  });
  it.each([false, true])(
    'preserves an unlisted saved choice and optional movieId=%s without catalog access',
    async (hasId) => {
      const saved = { ...rule, ...(hasId ? { movieId: 'unlisted' } : {}) };
      const { api, saveRule } = mount({ ...empty, rules: [saved] });
      await screen.findByRole('heading', { name: /Cinema Bar/ });
      fireEvent.click(screen.getByRole('tab', { name: '감시 목록' }));
      fireEvent.click(screen.getByRole('button', { name: '별의 영화 수정' }));
      expect(screen.getByText('저장된 선택')).toBeTruthy();
      expect(screen.queryByLabelText('지역')).toBeNull();
      fireEvent.change(screen.getByLabelText('상영 포맷'), { target: { value: 'IMAX' } });
      fireEvent.submit(screen.getByRole('button', { name: '감시 저장' }).closest('form')!);
      await waitFor(() => expect(saveRule).toHaveBeenCalledTimes(1));
      expect(saveRule.mock.calls[0][0]).toMatchObject({
        theaterId: rule.theaterId,
        theaterName: rule.theaterName,
        movieTitle: rule.movieTitle,
        format: 'IMAX',
      });
      expect(saveRule.mock.calls[0][0].movieId).toBe(hasId ? 'unlisted' : undefined);
      expect(api.getCatalog).not.toHaveBeenCalled();
    },
  );
  it('requires a complete fresh choice after explicitly leaving the saved summary', async () => {
    const { api } = mount({ ...empty, rules: [{ ...rule, movieId: 'unlisted' }] });
    vi.mocked(api.getCatalog).mockRejectedValue(new Error('공급자 형식 변경'));
    await screen.findByRole('heading', { name: /Cinema Bar/ });
    fireEvent.click(screen.getByRole('tab', { name: '감시 목록' }));
    fireEvent.click(screen.getByRole('button', { name: '별의 영화 수정' }));
    fireEvent.click(screen.getByRole('button', { name: '극장·작품 다시 선택' }));
    expect(await screen.findByText('공급자 형식 변경')).toBeTruthy();
    expect((screen.getByRole('button', { name: '감시 저장' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
  it('distinguishes empty official lists, no search results and a retryable error while preserving other fields', async () => {
    const { api } = await openNew();
    fireEvent.change(screen.getByLabelText('작품 검색'), { target: { value: '찾을수없음' } });
    expect(screen.getByText(/검색 결과가 없어요/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('상영 포맷'), { target: { value: 'IMAX' } });
    vi.mocked(api.getCatalog).mockRejectedValueOnce(new Error('네트워크 시간 초과'));
    fireEvent.click(screen.getByRole('button', { name: '목록 새로고침' }));
    expect(await screen.findByText('네트워크 시간 초과')).toBeTruthy();
    expect((screen.getByLabelText('상영 포맷') as HTMLSelectElement).value).toBe('IMAX');
    vi.mocked(api.getCatalog).mockResolvedValueOnce({ ...catalogFixture(), movies: [] });
    fireEvent.click(screen.getByRole('button', { name: '재시도' }));
    expect(await screen.findByText('공식 예매 목록에 작품이 없어요.')).toBeTruthy();
    expect(api.getCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }));
  });
  it('blocks refresh-time saves, preserves selections and ignores an old provider response or error', async () => {
    const { api } = await openNew();
    choose();
    let resolve!: (value: ReturnType<typeof catalogFixture>) => void;
    vi.mocked(api.getCatalog).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    fireEvent.click(screen.getByRole('button', { name: '목록 새로고침' }));
    expect(screen.getByText(/불러오고 있어요/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '감시 저장' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    resolve(catalogFixture());
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '감시 저장' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    let reject!: (error: Error) => void;
    vi.mocked(api.getCatalog).mockImplementationOnce(
      () =>
        new Promise((_done, fail) => {
          reject = fail;
        }),
    );
    fireEvent.click(screen.getByRole('button', { name: '목록 새로고침' }));
    fireEvent.change(screen.getByLabelText('영화관'), { target: { value: 'lottecinema' } });
    await waitFor(() =>
      expect((screen.getByLabelText('지역') as HTMLSelectElement).disabled).toBe(false),
    );
    reject(new Error('late CGV error'));
    await waitFor(() => expect(screen.queryByText('late CGV error')).toBeNull());
    expect((screen.getByLabelText('영화관') as HTMLSelectElement).value).toBe('lottecinema');
  });
  it('keeps the current Lotte catalog, selections and save state after a late CGV success', async () => {
    const { api, saveRule } = await openNew();
    let resolve!: (value: ReturnType<typeof catalogFixture>) => void;
    const staleCgv = new Promise<ReturnType<typeof catalogFixture>>((done) => {
      resolve = done;
    });
    const lotte = {
      ...catalogFixture('lottecinema'),
      regions: [{ id: 'lotte-region', name: '롯데 지역' }],
      theaters: [{ id: '1016', name: '롯데 극장', regionId: 'lotte-region' }],
      movies: [{ id: '24708', title: '롯데 선택 작품' }],
    };
    vi.mocked(api.getCatalog).mockReturnValueOnce(staleCgv).mockResolvedValueOnce(lotte);
    fireEvent.click(screen.getByRole('button', { name: '목록 새로고침' }));
    expect(screen.getByText(/불러오고 있어요/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('영화관'), { target: { value: 'lottecinema' } });
    await screen.findByRole('option', { name: '롯데 지역' });
    fireEvent.change(screen.getByLabelText('지역'), { target: { value: 'lotte-region' } });
    fireEvent.change(screen.getByLabelText('극장'), { target: { value: '1016' } });
    fireEvent.change(screen.getByLabelText('작품 검색 결과'), { target: { value: '24708' } });
    fireEvent.change(screen.getByLabelText('상영일'), { target: { value: '2099-01-01' } });
    expect((screen.getByRole('button', { name: '감시 저장' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    await act(async () => {
      resolve(catalogFixture('cgv'));
    });
    expect((screen.getByLabelText('영화관') as HTMLSelectElement).value).toBe('lottecinema');
    expect((screen.getByLabelText('지역') as HTMLSelectElement).value).toBe('lotte-region');
    expect(
      within(screen.getByLabelText('지역')).getByRole('option', { name: '롯데 지역' }),
    ).toBeTruthy();
    expect(
      within(screen.getByLabelText('지역')).queryByRole('option', { name: '서울' }),
    ).toBeNull();
    expect((screen.getByLabelText('극장') as HTMLSelectElement).value).toBe('1016');
    expect((screen.getByLabelText('극장') as HTMLSelectElement).disabled).toBe(false);
    expect((screen.getByLabelText('작품 검색 결과') as HTMLSelectElement).value).toBe('24708');
    expect(screen.getByText(/선택: 롯데 선택 작품/)).toBeTruthy();
    expect(screen.queryByText(/불러오고 있어요/)).toBeNull();
    expect((screen.getByRole('button', { name: '감시 저장' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.submit(screen.getByRole('button', { name: '감시 저장' }).closest('form')!);
    await waitFor(() => expect(saveRule).toHaveBeenCalledTimes(1));
    expect(saveRule.mock.calls[0][0]).toMatchObject({
      provider: 'lottecinema',
      theaterId: '1016',
      theaterName: '롯데 극장',
      movieId: '24708',
      movieTitle: '롯데 선택 작품',
    });
  });
  it('supports native select keyboard focus and cancels a pending request when the form closes', async () => {
    const { api } = await openNew();
    const user = userEvent.setup();
    screen.getByLabelText('지역').focus();
    await user.selectOptions(screen.getByLabelText('지역'), '01');
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText('극장'));
    await user.selectOptions(screen.getByLabelText('극장'), '0013');
    expect((screen.getByLabelText('극장') as HTMLSelectElement).value).toBe('0013');
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(api.cancelCatalog).toHaveBeenCalledWith({ requestId: expect.any(String) });
  });
});

describe('poster cards, exact expiry and optional keep-awake controls', () => {
  const summarySnapshot = (startsAt = NOW + 15): Snapshot => ({
    ...empty,
    rules: [{ ...rule, format: 'ALL' }],
    progress: {
      [rule.id]: { revision: 1, lastSuccess: NOW, failures: 0, count: 1, nextAt: NOW + 120000 },
    },
    earliestByRule: {
      [rule.id]: {
        revision: 1,
        checkedAt: NOW,
        session: {
          identity: 'first',
          startsAt,
          date: rule.date,
          time: '10:00',
          format: 'IMAX',
          screen: 'IMAX관',
        },
      },
    },
  });
  it('shows a shared decorative poster for saved identities and preserves the format and fallback', async () => {
    const snapshot = {
      ...empty,
      rules: [
        { ...rule, movieId: 'movie-1', format: 'ALL' as const },
        { ...rule, id: 'duplicate', movieId: 'movie-1' },
      ],
    };
    const { api } = mount(snapshot);
    vi.mocked(api.getPoster).mockResolvedValue({ dataUrl: 'data:image/png;base64,AAAA' });
    await screen.findByRole('heading', { name: /Cinema Bar/ });
    fireEvent.click(screen.getByRole('tab', { name: '감시 목록' }));
    await waitFor(() => expect(document.querySelectorAll('.ticketArt img').length).toBe(2));
    expect(api.getPoster).toHaveBeenCalledTimes(1);
    expect(api.getPoster).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: rule.provider,
        movieId: 'movie-1',
        movieTitle: rule.movieTitle,
      }),
    );
    expect(screen.getByText('ALL SCREENS')).toBeTruthy();
    const image = document.querySelector<HTMLImageElement>('.ticketArt img')!;
    expect(image.alt).toBe('');
    fireEvent.error(image);
    expect(document.querySelectorAll('.ticketArt img').length).toBe(1);
    expect(screen.getAllByRole('button', { name: `${rule.movieTitle} 삭제` })).toHaveLength(2);
    fireEvent.click(screen.getByRole('tab', { name: '대시보드' }));
    expect(api.cancelPoster).not.toHaveBeenCalled();
  });
  it('cancels obsolete identity waiters and ignores late images after rule change and tab unmount', async () => {
    const snapshot = { ...empty, rules: [{ ...rule, movieId: 'old' }] };
    const { api } = mount(snapshot);
    let resolve!: (value: { dataUrl: string }) => void;
    vi.mocked(api.getPoster)
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValue({ dataUrl: 'data:image/png;base64,BBBB' });
    await screen.findByRole('heading', { name: /Cinema Bar/ });
    fireEvent.click(screen.getByRole('tab', { name: '감시 목록' }));
    await waitFor(() => expect(api.getPoster).toHaveBeenCalledTimes(1));
    const listener = vi.mocked(api.onSnapshot).mock.calls[0][0];
    await act(async () =>
      listener({ ...snapshot, rules: [{ ...rule, revision: 2, movieId: 'new' }] }),
    );
    await waitFor(() => expect(api.cancelPoster).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(document.querySelector<HTMLImageElement>('.ticketArt img')?.src).toContain('BBBB'),
    );
    await act(async () => resolve({ dataUrl: 'data:image/png;base64,AAAA' }));
    expect(document.querySelector<HTMLImageElement>('.ticketArt img')?.src).toContain('BBBB');
    fireEvent.click(screen.getByRole('tab', { name: '설정' }));
    expect(document.querySelector('.ticketArt')).toBeNull();
  });
  it('shows pending, empty, provider failure and inactive states independently', async () => {
    const snapshot = { ...empty, rules: [rule] };
    const { api } = mount(snapshot);
    await screen.findByRole('heading', { name: /Cinema Bar/ });
    fireEvent.click(screen.getByRole('tab', { name: '감시 목록' }));
    expect(screen.getByText('첫 조회 후 가장 빠른 회차를 알려드려요')).toBeTruthy();
    const listener = vi.mocked(api.onSnapshot).mock.calls[0][0];
    const success = {
      ...summarySnapshot(),
      earliestByRule: { [rule.id]: { revision: 1, checkedAt: NOW } },
    };
    await act(async () => listener(success));
    expect(screen.getByText('아직 예매 가능한 회차가 없어요')).toBeTruthy();
    await act(async () =>
      listener({
        ...success,
        progress: { [rule.id]: { ...success.progress[rule.id], error: 'HTTP 403' } },
      }),
    );
    expect(screen.getByText('가장 빠른 회차를 확인하지 못했어요')).toBeTruthy();
    await act(async () => listener({ ...success, isOnline: false }));
    expect(screen.getByText('감시가 실행되면 가장 빠른 회차를 확인해요')).toBeTruthy();
  });
  it('expires at the exact start, reads known next candidates without provider refresh, then shows no future candidate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const snapshot = summarySnapshot();
    const { api } = mount(snapshot);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('tab', { name: '감시 목록' }));
    const next = summarySnapshot(NOW + 30);
    next.earliestByRule![rule.id].session = {
      ...next.earliestByRule![rule.id].session!,
      identity: 'next',
      time: '12:00',
      format: 'DOLBY',
    };
    vi.mocked(api.getSnapshot)
      .mockResolvedValueOnce(next)
      .mockResolvedValueOnce({
        ...next,
        earliestByRule: { [rule.id]: { revision: 1, checkedAt: NOW } },
      });
    expect(screen.getByText('10:00 · IMAX')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14);
    });
    expect(screen.getByText('10:00 · IMAX')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.queryByText('10:00 · IMAX')).toBeNull();
    expect(screen.getByText('12:00 · DOLBY')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15);
    });
    expect(screen.queryByText('12:00 · DOLBY')).toBeNull();
    expect(screen.getByText('현재 확인된 미래 회차 없음 · 다음 조회에서 확인해요')).toBeTruthy();
    expect(api.getSnapshot).toHaveBeenCalledTimes(3);
    expect(api.refresh).not.toHaveBeenCalled();
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
  it('filters an already expired initial value and ignores old timer/request replies across revisions', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const snapshot = summarySnapshot(NOW - 1);
    const { api } = mount(snapshot);
    let resolve!: (value: Snapshot) => void;
    vi.mocked(api.getSnapshot).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('tab', { name: '감시 목록' }));
    await act(async () => undefined);
    expect(screen.queryByText('10:00 · IMAX')).toBeNull();
    const updated = summarySnapshot(NOW + 1000);
    updated.rules = [{ ...updated.rules[0], revision: 2 }];
    updated.earliestByRule![rule.id] = {
      ...updated.earliestByRule![rule.id],
      revision: 2,
      session: { ...updated.earliestByRule![rule.id].session!, time: '13:00', format: 'UNKNOWN' },
    };
    const listener = vi.mocked(api.onSnapshot).mock.calls[0][0];
    await act(async () => listener(updated));
    expect(screen.getByText('13:00 · 포맷 미확인')).toBeTruthy();
    if (resolve) await act(async () => resolve(snapshot));
    expect(screen.getByText('13:00 · 포맷 미확인')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '설정' }));
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
  it('reevaluates actual time on focus and visible restoration without reviving a stale start', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const snapshot = summarySnapshot(NOW + 1000);
    const { api } = mount(snapshot);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('tab', { name: '감시 목록' }));
    vi.mocked(api.getSnapshot).mockResolvedValue({
      ...snapshot,
      earliestByRule: { [rule.id]: { revision: 1, checkedAt: NOW } },
    });
    vi.setSystemTime(NOW + 2000);
    fireEvent(window, new Event('focus'));
    expect(screen.queryByText('10:00 · IMAX')).toBeNull();
    await act(async () => undefined);
    const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    fireEvent(document, new Event('visibilitychange'));
    expect(screen.queryByText('10:00 · IMAX')).toBeNull();
    visible.mockRestore();
    fireEvent.click(screen.getByRole('tab', { name: '대시보드' }));
    fireEvent.click(screen.getByRole('tab', { name: '감시 목록' }));
    expect(screen.queryByText('10:00 · IMAX')).toBeNull();
    cleanup();
    vi.useRealTimers();
  });
  it('saves only the keep-awake strict boolean and reports the native state and limits', async () => {
    const { api } = mount({ ...empty, isKeepingAwake: true });
    await screen.findByRole('heading', { name: /Cinema Bar/ });
    fireEvent.click(screen.getByRole('tab', { name: '설정' }));
    const toggle = screen.getByRole('checkbox', { name: '감시 중 자동 잠자기 방지' });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ shouldKeepAwake: true }));
    expect(screen.getByText('자동 잠자기 방지 작동 중')).toBeTruthy();
    expect(screen.getByText(/수동 잠자기·덮개 닫힘·전원 꺼짐/)).toBeTruthy();
    expect(screen.getByText(/배터리 사용량/)).toBeTruthy();
    await act(async () =>
      vi.mocked(api.onSnapshot).mock.calls[0][0]({
        ...empty,
        settings: { ...empty.settings, shouldKeepAwake: true },
        keepAwakeWarning: 'native failure',
      }),
    );
    expect(screen.getByText('native failure')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: '감시 중 자동 잠자기 방지' }));
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({ shouldKeepAwake: false }),
    );
  });
});

describe('update card revisioned isolated state', () => {
  function setup(state: UpdateState) {
    let listener!: (next: UpdateState) => void;
    let resolveInitial!: (next: UpdateState) => void;
    const unsubscribe = vi.fn();
    const api = {
      onUpdateState: vi.fn((receive) => {
        listener = receive;
        return unsubscribe;
      }),
      getUpdateState: vi.fn(
        () =>
          new Promise<UpdateState>((resolve) => {
            resolveInitial = resolve;
          }),
      ),
      checkForUpdates: vi.fn(async () => ({
        ...state,
        revision: state.revision + 1,
        phase: 'current' as const,
      })),
      downloadUpdate: vi.fn(async () => ({
        ...state,
        revision: state.revision + 1,
        phase: 'downloading' as const,
        downloadedBytes: 512,
        totalBytes: 1024,
      })),
      cancelUpdate: vi.fn(async () => ({
        ...state,
        revision: state.revision + 2,
        phase: 'available' as const,
      })),
      openUpdateInstaller: vi.fn(async () => ({
        ...state,
        revision: state.revision + 1,
        phase: 'opened' as const,
      })),
    };
    window.cinema = api as unknown as CinemaApi;
    const view = render(<UpdateCard />);
    return {
      ...view,
      api,
      unsubscribe,
      event: (next: UpdateState) => act(() => listener(next)),
      initial: (next = state) => act(async () => resolveInitial(next)),
    };
  }
  const idle: UpdateState = {
    revision: 3,
    phase: 'idle',
    currentVersion: '0.2.0',
    platformLabel: 'macOS · Apple Silicon · DMG',
  };
  it('subscribes before initial fetch, rejects stale initial/event responses and unsubscribes', async () => {
    const f = setup(idle);
    f.event({ ...idle, revision: 5, phase: 'available', availableVersion: '0.3.0' });
    await f.initial();
    expect(screen.getByText('0.3.0 업데이트가 있어요')).toBeTruthy();
    f.event({ ...idle, revision: 4 });
    expect(screen.getByText('0.3.0 업데이트가 있어요')).toBeTruthy();
    f.unmount();
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });
  it('uses payload-free keyboard actions and communicates progress and cancellation', async () => {
    const state = {
      ...idle,
      phase: 'available' as const,
      availableVersion: '0.3.0',
      totalBytes: 1024,
    };
    const f = setup(state);
    await f.initial();
    const download = screen.getByRole('button', { name: '업데이트 다운로드' });
    download.focus();
    await userEvent.setup().keyboard('{Enter}');
    expect(f.api.downloadUpdate).toHaveBeenCalledWith();
    expect(
      screen.getByRole('progressbar', { name: '업데이트 다운로드 진행률' }).getAttribute('value'),
    ).toBe('50');
    await userEvent.setup().click(screen.getByRole('button', { name: '다운로드 취소' }));
    expect(f.api.cancelUpdate).toHaveBeenCalledWith();
    expect(screen.getByRole('button', { name: '업데이트 다운로드' })).toBeTruthy();
  });
  it('retains open-error retry and user quit/install instructions for each platform', async () => {
    const f = setup({ ...idle, phase: 'ready', message: '다시 열기를 눌러 주세요.' });
    await f.initial();
    expect(screen.getByRole('alert').textContent).toContain('다시 열기');
    expect(screen.getByText(/Cinema Bar를 종료한 뒤 설치를 완료/)).toBeTruthy();
    expect(screen.getByText(/DMG에서 Cinema Bar.app/)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: '설치 파일 열기' }));
    expect(f.api.openUpdateInstaller).toHaveBeenCalledWith();
    expect(screen.getByRole('button', { name: '설치 파일 다시 열기' })).toBeTruthy();
    f.event({ ...idle, revision: 10, phase: 'ready', platformLabel: 'Windows · x64 · Setup' });
    expect(screen.getByText(/기존 Cinema Bar와 같은 위치/)).toBeTruthy();
  });
  it('shows disabled builds without controls and announces safe request failures', async () => {
    const f = setup({ ...idle, phase: 'disabled', message: '개발 실행 안내' });
    await f.initial();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('개발 실행 안내')).toBeTruthy();
    f.event({ ...idle, revision: 5 });
    f.api.checkForUpdates.mockRejectedValueOnce(new Error('private detail'));
    await userEvent.setup().click(screen.getByRole('button', { name: '업데이트 확인' }));
    expect(screen.getByRole('alert').textContent).toContain('다시 시도');
    expect(screen.queryByText('private detail')).toBeNull();
  });
});
