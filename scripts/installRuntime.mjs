import { spawn } from 'node:child_process';
import path from 'node:path';
const child = spawn(process.execPath, [path.resolve('node_modules/electron/install.js')], {
  env: {
    ...process.env,
    electron_config_cache: process.env.ELECTRON_CACHE || path.resolve('release/runtime-cache'),
  },
  stdio: 'inherit',
});
child.on('error', () => process.exit(1));
child.on('exit', (code) => process.exit(code ?? 1));
