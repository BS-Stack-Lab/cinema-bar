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
    await execute('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', verificationBundle]);
    await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', verificationBundle]);
    Object.assign(identityEvidence, { cloneAdHocResigned: true, cloneSignatureVerified: true });
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
  const sharedActions = [
    'primary-smoke-identity-isolated',
    'smoke-memory-codec-roundtrip',
    'actual-renderer-mounted',
    'header-native-drag-css-boundary',
    'sandbox-contextIsolation-nodeIntegration',
    'renderer-narrow-api',
    'reduced-motion-disables-decoration',
    'tab-감시 목록',
    'tab-알림 기록',
    'tab-설정',
    'tab-대시보드',
    'keyboard-tab-arrow',
    'form-controls-excluded-from-native-drag',
    'catalog-no-manual-theater-inputs',
    'earliest-button-click-selected',
    'earliest-button-keyboard-does-not-submit',
    'ui-rule-form-save',
    'earliest-button-save-disk-reload',
    'earliest-button-edit-persisted',
    'mock-poster-real-raster-decode-and-banner',
    'poster-natural-ratio-440-portrait',
    'poster-controls-reachable-440-portrait',
    'poster-natural-ratio-440-square',
    'poster-controls-reachable-440-square',
    'poster-natural-ratio-440-landscape',
    'poster-controls-reachable-440-landscape',
    'poster-natural-ratio-340-portrait',
    'poster-controls-reachable-340-portrait',
    'poster-natural-ratio-340-square',
    'poster-controls-reachable-340-square',
    'poster-natural-ratio-340-landscape',
    'poster-controls-reachable-340-landscape',
    'poster-decode-error-restores-70px-ticket-fallback',
    'poster-recovers-after-decode-error-remount',
    'poster-ipc-rejects-arbitrary-url',
    'renderer-csp-retains-image-and-network-boundary',
    'native-keepawake-default-off',
    'native-prevent-app-suspension-start',
    'native-blocker-released-on-pause',
    'native-blocker-resumes-for-active-rule',
    'native-blocker-released-on-suspend',
    'native-blocker-explicit-optout',
    'catalog-input-rejection',
    'invalid-ipc-rejected',
    'external-url-rejected',
    'mock-login-enabled-roundtrip',
    'mock-login-optout-persisted',
    'mock-login-optout-reinitialize',
    'native-login-read-only',
    'injected-suspend',
    'injected-offline',
    'injected-resume-online',
    'tray-toggle-hide',
    'tray-toggle-show',
    'close-hides-process-survives',
    'dock-activate-reopens-visible',
    'invalid-tray-cursor-safe-placement',
    'small-work-area-800',
    'small-work-area-320',
    'single-instance-second-exits',
    'second-instance-reopens-window',
    'second-instance-verification-identity',
    'single-instance-keeps-one-window',
    'tray-valid-template-bitmap',
    'tray-CB-identity',
    'dock-and-warning-match-tray-placement',
    'tray-visibility-warning-factual',
    'capture-dom-is-current-dashboard',
    'owned-popup-actual-show',
    'popup-security-preferences',
    'popup-no-focus-steal',
    'popup-escaped-no-capabilities',
    'popup-window-open-denied',
    'popup-real-capture',
    'popup-limit-three',
    'popup-within-work-area',
    'popup-native-dismiss',
    'popup-pre-abort-no-window',
    'popup-cancel-closes-window',
    'popup-load-failure-bounded',
    'popup-auto-close-eight-seconds',
    'popup-single-slot-full-readiness',
    'popup-zero-slot-processes-unsupported',
    'popup-no-screen-processes-unsupported',
    'popup-full-readiness-preserves-queue',
    'engine-popup-earliest-actually-first',
    'engine-popup-capacity-queues-overflow',
    'engine-popup-earliest-survives-later-burst',
    'engine-popup-next-slot-drains-without-repoll',
    'engine-popup-burst-completes-before-history-assertion',
    'engine-popup-all-four-attempted-once',
    'day-popup-one-native-false',
    'day-popup-wording-false',
    'day-popup-no-repeat-false',
    'day-popup-one-native-true',
    'day-popup-wording-true',
    'day-popup-no-repeat-true',
    'popup-quit-cleanup',
    'capturePage-real-electron',
    'snapshot-no-plaintext-webhook',
    'update-state-current-version',
    'update-check-stable-platform',
    'update-download-hash-ready',
    'update-download-cancel-cleans-partial',
    'update-installer-open-failure-keeps-running',
    'update-installer-open-retry-no-redownload',
    'update-ipc-rejects-payload',
    'update-isolation-no-real-side-effects',
    'update-cooldown-survives-manager-restart',
    'update-metadata-failure-blocks-network',
    'update-user-quit-cleanup-order',
    'update-user-quit-deadline-once',
    'update-quit-cleanup-error-continues',
    'update-handed-off-file-retained',
  ];
  const macActions = [
    'synthetic-valid-tray-clears-warning-and-hides-dock',
    'synthetic-invalid-tray-publishes-warning-and-shows-dock',
    'synthetic-valid-tray-restores-hidden-dock',
    'synthetic-external-dock-show-observed',
    'stable-tray-new-dock-show-settles-hidden',
    'stable-tray-reconciles-new-dock-show-once',
    'native-dock-policy-restored-after-fixture',
  ];
  const expectedActions = [...sharedActions, ...(process.platform === 'darwin' ? macActions : [])];
  const actualNames = evidence.actions.map((action) => action.name);
  assert.equal(actualNames.length, process.platform === 'darwin' ? 121 : 114);
  assert.equal(new Set(actualNames).size, actualNames.length, 'Smoke action names must be unique');
  assert.deepEqual(
    [...actualNames].sort(),
    [...expectedActions].sort(),
    'Exact baseline plus updater action set',
  );
  assert.ok(evidence.actions.every((action) => action.passed));
  assert.ok(
    evidence.updateIsolation.mockTransport &&
      evidence.updateIsolation.mockOpener &&
      evidence.updateIsolation.mockQuit,
  );
  assert.equal(evidence.updateIsolation.realUpdateNetworkCalls, 0);
  assert.equal(evidence.updateIsolation.realInstallerOpens, 0);
  assert.equal(evidence.updateIsolation.updaterQuitRequests, 0);
  assert.equal(evidence.updateIsolation.downloadsPath, path.join(profile, 'Downloads'));
  assert.equal(evidence.updateIsolation.metadataPath, path.join(profile, 'update-check.json'));
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
