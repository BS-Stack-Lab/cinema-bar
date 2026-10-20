import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { copyFileSync, renameSync } from 'node:fs';
import { validateState } from './validation.js';
import type { State } from './types.js';
export const createState = (): State => ({
  schemaVersion: 1,
  rules: [],
  settings: {
    intervalSeconds: 120,
    isPaused: false,
    shouldStartAtLogin: true,
    hasConfiguredLogin: false,
  },
  progress: {},
  secret: { revision: 0, isTerminal: false },
  outbox: [],
  dedupe: {},
  history: [],
});
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
    try {
      primary = await readFile(this.file, 'utf8');
      this.state = validateState(JSON.parse(primary));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          await readFile(`${this.file}.backup`, 'utf8');
        } catch (backupError) {
          if ((backupError as NodeJS.ErrnoException).code === 'ENOENT') return;
        }
      }
      if (primary) {
        try {
          const value = JSON.parse(primary);
          if (value.schemaVersion > 1) {
            this.recoveryError = '새 버전 저장 형식입니다. 앱을 업데이트하세요. 원본은 보존됩니다.';
            return;
          }
        } catch {
          /* Corrupt originals are preserved for explicit recovery. */
        }
      }
    }
    try {
      this.state = validateState(JSON.parse(await readFile(`${this.file}.backup`, 'utf8')));
      if (primary !== undefined)
        await writeFile(`${this.file}.corrupt-${Date.now()}`, primary, { mode: 0o600 });
      await this.atomic(this.state, false);
    } catch {
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
