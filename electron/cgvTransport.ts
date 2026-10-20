import { session } from 'electron';
import type { Fetcher } from './providers/index.js';
export function createCgvTransport(): Fetcher {
  const isolated = session.fromPartition('cinema-cgv-public', { cache: false });
  return (url, init = {}) =>
    isolated.fetch(url, { ...init, credentials: 'omit', redirect: 'error', cache: 'no-store' });
}
