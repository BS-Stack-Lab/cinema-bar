import { status } from './status';
import { UpdateCard } from './UpdateCard';
import { useCallback, useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import {
  FORMATS,
  type Catalog,
  type Provider,
  type RuleInput,
  type Rule,
  type RuleEarliest,
  type Snapshot,
} from '../electron/types';
import { isRuleEligible } from '../electron/eligibility';
import { sessionFormatLabel, sessionTimeLabel } from '../electron/sessionTiming';
import { koreanToday, normalizeTitle, validateRule } from '../electron/validation';
const LABELS: Record<Provider, string> = {
  cgv: 'CGV',
  megabox: 'MEGABOX',
  lottecinema: '롯데시네마',
};
const TABS = ['대시보드', '감시 목록', '알림 기록', '설정'] as const;
function stamp(value?: number) {
  return value
    ? new Intl.DateTimeFormat('ko-KR', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: 'Asia/Seoul',
      }).format(value)
    : '아직 없음';
}
export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [tab, setTab] = useState<(typeof TABS)[number]>('대시보드');
  const [editing, setEditing] = useState<RuleInput | null>();
  const [error, setError] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [webhook, setWebhook] = useState('');
  const [interval, setInterval] = useState('120');
  useEffect(() => {
    let isActive = true;
    void window.cinema
      .getSnapshot()
      .then((value) => {
        if (isActive) {
          setSnapshot(value);
          setInterval(String(value.settings.intervalSeconds));
        }
      })
      .catch(() => setError('앱 상태를 읽지 못했습니다. 앱을 다시 여세요.'));
    const off = window.cinema.onSnapshot((value) => {
      if (isActive) setSnapshot(value);
    });
    return () => {
      isActive = false;
      off();
    };
  }, []);
  async function action(work: () => Promise<Snapshot | void>) {
    setError('');
    setIsBusy(true);
    try {
      const value = await work();
      if (value) setSnapshot(value);
      return true;
    } catch (e) {
      const message =
        e instanceof Error
          ? e.message.replace(/^Error invoking remote method '[^']+': Error: /u, '')
          : '작업에 실패했습니다. 다시 시도하세요.';
      setError(message);
      return false;
    } finally {
      setIsBusy(false);
    }
  }
  if (!snapshot)
    return (
      <main>
        <p role="status">영사기를 켜고 있어요…</p>
        {error && <p role="alert">{error}</p>}
      </main>
    );
  const activeRules =
    snapshot.settings.isPaused ||
    !snapshot.isOnline ||
    snapshot.isSuspended ||
    snapshot.recoveryError
      ? 0
      : snapshot.rules.filter((r) => isRuleEligible(r)).length;
  const latestSuccess = Math.max(
    0,
    ...Object.values(snapshot.progress).map((p) => p.lastSuccess ?? 0),
  );
  const stateLabel = status(snapshot);
  const isAlert = /오류|필요/u.test(stateLabel);
  return (
    <main>
      <header className="brand">
        <div className="brandMark">
          <img src="./projector.svg" alt="픽셀 영사기 마스코트" />
          <div>
            <span className="eyebrow">YOUR PERSONAL SCREENING RADAR</span>
            <h1>
              Cinema Bar<span className="version">01</span>
            </h1>
          </div>
        </div>
        <span className={`badge ${isAlert ? 'amber' : 'green'}`}>
          <span aria-hidden="true">●</span> {stateLabel}
        </span>
      </header>
      <nav className="tabs" role="tablist" aria-label="앱 화면">
        {TABS.map((name, index) => (
          <button
            key={name}
            id={`tab-${index}`}
            role="tab"
            aria-controls={`panel-${index}`}
            aria-selected={name === tab}
            tabIndex={name === tab ? 0 : -1}
            onKeyDown={(event) => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const target =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? 3
                      : (index + (event.key === 'ArrowRight' ? 1 : 3)) % 4;
                setTab(TABS[target]);
                document.getElementById(`tab-${target}`)?.focus();
              }
            }}
            onClick={() => {
              setTab(name);
              setEditing(undefined);
            }}
          >
            {name}
          </button>
        ))}
      </nav>
      {error && (
        <div className="notice danger" role="alert">
          {error}
        </div>
      )}
      {snapshot.loginWarning && (
        <div className="notice" role="status">
          {snapshot.loginWarning}
        </div>
      )}
      {snapshot.trayWarning && (
        <div className="notice" role="status">
          {snapshot.trayWarning}
        </div>
      )}
      {snapshot.localAlertWarning && (
        <div className="notice" role="status">
          {snapshot.localAlertWarning}
        </div>
      )}
      {snapshot.recoveryError && (
        <div className="notice danger">
          <strong>저장 파일 확인이 필요해요</strong>
          <p>{snapshot.recoveryError}</p>
          <button
            onClick={() => {
              if (window.confirm('원본을 보존하고 감시와 연결 설정을 초기화할까요?'))
                void action(() => window.cinema.recoverStorage());
            }}
          >
            원본 보존 후 초기화
          </button>
        </div>
      )}
      <section
        id={`panel-${TABS.indexOf(tab)}`}
        role="tabpanel"
        aria-labelledby={`tab-${TABS.indexOf(tab)}`}
      >
        {tab === '대시보드' && (
          <>
            <section className="hero">
              <div className="mascotStage">
                <span className="spark one">✦</span>
                <img src="./projector.svg" alt="" />
                <span className="spark two">✦</span>
                <span className="stageDot" />
              </div>
              <div>
                <span className="eyebrow accent">READY WHEN YOU ARE</span>
                <h2>
                  {activeRules ? '다음 장면을 기다려요' : '좋아하는 영화의\n다음 상영을 만나세요'}
                </h2>
                <p>
                  저장한 극장과 작품만 확인하고
                  <br />
                  예매 가능한 상영을 찾으면 앱 알림으로 먼저 알려드려요.
                </p>
                <span className="badge violet">로컬 감시</span>{' '}
                <span className="badge muted">나만의 조건</span>
              </div>
            </section>
            <div className="sectionTitle">
              <h2>나의 상영 레이더</h2>
              <span>ASIA / SEOUL</span>
            </div>
            <div className="stats">
              <article className="card stat" aria-label="감시 상태 요약">
                <span>작동 중인 감시</span>
                <strong>
                  {String(activeRules).padStart(2, '0')}
                  <small> / {snapshot.rules.length}</small>
                </strong>
                <div className="miniBars" aria-hidden="true">
                  {Array.from({ length: 10 }, (_, i) => i).map((i) => (
                    <i key={i} />
                  ))}
                </div>
              </article>
              <article className="card stat">
                <span>전송 대기</span>
                <strong>
                  {String(snapshot.pendingCount + snapshot.localPendingCount).padStart(2, '0')}
                  <small> 건</small>
                </strong>
                <p>
                  {snapshot.hasWebhook
                    ? snapshot.isWebhookBlocked
                      ? '웹훅 재연결 필요'
                      : 'Discord 연결됨'
                    : 'Discord는 선택 연결'}
                </p>
              </article>
            </div>
            <article className="card timeline">
              <div>
                <span className="dot" />
                최근 성공 조회<strong>{stamp(latestSuccess)}</strong>
              </div>
              <div>
                <span className="dot purple" />
                다음 조회
                <strong>{snapshot.nextAt ? stamp(snapshot.nextAt) : '감시를 추가해 주세요'}</strong>
              </div>
            </article>
            {!snapshot.rules.length ? (
              <button
                className="primary wide"
                onClick={() => {
                  setTab('감시 목록');
                  setEditing(null);
                }}
              >
                ＋ 첫 감시 추가
              </button>
            ) : (
              <button className="primary wide" onClick={() => setTab('감시 목록')}>
                감시 목록 보기 <span>↗</span>
              </button>
            )}
            <p className="hint">첫 성공 조회부터 이미 예매 가능한 상영도 알려드려요.</p>
          </>
        )}
        {tab === '감시 목록' && (
          <>
            <div className="sectionTitle">
              <h2>
                감시 컬렉션 <small>{snapshot.rules.length}</small>
              </h2>
              <button className="small" onClick={() => setEditing(null)}>
                ＋ 추가
              </button>
            </div>
            {editing !== undefined ? (
              <RuleForm
                key={editing?.id ?? 'new'}
                value={editing}
                isBusy={isBusy}
                onCancel={() => setEditing(undefined)}
                onSave={async (input) => {
                  if (await action(() => window.cinema.saveRule(input))) setEditing(undefined);
                }}
              />
            ) : !snapshot.rules.length ? (
              <div className="empty card">
                <img src="./projector.svg" alt="" />
                <h3>아직 감시가 없어요</h3>
                <p>
                  극장·작품·날짜를 저장하면
                  <br />
                  나만의 상영 컬렉션이 시작돼요.
                </p>
                <button onClick={() => setEditing(null)}>첫 감시 추가</button>
              </div>
            ) : (
              <div className="ruleGrid">
                {snapshot.rules.map((rule) => (
                  <article className="card rule" key={rule.id}>
                    <div className="ruleTop">
                      <span className={`provider ${rule.provider}`}>{LABELS[rule.provider]}</span>
                      <button
                        className="iconButton"
                        aria-label={`${rule.movieTitle} 수정`}
                        onClick={() => setEditing(rule)}
                      >
                        ↗
                      </button>
                    </div>
                    <PosterBanner rule={rule} />
                    <h3>{rule.movieTitle}</h3>
                    <p>{rule.theaterName}</p>
                    <div className="ruleMeta">
                      {rule.date}
                      <br />
                      {rule.format === 'ALL' ? '모든 포맷' : rule.format} · ID {rule.theaterId}
                      {rule.shouldNotifyEarliestOnly && <span> · 가장 빠른 회차만 알림</span>}
                    </div>
                    <EarliestSummary rule={rule} snapshot={snapshot} />
                    <span
                      className={`badge ${snapshot.progress[rule.id]?.error ? 'amber' : rule.isEnabled ? 'green' : 'muted'}`}
                    >
                      {status(snapshot, rule)}
                    </span>
                    {snapshot.progress[rule.id]?.error && (
                      <p className="errorText">{snapshot.progress[rule.id].error}</p>
                    )}
                    <p className="lastQuery">
                      성공 {stamp(snapshot.progress[rule.id]?.lastSuccess)}
                    </p>
                    <div className="ruleActions">
                      <label className="toggleLabel">
                        <input
                          type="checkbox"
                          checked={rule.isEnabled}
                          aria-label={`${rule.movieTitle} 감시 활성화`}
                          onChange={(event) => {
                            const { revision: _revision, ...input } = rule;
                            void _revision;
                            void action(() =>
                              window.cinema.saveRule({ ...input, isEnabled: event.target.checked }),
                            );
                          }}
                        />
                        {rule.isEnabled ? '켜짐' : '꺼짐'}
                      </label>
                      <button
                        className="textButton"
                        aria-label={`${rule.movieTitle} 삭제`}
                        onClick={() => {
                          if (window.confirm('이 감시를 삭제할까요?'))
                            void action(() => window.cinema.deleteRule(rule.id));
                        }}
                      >
                        삭제
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
            <p className="hint">
              공급자가 조회를 제한하면 오류로 표시해요. 실제 예매는 영화관에서 확인하세요.
            </p>
          </>
        )}
        {tab === '알림 기록' && (
          <>
            <div className="sectionTitle">
              <h2>알림 기록</h2>
              <span>최근 100개</span>
            </div>
            {!snapshot.history.length ? (
              <div className="empty card">
                <span className="emptyIcon">☷</span>
                <h3>아직 보낸 알림이 없어요</h3>
                <p>
                  새 상영 알림과 전송 상태가
                  <br />
                  이곳에 차곡차곡 쌓여요.
                </p>
              </div>
            ) : (
              <div className="history">
                {snapshot.history.map((item) => (
                  <article className="card" key={item.id}>
                    <div className="sectionTitle">
                      <span className={`badge ${item.kind === 'sent' ? 'green' : 'amber'}`}>
                        {
                          {
                            sent: 'Discord 전송 완료',
                            localRequested: '앱 알림 표시 요청',
                            localFailed: '앱 알림 오류',
                            cancelled: '이전 대기 종료',
                            failed: '전송 오류',
                            expired: '보존 만료',
                            overflow: '한도 초과',
                          }[item.kind]
                        }
                      </span>
                      <time>{stamp(item.at)}</time>
                    </div>
                    <h3>{item.title}</h3>
                    <p>{item.detail}</p>
                  </article>
                ))}
              </div>
            )}
            <p className="hint">
              앱 알림은 상영마다 한 번 시도해요. Discord 응답이 불명확하면 전송이 반복될 수 있어요.
            </p>
          </>
        )}
        {tab === '설정' && (
          <>
            <div className="sectionTitle">
              <h2>내 연결과 실행</h2>
              <span>이 기기에만 저장</span>
            </div>
            <UpdateCard />
            <div className="card settingsCard">
              <label className="settingRow">
                <span>
                  <strong>앱 알림</strong>
                  <small>웹훅 없이도 새 상영을 팝업으로 먼저 알려요</small>
                </span>
                <input
                  type="checkbox"
                  aria-label="앱 알림"
                  checked={snapshot.settings.shouldNotifyLocally}
                  onChange={(event) =>
                    void action(() =>
                      window.cinema.updateSettings({ shouldNotifyLocally: event.target.checked }),
                    )
                  }
                />
              </label>
              <p className="hint">
                앱 실행 중 화면에 표시하는 팝업이에요. OS 알림센터에는 남지 않아요.
              </p>
              {!snapshot.isLocalAlertSupported && (
                <p className="errorText" role="status">
                  앱 팝업을 사용할 수 없어요. Discord를 연결해 주세요.
                </p>
              )}
            </div>
            <div className="card settingsCard">
              <label className="settingRow">
                <span>
                  <strong>감시 중 자동 잠자기 방지</strong>
                  <small>화면이 꺼져도 감시를 이어가요</small>
                </span>
                <input
                  type="checkbox"
                  aria-label="감시 중 자동 잠자기 방지"
                  checked={snapshot.settings.shouldKeepAwake === true}
                  onChange={(event) =>
                    void action(() =>
                      window.cinema.updateSettings({ shouldKeepAwake: event.target.checked }),
                    )
                  }
                />
              </label>
              <p className="hint">
                화면이 꺼져도 감시를 이어가도록 자동 잠자기를 막아요. 수동 잠자기·덮개 닫힘·전원
                꺼짐 중에는 감시할 수 없어요. 배터리 사용량이 늘어날 수 있어요.
              </p>
              <p className={snapshot.keepAwakeWarning ? 'errorText' : 'hint'} role="status">
                {snapshot.keepAwakeWarning ??
                  (snapshot.isKeepingAwake
                    ? '자동 잠자기 방지 작동 중'
                    : snapshot.settings.shouldKeepAwake
                      ? '실행 가능한 감시가 시작되면 자동 잠자기를 방지해요.'
                      : '자동 잠자기 방지 꺼짐')}
              </p>
            </div>
            <form
              className="card settingsCard"
              onSubmit={(event) => {
                event.preventDefault();
                const value = webhook;
                setWebhook('');
                void action(() => window.cinema.saveWebhook(value));
              }}
            >
              <div className="sectionTitle">
                <h3>
                  Discord 연결 <small>선택</small>
                </h3>
                <span
                  className={`badge ${snapshot.hasWebhook && !snapshot.isWebhookBlocked ? 'green' : 'amber'}`}
                >
                  {snapshot.isWebhookBlocked
                    ? '교체 필요'
                    : snapshot.hasWebhook
                      ? '연결됨'
                      : '선택 연결'}
                </span>
              </div>
              <p>
                내 서버의 채널 설정 → 연동 → 웹후크에서
                <br />
                직접 만든 주소를 붙여 넣으세요.
              </p>
              <label>
                개인 웹훅 주소
                <input
                  type="password"
                  aria-label="개인 웹훅 주소"
                  autoComplete="off"
                  value={webhook}
                  placeholder="Discord 웹훅 주소 입력"
                  onChange={(event) => setWebhook(event.target.value)}
                  maxLength={300}
                />
              </label>
              <div className="buttonRow">
                <button
                  className="primary"
                  disabled={isBusy || !webhook || !snapshot.isEncryptionAvailable}
                  type="submit"
                >
                  {snapshot.hasWebhook ? '연결 교체' : '안전하게 연결'}
                </button>
                {snapshot.hasWebhook && (
                  <button
                    type="button"
                    onClick={() => void action(() => window.cinema.deleteWebhook())}
                  >
                    연결 삭제
                  </button>
                )}
              </div>
              <p className="hint">
                OS 암호화 저장소로 보호돼요. 저장 후 원문은 다시 표시하지 않아요.
              </p>
              {!snapshot.isEncryptionAvailable && (
                <p role="alert" className="errorText">
                  OS 암호화를 사용할 수 없어요. 로그인 키체인을 확인하세요.
                </p>
              )}
            </form>
            <div className="card settingsCard">
              <label className="settingRow">
                <span>
                  <strong>로그인 시 자동 시작</strong>
                  <small>OS 사용자 로그인 후 감시를 이어가요</small>
                </span>
                <input
                  type="checkbox"
                  checked={snapshot.settings.shouldStartAtLogin}
                  onChange={(event) =>
                    void action(() =>
                      window.cinema.updateSettings({ shouldStartAtLogin: event.target.checked }),
                    )
                  }
                />
              </label>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void action(() =>
                    window.cinema.updateSettings({ intervalSeconds: Number(interval) }),
                  );
                }}
              >
                <label>
                  조회 간격 (60~3600초)
                  <div className="buttonRow">
                    <input
                      type="number"
                      min="60"
                      max="3600"
                      step="1"
                      required
                      aria-label="조회 간격"
                      value={interval}
                      onChange={(event) => setInterval(event.target.value)}
                    />
                    <button type="submit">저장</button>
                  </div>
                </label>
              </form>
            </div>
            <div className="card localInfo">
              <span className="eyebrow">PRIVATE BY DESIGN</span>
              <p>
                개인 규칙과 암호화 연결 정보는
                <br />
                사용자별 앱 폴더에 저장돼요.
              </p>
              <code>{snapshot.storagePath}</code>
              <p className="hint">
                공개 시간표를 확인해요. 공급자 연결이 제한되면 오류를 표시하고 잠시 후 다시
                시도해요.
              </p>
            </div>
          </>
        )}
      </section>
      <footer>
        <button
          className="textButton"
          disabled={isBusy || snapshot.isChecking}
          onClick={() => void action(() => window.cinema.refresh())}
        >
          ↻ 새로고침
        </button>
        <span>
          {snapshot.isChecking ? '확인 중…' : `${snapshot.settings.intervalSeconds}초 간격`}
        </span>
        <button
          className="iconButton"
          aria-label={snapshot.settings.isPaused ? '감시 재개' : '전체 감시 일시 정지'}
          onClick={() => void action(() => window.cinema.setPaused(!snapshot.settings.isPaused))}
        >
          {snapshot.settings.isPaused ? '▶' : 'Ⅱ'}
        </button>
        <button
          className="iconButton"
          aria-label="앱 종료"
          onClick={() => void window.cinema.quit()}
        >
          ⏻
        </button>
      </footer>
    </main>
  );
}
interface RuleFormProps {
  value: RuleInput | null;
  isBusy: boolean;
  onCancel(): void;
  onSave(value: RuleInput): Promise<void>;
}
const posterRequests = new Map<
  string,
  {
    requestId: string;
    listeners: Set<(url?: string) => void>;
    dataUrl?: string;
    isPending: boolean;
  }
>();
function PosterBanner({ rule }: { rule: Rule }) {
  const identity = JSON.stringify([rule.provider, rule.movieId ?? normalizeTitle(rule.movieTitle)]);
  const [image, setImage] = useState<{ identity: string; dataUrl?: string }>();
  const [failedIdentity, setFailedIdentity] = useState<string>();
  useEffect(() => {
    let current = posterRequests.get(identity);
    if (!current) {
      current = {
        requestId: `poster-${crypto.randomUUID()}`,
        listeners: new Set(),
        isPending: true,
      };
      posterRequests.set(identity, current);
      const entry = current;
      void window.cinema
        .getPoster({
          provider: rule.provider,
          movieId: rule.movieId,
          movieTitle: rule.movieTitle,
          requestId: entry.requestId,
        })
        .then((result) => {
          if (posterRequests.get(identity) !== entry) return;
          entry.dataUrl = result.dataUrl;
          entry.isPending = false;
          entry.listeners.forEach((listener) => listener(result.dataUrl));
        })
        .catch(() => {
          if (posterRequests.get(identity) !== entry) return;
          entry.isPending = false;
          entry.listeners.forEach((listener) => listener());
        });
    }
    const entry = current;
    const listener = (dataUrl?: string) => setImage({ identity, dataUrl });
    entry.listeners.add(listener);
    if (!entry.isPending) listener(entry.dataUrl);
    return () => {
      entry.listeners.delete(listener);
      if (!entry.listeners.size) {
        if (posterRequests.get(identity) === entry) posterRequests.delete(identity);
        if (entry.isPending)
          void window.cinema.cancelPoster({ requestId: entry.requestId }).catch(() => undefined);
      }
    };
  }, [identity, rule.provider, rule.movieId, rule.movieTitle]);
  const dataUrl =
    image?.identity === identity && failedIdentity !== identity ? image.dataUrl : undefined;
  return (
    <div className={`ticketArt ${dataUrl ? 'hasPoster' : ''}`} aria-hidden="true">
      {dataUrl ? <img src={dataUrl} alt="" onError={() => setFailedIdentity(identity)} /> : '▥'}
      <span>{rule.format === 'ALL' ? 'ALL SCREENS' : rule.format}</span>
    </div>
  );
}
function EarliestSummary({ rule, snapshot }: { rule: Rule; snapshot: Snapshot }) {
  const [refreshed, setRefreshed] = useState<{
    snapshot: Snapshot;
    value?: RuleEarliest;
    isAfterExpiry: boolean;
  }>();
  const summary =
    refreshed?.snapshot === snapshot ? refreshed.value : snapshot.earliestByRule?.[rule.id];
  const session = summary?.revision === rule.revision ? summary.session : undefined;
  const startsAt = session?.startsAt;
  const readClock = useCallback(() => {
    const now = Date.now();
    return (
      (isRuleEligible(rule, now) ? 1 : 0) | (startsAt !== undefined && startsAt <= now ? 2 : 0)
    );
  }, [rule, startsAt]);
  const subscribeClock = useCallback(
    (notify: () => void) => {
      let isActive = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const schedule = () => {
        clearTimeout(timer);
        if (isActive && startsAt !== undefined && startsAt > Date.now())
          timer = setTimeout(evaluate, Math.min(2147483647, startsAt - Date.now()));
      };
      const evaluate = () => {
        if (!isActive) return;
        notify();
        schedule();
      };
      const onFocus = () => flushSync(evaluate);
      const onVisible = () => {
        if (document.visibilityState === 'visible') flushSync(evaluate);
      };
      schedule();
      window.addEventListener('focus', onFocus);
      document.addEventListener('visibilitychange', onVisible);
      return () => {
        isActive = false;
        clearTimeout(timer);
        window.removeEventListener('focus', onFocus);
        document.removeEventListener('visibilitychange', onVisible);
      };
    },
    [startsAt],
  );
  const clock = useSyncExternalStore(subscribeClock, readClock);
  const isExpired = (clock & 2) !== 0;
  useEffect(() => {
    if (!isExpired || startsAt === undefined) return;
    let isActive = true;
    void window.cinema
      .getSnapshot()
      .then((value) => {
        if (
          !isActive ||
          !value.rules.some(
            (item) => item.id === rule.id && item.revision === rule.revision && item.isEnabled,
          )
        )
          return;
        setRefreshed({ snapshot, value: value.earliestByRule?.[rule.id], isAfterExpiry: true });
      })
      .catch(() => undefined);
    return () => {
      isActive = false;
    };
  }, [isExpired, rule.id, rule.revision, snapshot, startsAt]);
  const progress = snapshot.progress[rule.id];
  const isCurrent =
    (clock & 1) !== 0 &&
    !snapshot.settings.isPaused &&
    snapshot.isOnline &&
    !snapshot.isSuspended &&
    !snapshot.recoveryError;
  let message = '첫 조회 후 가장 빠른 회차를 알려드려요';
  if (!isCurrent) message = '감시가 실행되면 가장 빠른 회차를 확인해요';
  else if (progress?.error) message = '가장 빠른 회차를 확인하지 못했어요';
  else if (session && !isExpired)
    return (
      <p className="earliestSession">
        <small>가장 빠른 예매 가능 회차</small>
        <strong>
          {sessionTimeLabel(session)} · {sessionFormatLabel(session.format)}
        </strong>
        <span>{session.screen}</span>
      </p>
    );
  else if (isExpired || (refreshed?.snapshot === snapshot && refreshed.isAfterExpiry))
    message = '현재 확인된 미래 회차 없음 · 다음 조회에서 확인해요';
  else if (summary?.revision === rule.revision) message = '아직 예매 가능한 회차가 없어요';
  return <p className="earliestSession hint">{message}</p>;
}

function RuleForm({ value, isBusy, onCancel, onSave }: RuleFormProps) {
  const [form, setForm] = useState<RuleInput>(
    value
      ? {
          id: value.id,
          provider: value.provider,
          theaterId: value.theaterId,
          theaterName: value.theaterName,
          movieTitle: value.movieTitle,
          ...(value.movieId === undefined ? {} : { movieId: value.movieId }),
          date: value.date,
          format: value.format,
          ...(value.shouldNotifyEarliestOnly === undefined
            ? {}
            : { shouldNotifyEarliestOnly: value.shouldNotifyEarliestOnly }),
          isEnabled: value.isEnabled,
        }
      : {
          provider: 'cgv',
          theaterId: '',
          theaterName: '',
          movieTitle: '',
          date: koreanToday(),
          format: 'ALL',
          isEnabled: true,
        },
  );
  const [isSelecting, setIsSelecting] = useState(!value);
  const [regionId, setRegionId] = useState('');
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<Catalog>();
  const [isLoading, setIsLoading] = useState(!value);
  const [catalogError, setCatalogError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!isSelecting) return;
    let isActive = true;
    const provider = form.provider;
    const requestId = `catalog-${crypto.randomUUID()}`;
    void window.cinema
      .getCatalog({ provider, requestId, ...(refresh ? { force: true } : {}) })
      .then((result) => {
        if (isActive && result.provider === provider) setCatalog(result);
      })
      .catch((failure: unknown) => {
        if (isActive)
          setCatalogError(
            failure instanceof Error
              ? failure.message.replace(/^Error invoking remote method '[^']+': Error: /u, '')
              : '공식 목록을 읽지 못했어요. 재시도하세요.',
          );
      })
      .finally(() => {
        if (isActive) setIsLoading(false);
      });
    return () => {
      isActive = false;
      void window.cinema.cancelCatalog({ requestId }).catch(() => undefined);
    };
  }, [form.provider, isSelecting, refresh]);
  function update<K extends keyof RuleInput>(key: K, fieldValue: RuleInput[K]) {
    setForm((previous) => ({ ...previous, [key]: fieldValue }));
  }
  function reselect(provider = form.provider) {
    setForm((previous) => ({
      ...previous,
      provider,
      theaterId: '',
      theaterName: '',
      movieId: undefined,
      movieTitle: '',
    }));
    setRegionId('');
    setQuery('');
    setCatalog(undefined);
    setCatalogError('');
    setIsLoading(true);
    setIsSelecting(true);
    setRefresh(0);
    setError('');
  }
  function refreshCatalog() {
    setIsLoading(true);
    setCatalog(undefined);
    setCatalogError('');
    setRefresh((n) => n + 1);
  }
  const current = catalog?.provider === form.provider ? catalog : undefined;
  const theaters = current?.theaters.filter((t) => t.regionId === regionId) ?? [];
  const movies =
    current?.movies.filter((m) => normalizeTitle(m.title).includes(normalizeTitle(query))) ?? [];
  const hasSelection =
    !!current &&
    !isLoading &&
    !catalogError &&
    current.theaters.some(
      (t) => t.id === form.theaterId && t.name === form.theaterName && t.regionId === regionId,
    ) &&
    current.movies.some((m) => m.id === form.movieId && m.title === form.movieTitle);
  const canSave = !isBusy && (!isSelecting || hasSelection);
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      if (!canSave) throw new Error('지역·극장과 검색 결과의 작품을 선택하세요.');
      validateRule(form);
      setError('');
      await onSave(form);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '입력을 확인하세요.');
    }
  }
  return (
    <form className="card ruleForm" onSubmit={(event) => void submit(event)}>
      <h3>{value ? '감시 수정' : '새 감시 추가'}</h3>
      <label>
        영화관
        <select
          aria-label="영화관"
          value={form.provider}
          onChange={(event) => reselect(event.target.value as Provider)}
        >
          {Object.entries(LABELS).map(([key, name]) => (
            <option key={key} value={key}>
              {name}
            </option>
          ))}
        </select>
      </label>
      {!isSelecting ? (
        <div className="savedSelection">
          <strong>저장된 선택</strong>
          <p>
            {form.theaterName} · {form.movieTitle}
          </p>
          <small>
            극장 {form.theaterId}
            {form.movieId ? ` · 작품 ${form.movieId}` : ''}
          </small>
          <button type="button" onClick={() => reselect()}>
            극장·작품 다시 선택
          </button>
        </div>
      ) : (
        <div className="catalogSelection" aria-busy={isLoading}>
          <div className="sectionTitle">
            <span>공식 예매 목록</span>
            <button type="button" className="small" disabled={isLoading} onClick={refreshCatalog}>
              목록 새로고침
            </button>
          </div>
          {isLoading && <p role="status">공식 지역·극장·작품 목록을 불러오고 있어요…</p>}
          {catalogError && (
            <div className="catalogError" role="alert">
              <p>{catalogError}</p>
              <button type="button" onClick={refreshCatalog}>
                재시도
              </button>
            </div>
          )}
          <label>
            지역
            <select
              aria-label="지역"
              value={regionId}
              disabled={!current || isLoading}
              onChange={(event) => {
                setRegionId(event.target.value);
                setForm((previous) => ({ ...previous, theaterId: '', theaterName: '' }));
              }}
            >
              <option value="">지역을 선택하세요</option>
              {current?.regions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            극장
            <select
              aria-label="극장"
              value={form.theaterId}
              disabled={!current || !regionId || isLoading}
              onChange={(event) => {
                const theater = theaters.find((t) => t.id === event.target.value);
                setForm((previous) => ({
                  ...previous,
                  theaterId: theater?.id ?? '',
                  theaterName: theater?.name ?? '',
                }));
              }}
            >
              <option value="">{regionId ? '극장을 선택하세요' : '지역을 먼저 선택하세요'}</option>
              {theaters.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          {current && (!current.regions.length || (regionId && !theaters.length)) && (
            <p role="status">공식 목록에 선택 가능한 극장이 없어요.</p>
          )}
          <label>
            작품 검색
            <input
              type="search"
              aria-label="작품 검색"
              maxLength={120}
              value={query}
              disabled={!current || isLoading}
              placeholder="애니메이션도 제목으로 검색하세요"
              onChange={(event) => {
                setQuery(event.target.value);
                setForm((previous) => ({ ...previous, movieId: undefined, movieTitle: '' }));
              }}
            />
          </label>
          <p className="hint">
            공식 예매 목록의 작품을 검색해요. 아직 목록에 없는 작품은 나중에 다시 확인하세요.
          </p>
          <label>
            작품 검색 결과
            <select
              size={5}
              aria-label="작품 검색 결과"
              value={form.movieId ?? ''}
              disabled={!current || isLoading || !movies.length}
              onChange={(event) => {
                const movie = movies.find((m) => m.id === event.target.value);
                setForm((previous) => ({
                  ...previous,
                  movieId: movie?.id,
                  movieTitle: movie?.title ?? '',
                }));
              }}
            >
              <option value="" disabled>
                작품을 선택하세요
              </option>
              {movies.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title} · {m.id}
                </option>
              ))}
            </select>
          </label>
          {current && (
            <p role="status" aria-live="polite">
              {!current.movies.length
                ? '공식 예매 목록에 작품이 없어요.'
                : !movies.length
                  ? '검색 결과가 없어요. 다른 제목으로 검색하세요.'
                  : `${movies.length}개 작품${form.movieId ? ` · 선택: ${form.movieTitle}` : ' · 결과에서 작품을 선택하세요.'}`}
            </p>
          )}
        </div>
      )}
      <div className="fields">
        <label>
          상영일 (한국 시간)
          <input
            required
            type="date"
            min={koreanToday()}
            aria-label="상영일"
            value={form.date}
            onChange={(event) => update('date', event.target.value)}
          />
        </label>
        <label>
          상영 포맷
          <select
            aria-label="상영 포맷"
            value={form.format}
            onChange={(event) => update('format', event.target.value as RuleInput['format'])}
          >
            {FORMATS.map((format) => (
              <option key={format} value={format}>
                {format === 'ALL' ? '모든 포맷' : format}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button
        type="button"
        aria-pressed={form.shouldNotifyEarliestOnly === true}
        className={form.shouldNotifyEarliestOnly ? 'primary' : undefined}
        onClick={() => update('shouldNotifyEarliestOnly', !form.shouldNotifyEarliestOnly)}
      >
        가장 빠른 회차만 알림
      </button>
      <p className="hint">선택한 포맷에서 처음 확인한 가장 빠른 미래 회차를 날짜별 한 번 알려요.</p>
      {form.format === 'ALL' && (
        <p className="hint">모든 포맷은 이 날짜의 예매가 열리면 한 번 알려요.</p>
      )}
      <label className="toggleLabel">
        <input
          type="checkbox"
          checked={form.isEnabled}
          onChange={(event) => update('isEnabled', event.target.checked)}
        />
        저장 후 감시 켜기
      </label>
      {error && (
        <p role="alert" className="errorText">
          {error}
        </p>
      )}
      <div className="buttonRow">
        <button className="primary" type="submit" disabled={!canSave}>
          감시 저장
        </button>
        <button type="button" onClick={onCancel}>
          취소
        </button>
      </div>
    </form>
  );
}
