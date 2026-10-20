import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const profile = await mkdtemp(path.join(os.tmpdir(), 'cinema-live-'));
const output = process.env.CINEMA_LIVE_OUTPUT || path.resolve('release/live');
const startedAt = new Date().toISOString();
await mkdir(output, { recursive: true });
await rm(path.join(output, 'live-probe.json'), { force: true });
let timer;
try {
  const env = { ...process.env, CINEMA_LIVE_PROFILE: profile, CINEMA_LIVE_OUTPUT: output };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      createRequire(import.meta.url)('electron'),
      [path.resolve('scripts/liveProbe.cjs')],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let diagnostics = '';
    child.stdout.on('data', (data) => {
      diagnostics += data;
    });
    child.stderr.on('data', (data) => {
      diagnostics += data;
    });
    child.on('error', reject);
    timer = setTimeout(() => child.kill(), 180000);
    child.on('exit', (code, signal) => resolve({ code, signal, diagnostics }));
  });
  await writeFile(
    path.join(output, 'live-attempt.json'),
    JSON.stringify(
      { startedAt, finishedAt: new Date().toISOString(), profile, ...result },
      null,
      2,
    ),
  );
  const evidence = JSON.parse(await readFile(path.join(output, 'live-probe.json'), 'utf8'));
  if (
    result.code !== 0 ||
    !evidence.passed ||
    evidence.isolatedProfile !== profile ||
    evidence.providers.length !== 3
  )
    throw new Error(`Live verification failed: ${JSON.stringify({ ...result, evidence })}`);
  process.stdout.write(
    `All three providers passed two actual Engine reads: ${path.join(output, 'live-probe.json')}\n`,
  );
} finally {
  clearTimeout(timer);
  await rm(profile, { recursive: true, force: true });
}
