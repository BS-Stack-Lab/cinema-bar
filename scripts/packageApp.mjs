import { packager } from '@electron/packager';
import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
await build({
  entryPoints: ['electron/preload.ts'],
  outfile: 'dist-electron/preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  target: 'node22',
});
const staging = path.resolve('release/staging');
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await cp('dist', path.join(staging, 'dist'), { recursive: true });
await cp('dist-electron', path.join(staging, 'dist-electron'), { recursive: true });
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
await writeFile(
  path.join(staging, 'package.json'),
  JSON.stringify({
    name: pkg.name,
    productName: 'Cinema Bar',
    version: pkg.version,
    type: 'module',
    main: pkg.main,
  }),
);
const outputs = await packager({
  dir: staging,
  name: 'Cinema Bar',
  appBundleId: 'local.cinemabar.desktop',
  out: 'release',
  overwrite: true,
  platform: process.platform,
  arch: process.arch,
  electronVersion: pkg.devDependencies.electron,
  download: { cacheRoot: process.env.ELECTRON_CACHE || path.resolve('../work/electron-cache') },
  asar: true,
  prune: false,
  osxSign: false,
  executableName: 'Cinema Bar',
});
process.stdout.write(`${outputs.join('\n')}\n`);
