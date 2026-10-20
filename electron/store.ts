import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { copyFileSync, renameSync } from 'node:fs';
import { validateState } from './validation.js';
import type { State } from './types.js';
export const createState = (): State => ({
  schemaVersion: 2,
  rules: [],
  settings: {
    intervalSeconds: 120,
    isPaused: false,
    shouldStartAtLogin: true,
    hasConfiguredLogin: false,
    shouldNotifyLocally: true,
  },
  progress: {},
  secret: { revision: 0, isTerminal: false },
  outbox: [],
  dedupe: {},
  localOutbox: [],
  localDedupe: {},
  history: [],
});
export function migrateState(value: unknown, now = Date.now()): State {
  const legacy = structuredClone(validateState(value, true));
  const state: State = {
    ...legacy,
    schemaVersion: 2,
    settings: { ...legacy.settings, shouldNotifyLocally: true },
    localOutbox: [],
    localDedupe: {},
  };
  for (const rule of state.rules.filter((r) => r.provider === 'cgv')) {
    const progress = state.progress[rule.id];
    if (progress) {
      delete progress.baseline;
      progress.nextAt = Math.max(now, progress.retryUntil ?? 0);
    }
  }
  state.outbox = state.outbox.filter((item) => {
    if (item.session.provider !== 'cgv') return true;
    if (state.dedupe[item.id] === 0) delete state.dedupe[item.id];
    state.history.unshift({
      id: randomUUID(),
      at: now,
      kind: 'cancelled',
      title: item.session.movieTitle,
      detail:
        'CGV 상영 식별자 갱신으로 이전 전송 대기를 종료했습니다. 다음 조회를 새 기준선으로 저장합니다.',
    });
    return false;
  });
  state.history = state.history.slice(0, 100);
  state.localOutbox = state.outbox
    .filter(
      (q) =>
        now - q.createdAt < 86400000 &&
        q.secretRevision === state.secret.revision &&
        q.ruleRefs.some((ref) =>
          state.rules.some((r) => r.isEnabled && r.id === ref.id && r.revision === ref.revision),
        ),
    )
    .slice(-100)
    .map(({ secretRevision: _revision, ...item }) => {
      void _revision;
      state.localDedupe[item.id] = 0;
      return { ...item, nextAt: now, attempts: 0 };
    });
  return validateState(state);
}
export class Store {
  state = createState();
  recoveryError?: string;
  private queue: Promise<unknown> = Promise.resolve();
  readonly file: string;
  constructor(
    readonly directory: string,
    private beforeRename?: () => Promise<void>,
  ) {
    this.file = path.join(directory, 'state.json');
  }
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let primary: string | undefined;
    const accept = async (content: string, isBackup: boolean) => {
      const value = JSON.parse(content);
      if (value?.schemaVersion > 2) {
        this.recoveryError = '새 버전 저장 형식입니다. 앱을 업데이트하세요. 원본은 보존됩니다.';
        return true;
      }
      let next: State;
      try {
        next = value?.schemaVersion === 1 ? migrateState(value) : validateState(value);
      } catch {
        return false;
      }
      try {
        if (isBackup && primary !== undefined)
          await writeFile(`${this.file}.corrupt-${Date.now()}`, primary, { mode: 0o600 });
        if (value.schemaVersion === 1 || isBackup) await this.atomic(next, !isBackup);
        this.state = next;
      } catch {
        this.recoveryError =
          '저장 형식 변환 또는 복구 쓰기에 실패했습니다. 감시를 중단하고 원본을 보존했습니다.';
      }
      return true;
    };
    try {
      primary = await readFile(this.file, 'utf8');
      if (await accept(primary, false)) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && primary === undefined) {
        this.recoveryError = '저장 파일을 읽을 수 없습니다. 원본은 보존됩니다.';
        return;
      }
    }
    try {
      if (!(await accept(await readFile(`${this.file}.backup`, 'utf8'), true)))
        throw new Error('Invalid backup');
    } catch (error) {
      if (primary === undefined && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.recoveryError =
        '저장 파일과 백업을 읽을 수 없습니다. 원본을 보존했습니다. 복구 초기화를 선택하세요.';
    }
  }
  mutate(update: (state: State) => void, shouldCommit: () => boolean = () => true) {
    const task = this.queue.then(async () => {
      if (this.recoveryError) throw new Error(this.recoveryError);
      if (!shouldCommit()) return;
      const next = structuredClone(this.state);
      update(next);
      validateState(next);
      if (await this.atomic(next, true, shouldCommit)) this.state = next;
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
  private async atomic(state: State, backup: boolean, shouldCommit: () => boolean = () => true) {
    const temp = `${this.file}.tmp`;
    const content = JSON.stringify(state);
    await writeFile(temp, content, { mode: 0o600 });
    if (this.beforeRename) await this.beforeRename();
    if (!shouldCommit()) return false;
    if (backup) {
      try {
        copyFileSync(this.file, `${this.file}.backup.tmp`);
        renameSync(`${this.file}.backup.tmp`, `${this.file}.backup`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    renameSync(temp, this.file);
    return true;
  }
  async recover() {
    await this.queue;
    const stamp = Date.now();
    for (const file of [this.file, `${this.file}.backup`]) {
      try {
        await rename(file, `${file}.preserved-${stamp}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    this.state = createState();
    await this.atomic(this.state, false);
    this.recoveryError = undefined;
  }
}
