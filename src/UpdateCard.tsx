import { useEffect, useState } from 'react';
import type { UpdateState } from '../electron/types';
const LABELS: Record<UpdateState['phase'], string> = {
  disabled: '앱 업데이트 안내',
  idle: '새 버전을 확인해 보세요',
  checking: '새 버전을 확인하고 있어요…',
  current: '최신 버전을 사용하고 있어요',
  available: '업데이트가 있어요',
  downloading: '설치 파일을 받고 있어요…',
  verifying: '파일을 확인하고 있어요…',
  ready: '설치 파일이 준비됐어요',
  opening: '설치 파일을 열고 있어요…',
  opened: '설치 파일을 열었어요',
  error: '업데이트를 완료하지 못했어요',
};
const megabytes = (value: number) => (value / 1024 / 1024).toFixed(1);
export function UpdateCard() {
  const [state, setState] = useState<UpdateState>();
  const [error, setError] = useState('');
  useEffect(() => {
    let mounted = true;
    const receive = (next: UpdateState) => {
      if (mounted)
        setState((current) => (!current || next.revision >= current.revision ? next : current));
    };
    const unsubscribe = window.cinema.onUpdateState(receive);
    void window.cinema
      .getUpdateState()
      .then(receive)
      .catch(() => {
        if (mounted) setError('업데이트 상태를 읽지 못했어요. 설정을 다시 열어 주세요.');
      });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
  const action = async (request: () => Promise<UpdateState>) => {
    setError('');
    try {
      const next = await request();
      setState((current) => (!current || next.revision >= current.revision ? next : current));
    } catch {
      setError('업데이트 요청을 완료하지 못했어요. 다시 시도하세요.');
    }
  };
  const progress = state?.phase === 'downloading' || state?.phase === 'verifying';
  const installer = state && ['ready', 'opening', 'opened'].includes(state.phase);
  return (
    <section className="card settingsCard updateCard" aria-label="앱 업데이트">
      <h3>앱 업데이트</h3>
      {state ? (
        <>
          <p>
            현재 버전 <strong>{state.currentVersion}</strong>
            <small>{state.platformLabel}</small>
          </p>
          <p role="status" aria-live="polite" aria-atomic="true">
            {state.availableVersion && state.phase === 'available'
              ? `${state.availableVersion} 업데이트가 있어요`
              : LABELS[state.phase]}
          </p>
          {state.message && (
            <p
              className={state.phase === 'error' || state.phase === 'ready' ? 'errorText' : 'hint'}
              role={state.phase === 'error' || state.phase === 'ready' ? 'alert' : undefined}
            >
              {state.message}
            </p>
          )}
          {progress && (
            <>
              <progress
                aria-label="업데이트 다운로드 진행률"
                max={100}
                value={Math.floor(((state.downloadedBytes ?? 0) / (state.totalBytes ?? 1)) * 100)}
              />
              <p className="hint">
                {megabytes(state.downloadedBytes ?? 0)} MB / {megabytes(state.totalBytes ?? 0)} MB
              </p>
            </>
          )}
          {state.phase === 'available' && state.totalBytes && (
            <p className="hint">설치 파일 {megabytes(state.totalBytes)} MB</p>
          )}
          {state.lastCheckedAt && (
            <p className="hint">
              마지막 확인: {new Date(state.lastCheckedAt).toLocaleString('ko-KR')}
            </p>
          )}
          {state.nextCheckAllowedAt && (
            <p className="hint">
              다음 확인 가능: {new Date(state.nextCheckAllowedAt).toLocaleString('ko-KR')}
            </p>
          )}
          <div className="buttonRow">
            {['idle', 'current', 'checking', 'error'].includes(state.phase) && (
              <button
                disabled={state.phase === 'checking'}
                onClick={() => void action(() => window.cinema.checkForUpdates())}
              >
                업데이트 확인
              </button>
            )}
            {(state.phase === 'available' ||
              (state.phase === 'error' && state.availableVersion)) && (
              <button
                className="primary"
                onClick={() => void action(() => window.cinema.downloadUpdate())}
              >
                업데이트 다운로드
              </button>
            )}
            {progress && (
              <button onClick={() => void action(() => window.cinema.cancelUpdate())}>
                다운로드 취소
              </button>
            )}
            {installer && (
              <button
                className="primary"
                disabled={state.phase === 'opening'}
                onClick={() => void action(() => window.cinema.openUpdateInstaller())}
              >
                {state.phase === 'opened' ? '설치 파일 다시 열기' : '설치 파일 열기'}
              </button>
            )}
          </div>
          {installer && (
            <p className="hint">
              Cinema Bar를 종료한 뒤 설치를 완료하세요. 감시 조건·설정·웹훅은 유지돼요.
              <br />
              {state.platformLabel.startsWith('macOS')
                ? 'DMG에서 Cinema Bar.app을 응용 프로그램으로 드래그해 기존 앱을 교체하세요.'
                : '설치 창에서 기존 Cinema Bar와 같은 위치에 설치하세요.'}
            </p>
          )}
        </>
      ) : (
        <p role="status">업데이트 상태를 읽고 있어요…</p>
      )}
      {error && (
        <p role="alert" className="errorText">
          {error}
        </p>
      )}
    </section>
  );
}
