import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
if (process.argv.slice(2).some((arg) => arg !== '--catalog') || process.argv.slice(2).length > 1)
  throw new Error('Only the fixed --catalog mode is supported.');
const isCatalog = process.argv.includes('--catalog');
const mode = isCatalog ? 'catalog' : 'live';
const profile = await mkdtemp(path.join(os.tmpdir(), `cinema-${mode}-`));
const output =
  (isCatalog ? process.env.CINEMA_CATALOG_OUTPUT : process.env.CINEMA_LIVE_OUTPUT) ||
  path.resolve(`release/${mode}`);
const startedAt = new Date().toISOString();
await mkdir(output, { recursive: true });
await rm(path.join(output, `${mode}-probe.json`), { force: true });
let timer;
try {
  const env = {
    ...process.env,
    [isCatalog ? 'CINEMA_CATALOG_PROFILE' : 'CINEMA_LIVE_PROFILE']: profile,
    [isCatalog ? 'CINEMA_CATALOG_OUTPUT' : 'CINEMA_LIVE_OUTPUT']: output,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      createRequire(import.meta.url)('electron'),
      [path.resolve(isCatalog ? 'scripts/catalogProbe.cjs' : 'scripts/liveProbe.cjs')],
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
    path.join(output, `${mode}-attempt.json`),
    JSON.stringify(
      { startedAt, finishedAt: new Date().toISOString(), profile, ...result },
      null,
      2,
    ),
  );
  const evidence = JSON.parse(await readFile(path.join(output, `${mode}-probe.json`), 'utf8'));
  if (
    result.code !== 0 ||
    !evidence.passed ||
    evidence.isolatedProfile !== profile ||
    evidence.providers.length !== 3 ||
    !Number.isFinite(Date.parse(evidence.startedAt)) ||
    Date.parse(evidence.startedAt) < Date.parse(startedAt) ||
    Date.parse(evidence.finishedAt) < Date.parse(evidence.startedAt) ||
    !Number.isFinite(Date.parse(evidence.finishedAt))
  )
    throw new Error(`Live verification failed: ${JSON.stringify({ ...result, evidence })}`);
  process.stdout.write(
    `All three providers passed ${isCatalog ? 'official catalog and non-Seoul showtime checks' : 'two actual Engine reads'}: ${path.join(output, `${mode}-probe.json`)}\n`,
  );
} finally {
  clearTimeout(timer);
  await rm(profile, { recursive: true, force: true });
}
