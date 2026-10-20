import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ICNS_SIZES = {
  icp4: 16,
  icp5: 32,
  icp6: 64,
  ic07: 128,
  ic08: 256,
  ic09: 512,
  ic10: 1024,
};
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
export async function renderIcons() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'cinema-icon-render-'));
  try {
    const resultFile = path.join(temp, 'images.json');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    await new Promise((resolve, reject) => {
      const child = spawn(
        createRequire(import.meta.url)('electron'),
        [
          path.join(root, 'scripts/iconRenderer.cjs'),
          path.join(root, 'public/projector.svg'),
          resultFile,
        ],
        { env, stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let diagnostic = '';
      child.stderr.on('data', (chunk) => {
        diagnostic += chunk;
      });
      const timeout = setTimeout(() => child.kill(), 30000);
      child.on('error', reject);
      child.on('exit', (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new Error(`Icon renderer failed (${code}): ${diagnostic.slice(-1000)}`));
      });
    });
    const result = JSON.parse(await readFile(resultFile, 'utf8'));
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    if (result.electron !== pkg.devDependencies.electron)
      throw new Error('Pinned Electron runtime required.');
    return Object.fromEntries(
      Object.entries(result.images).map(([size, image]) => [size, Buffer.from(image, 'base64')]),
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
export function containers(images) {
  const chunks = Object.entries(ICNS_SIZES).map(([type, size]) => {
    const data = images[size];
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([header, data]);
  });
  const header = Buffer.alloc(8);
  header.write('icns');
  header.writeUInt32BE(8 + chunks.reduce((length, chunk) => length + chunk.length, 0), 4);
  const icoHeader = Buffer.alloc(6 + ICO_SIZES.length * 16);
  icoHeader.writeUInt16LE(1, 2);
  icoHeader.writeUInt16LE(ICO_SIZES.length, 4);
  let offset = icoHeader.length;
  ICO_SIZES.forEach((size, index) => {
    const start = 6 + index * 16;
    icoHeader[start] = icoHeader[start + 1] = size === 256 ? 0 : size;
    icoHeader.writeUInt16LE(1, start + 4);
    icoHeader.writeUInt16LE(32, start + 6);
    icoHeader.writeUInt32LE(images[size].length, start + 8);
    icoHeader.writeUInt32LE(offset, start + 12);
    offset += images[size].length;
  });
  return {
    png: images[1024],
    icns: Buffer.concat([header, ...chunks]),
    ico: Buffer.concat([icoHeader, ...ICO_SIZES.map((size) => images[size])]),
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const assets = containers(await renderIcons());
  await mkdir(path.join(root, 'assets'), { recursive: true });
  for (const [extension, bytes] of Object.entries(assets))
    await writeFile(path.join(root, `assets/appIcon.${extension}`), bytes);
  process.stdout.write('Generated original character PNG, ICNS and ICO assets.\n');
}
