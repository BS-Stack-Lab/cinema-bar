import { status } from './status';
import { useEffect, useState, type FormEvent } from 'react';
import { FORMATS, type Provider, type RuleInput, type Snapshot } from '../electron/types';
import { koreanToday, validateRule } from '../electron/validation';
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
      : snapshot.rules.filter((r) => r.isEnabled && r.date >= koreanToday()).length;
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
                  <br />새 예매가 열리면 Discord로 알려드려요.
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
                  {String(snapshot.pendingCount).padStart(2, '0')}
                  <small> 건</small>
                </strong>
                <p>
                  {snapshot.hasWebhook
                    ? snapshot.isWebhookBlocked
                      ? '웹훅 재연결 필요'
                      : 'Discord 연결됨'
                    : '설정에서 Discord 연결'}
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
            <p className="hint">첫 성공 조회는 기준선만 저장해요. 그다음 새 상영부터 알려드려요.</p>
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
                    <div className="ticketArt" aria-hidden="true">
                      ▥<span>{rule.format === 'ALL' ? 'ALL SCREENS' : rule.format}</span>
                    </div>
                    <h3>{rule.movieTitle}</h3>
                    <p>{rule.theaterName}</p>
                    <div className="ruleMeta">
                      {rule.date}
                      <br />
                      {rule.format === 'ALL' ? '모든 포맷' : rule.format} · ID {rule.theaterId}
                    </div>
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
                            const { revision: _revision, movieId: _movieId, ...input } = rule;
                            void _revision;
                            void _movieId;
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
                            sent: '전송 완료',
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
            <p className="hint">네트워크 응답이 불명확하면 같은 알림이 다시 도착할 수 있어요.</p>
          </>
        )}
        {tab === '설정' && (
          <>
            <div className="sectionTitle">
              <h2>내 연결과 실행</h2>
              <span>이 기기에만 저장</span>
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
                <h3>Discord 연결</h3>
                <span
                  className={`badge ${snapshot.hasWebhook && !snapshot.isWebhookBlocked ? 'green' : 'amber'}`}
                >
                  {snapshot.isWebhookBlocked
                    ? '교체 필요'
                    : snapshot.hasWebhook
                      ? '연결됨'
                      : '연결 필요'}
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
                CGV 공개 조회는 HTTP 403으로 제한될 수 있어요. 인증 우회 없이 공급자 오류로
                표시합니다.
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
function RuleForm({ value, isBusy, onCancel, onSave }: RuleFormProps) {
  const [form, setForm] = useState<RuleInput>(
    value
      ? {
          id: value.id,
          provider: value.provider,
          theaterId: value.theaterId,
          theaterName: value.theaterName,
          movieTitle: value.movieTitle,
          date: value.date,
          format: value.format,
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
  const [error, setError] = useState('');
  function update<K extends keyof RuleInput>(key: K, value: RuleInput[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      validateRule(form);
      setError('');
      await onSave(form);
    } catch (e) {
      setError(e instanceof Error ? e.message : '입력을 확인하세요.');
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
          onChange={(event) => update('provider', event.target.value as Provider)}
        >
          {Object.entries(LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <div className="fields">
        <label>
          극장 ID
          <input
            required
            maxLength={24}
            aria-label="극장 ID"
            value={form.theaterId}
            onChange={(event) => update('theaterId', event.target.value)}
            placeholder="공식 사이트의 극장 ID"
          />
        </label>
        <label>
          극장 이름
          <input
            required
            maxLength={80}
            aria-label="극장 이름"
            value={form.theaterName}
            onChange={(event) => update('theaterName', event.target.value)}
            placeholder="예: 코엑스"
          />
        </label>
      </div>
      <p className="hint">
        영화관 공식 예매 페이지의 극장 번호를 입력하세요. CGV siteNo, Megabox brchNo, 롯데
        CinemaID를 사용해요.
      </p>
      <label>
        작품 제목 (전체 일치)
        <input
          required
          maxLength={120}
          aria-label="작품 제목"
          value={form.movieTitle}
          onChange={(event) => update('movieTitle', event.target.value)}
          placeholder="찾고 있는 작품의 정확한 제목"
        />
      </label>
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
        <button className="primary" type="submit" disabled={isBusy}>
          감시 저장
        </button>
        <button type="button" onClick={onCancel}>
          취소
        </button>
      </div>
    </form>
  );
}
