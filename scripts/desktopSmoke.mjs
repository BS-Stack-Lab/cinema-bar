import { spawn, execFile } from 'node:child_process';
import {
  mkdtemp,
  rm,
  readFile,
  mkdir,
  writeFile,
  cp,
  readdir,
  readlink,
  realpath,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
const temporary = await mkdtemp(path.join(os.tmpdir(), 'cinema-smoke-'));
const profile = path.join(temporary, 'profile');
const output = path.resolve(process.env.CINEMA_SMOKE_OUTPUT || 'release/smoke');
const originalBundle = path.resolve(`release/Cinema Bar-darwin-${process.arch}/Cinema Bar.app`);
let executable =
  process.platform === 'darwin'
    ? path.join(originalBundle, 'Contents/MacOS/Cinema Bar')
    : path.join(
        `release/Cinema Bar-${process.platform}-${process.arch}`,
        process.platform === 'win32' ? 'Cinema Bar.exe' : 'Cinema Bar',
      );
if (process.env.CINEMA_SMOKE_EXECUTABLE) {
  assert.notEqual(process.platform, 'darwin', 'macOS smoke requires an isolated app identity');
  executable = path.resolve(process.env.CINEMA_SMOKE_EXECUTABLE);
}
const startedAt = new Date().toISOString();
const execute = promisify(execFile);
const canonicalId = 'dev.cinemabar.desktop';
const verificationId = 'dev.cinemabar.verification';
const displayName = 'Cinema Bar Verification';
const identityEvidence = { startedAt, canonicalId, verificationId, displayName };
const bundleHash = async (directory) => {
  const hash = createHash('sha256');
  const visit = async (relative) => {
    const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const name = path.join(relative, entry.name);
      hash.update(
        `${entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'dir' : 'file'}:${name}\0`,
      );
      if (entry.isSymbolicLink()) hash.update(await readlink(path.join(directory, name)));
      else if (entry.isDirectory()) await visit(name);
      else
        for await (const chunk of createReadStream(path.join(directory, name))) hash.update(chunk);
    }
  };
  await visit('');
  return hash.digest('hex');
};
const plist = async (file, command) =>
  (await execute('/usr/libexec/PlistBuddy', ['-c', command, file])).stdout.trim();
let timeout;
let originalHash;
try {
  await mkdir(profile);
  await mkdir(output, { recursive: true });
  for (const name of [
    'desktop-smoke.json',
    'smoke-primary-identity.json',
    'smoke-secondary-identity.json',
  ])
    await rm(path.join(output, name), { force: true });
  if (process.platform === 'darwin') {
    originalHash = await bundleHash(originalBundle);
    const originalPlist = path.join(originalBundle, 'Contents/Info.plist');
    assert.equal(await plist(originalPlist, 'Print :CFBundleIdentifier'), canonicalId);
    const verificationBundle = path.join(temporary, `${displayName}.app`);
    await cp(originalBundle, verificationBundle, { recursive: true, verbatimSymlinks: true });
    assert.equal(
      await bundleHash(verificationBundle),
      originalHash,
      'Clone must preserve source bytes and symlinks',
    );
    const verificationPlist = path.join(verificationBundle, 'Contents/Info.plist');
    await plist(verificationPlist, `Set :CFBundleIdentifier ${verificationId}`);
    await plist(verificationPlist, `Set :CFBundleDisplayName ${displayName}`);
    assert.equal(
      await plist(verificationPlist, 'Print :CFBundleName'),
      await plist(originalPlist, 'Print :CFBundleName'),
      'Preserve the bundle name used by Electron to locate its helpers',
    );
    const frameworks = path.join(verificationBundle, 'Contents/Frameworks');
    const helperIds = [];
    for (const entry of await readdir(frameworks, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith('.app')) continue;
      const helperPlist = path.join(frameworks, entry.name, 'Contents/Info.plist');
      const originalId = await plist(helperPlist, 'Print :CFBundleIdentifier');
      assert.ok(
        originalId.startsWith(`${canonicalId}.helper`),
        'Unexpected production helper identity',
      );
      const helperId = `${verificationId}${originalId.slice(canonicalId.length)}`;
      await plist(helperPlist, `Set :CFBundleIdentifier ${helperId}`);
      assert.equal(await plist(helperPlist, 'Print :CFBundleIdentifier'), helperId);
      helperIds.push({ name: entry.name, originalId, verificationId: helperId });
    }
    assert.ok(helperIds.length > 0, 'Verification clone must include isolated helper identities');
    assert.equal(await plist(verificationPlist, 'Print :CFBundleIdentifier'), verificationId);
    assert.equal(await plist(verificationPlist, 'Print :CFBundleDisplayName'), displayName);
    assert.equal(await plist(verificationPlist, 'Print :CFBundleExecutable'), 'Cinema Bar');
    Object.assign(identityEvidence, {
      originalBundle,
      originalHash,
      verificationBundle,
      helperIds,
      preparedBeforeFirstSpawn: true,
    });
    executable = path.join(verificationBundle, 'Contents/MacOS/Cinema Bar');
    await writeFile(
      path.join(output, 'desktop-identity.json'),
      JSON.stringify(identityEvidence, null, 2),
    );
  }
  const result = await new Promise((resolve, reject) => {
    const child = spawn(path.resolve(executable), ['--cinema-smoke'], {
      env: {
        ...process.env,
        CINEMA_SMOKE: '1',
        CINEMA_SMOKE_PROFILE: profile,
        CINEMA_SMOKE_OUTPUT: output,
        CINEMA_SMOKE_SECONDARY: '0',
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
      child.kill('SIGKILL');
    }, 60000);
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
  for (const name of [
    'mock-poster-real-raster-decode-and-banner',
    'native-prevent-app-suspension-start',
    'native-blocker-explicit-optout',
    'engine-popup-earliest-survives-later-burst',
    'engine-popup-next-slot-drains-without-repoll',
  ])
    assert.ok(
      evidence.actions.some((action) => action.name === name && action.passed),
      `Missing observable ${name}`,
    );
  for (const role of ['primary', 'secondary']) {
    const identity = JSON.parse(
      await readFile(path.join(output, `smoke-${role}-identity.json`), 'utf8'),
    );
    assert.equal(identity.isolatedUserData, profile);
    assert.equal(identity.executable, await realpath(executable));
    assert.equal(identity.codec, 'in-memory');
    assert.equal(identity.realSafeStorageCalls, 0);
    assert.equal(identity.hasLock, role === 'primary');
    if (process.platform === 'darwin') {
      assert.equal(identity.bundleId, verificationId);
      assert.equal(identity.displayName, displayName);
    }
  }
  process.stdout.write(
    `Desktop smoke passed: ${evidence.actions.length} observable checks; ${path.join(output, 'desktop.png')}\n`,
  );
} finally {
  clearTimeout(timeout);
  try {
    if (originalHash) {
      const finalHash = await bundleHash(originalBundle);
      Object.assign(identityEvidence, {
        finalCanonicalHash: finalHash,
        canonicalUnchanged: finalHash === originalHash,
      });
      await writeFile(
        path.join(output, 'desktop-identity.json'),
        JSON.stringify(identityEvidence, null, 2),
      );
      assert.equal(finalHash, originalHash, 'Canonical release must remain unchanged');
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
