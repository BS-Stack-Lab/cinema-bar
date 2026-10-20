import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const profile = await mkdtemp(path.join(os.tmpdir(), 'cinema-smoke-'));
const output = process.env.CINEMA_SMOKE_OUTPUT || path.resolve('release/smoke');
const executable =
  process.platform === 'darwin'
    ? `release/Cinema Bar-darwin-${process.arch}/Cinema Bar.app/Contents/MacOS/Cinema Bar`
    : `release/Cinema Bar-${process.platform}-${process.arch}/Cinema Bar`;
const startedAt = new Date().toISOString();
let timeout;
try {
  await mkdir(output, { recursive: true });
  await rm(path.join(output, 'desktop-smoke.json'), { force: true });
  const result = await new Promise((resolve, reject) => {
    const child = spawn(path.resolve(executable), ['--cinema-smoke'], {
      env: {
        ...process.env,
        CINEMA_SMOKE: '1',
        CINEMA_SMOKE_PROFILE: profile,
        CINEMA_SMOKE_OUTPUT: output,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let diagnostics = '';
    child.stdout.on('data', (data) => {
      diagnostics += data;
    });
    child.stderr.on('data', (data) => {
      diagnostics += data;
    });
    child.on('error', reject);
    timeout = setTimeout(() => {
      child.kill('SIGTERM');
    }, 45000);
    child.on('close', (code, signal) => resolve({ code, signal, diagnostics }));
  });
  await writeFile(
    path.join(output, 'desktop-attempt.json'),
    JSON.stringify(
      { startedAt, finishedAt: new Date().toISOString(), profile, ...result },
      null,
      2,
    ),
  );
  let evidence;
  try {
    evidence = JSON.parse(await readFile(path.join(output, 'desktop-smoke.json'), 'utf8'));
  } catch {
    throw new Error(`Desktop smoke produced no fresh evidence: ${JSON.stringify(result)}`);
  }
  if (
    result.code !== 0 ||
    result.signal ||
    !evidence.passed ||
    evidence.isolatedUserData !== profile
  )
    throw new Error(
      JSON.stringify({
        result,
        evidenceMatchesProfile: evidence.isolatedUserData === profile,
        evidence,
      }),
    );
  process.stdout.write(
    `Desktop smoke passed: ${evidence.actions.length} observable checks; ${path.join(output, 'desktop.png')}\n`,
  );
} finally {
  clearTimeout(timeout);
  await rm(profile, { recursive: true, force: true });
}
