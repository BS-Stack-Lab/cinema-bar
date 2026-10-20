import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { containers, renderIcons, ICNS_SIZES, ICO_SIZES } from './generateIcons.mjs';
const output = process.env.CINEMA_SMOKE_OUTPUT || path.resolve('release/icon-check');
await mkdir(output, { recursive: true });
const originalSvgSha256 = createHash('sha256')
  .update(await readFile('public/projector.svg'))
  .digest('hex');
assert.equal(
  originalSvgSha256,
  'c5f9f29f3578156919dcafa7d426ad09dcd71511125d661ff5cf78f579933503',
  'Original projector SVG must remain unchanged',
);
const images = await renderIcons();
const generated = containers(images);
const dimensions = (data, size) => {
  assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(data.readUInt32BE(16), size);
  assert.equal(data.readUInt32BE(20), size);
};
for (const [size, image] of Object.entries(images)) dimensions(image, Number(size));
for (const [ext, bytes] of Object.entries(generated))
  assert.deepEqual(await readFile(`assets/appIcon.${ext}`), bytes, `${ext} reproducibility`);
function extractIcns(data) {
  assert.equal(data.toString('ascii', 0, 4), 'icns');
  assert.equal(data.readUInt32BE(4), data.length);
  const found = {};
  let offset = 8;
  while (offset < data.length) {
    const type = data.toString('ascii', offset, offset + 4);
    const length = data.readUInt32BE(offset + 4);
    assert.ok(length > 8 && offset + length <= data.length);
    const png = data.subarray(offset + 8, offset + length);
    dimensions(png, ICNS_SIZES[type]);
    found[type] = png;
    offset += length;
  }
  assert.deepEqual(Object.keys(found), Object.keys(ICNS_SIZES));
  return found;
}
const icns = extractIcns(generated.icns);
const ico = generated.ico;
assert.equal(ico.readUInt16LE(0), 0);
assert.equal(ico.readUInt16LE(2), 1);
assert.equal(ico.readUInt16LE(4), ICO_SIZES.length);
ICO_SIZES.forEach((size, index) => {
  const start = 6 + index * 16;
  const offset = ico.readUInt32LE(start + 12);
  const length = ico.readUInt32LE(start + 8);
  assert.equal(ico[start], size === 256 ? 0 : size);
  const image = ico.subarray(offset, offset + length);
  dimensions(image, size);
  assert.deepEqual(image, images[size]);
});
let bundle;
if (process.platform === 'darwin') {
  const contents = path.resolve(
    `release/Cinema Bar-darwin-${process.arch}/Cinema Bar.app/Contents`,
  );
  const filename = execFileSync(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print :CFBundleIconFile', path.join(contents, 'Info.plist')],
    { encoding: 'utf8' },
  ).trim();
  assert.ok(filename && path.basename(filename) === filename);
  const resource = path.join(
    contents,
    'Resources',
    filename.endsWith('.icns') ? filename : `${filename}.icns`,
  );
  const extracted = extractIcns(await readFile(resource));
  assert.deepEqual(extracted.ic10, generated.png);
  await writeFile(path.join(output, 'bundle-icon-master.png'), extracted.ic10);
  bundle = { resource, masterMatches: true };
}
for (const [name, bytes] of Object.entries({
  'icon-master.png': generated.png,
  'icon-16.png': icns.icp4,
  'icon-32.png': icns.icp5,
  'icon-128.png': icns.ic07,
}))
  await writeFile(path.join(output, name), bytes);
const evidence = {
  passed: true,
  at: new Date().toISOString(),
  originalSvgSha256,
  deterministic: true,
  sizes: Object.keys(images).map(Number),
  bundle,
  otherOsRuntimeTested: false,
  networkRequests: 0,
  personalProfilesUsed: false,
};
await writeFile(path.join(output, 'icons-check.json'), JSON.stringify(evidence, null, 2));
process.stdout.write(`Icon assets and package verified: ${output}\n`);
