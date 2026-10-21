import {
  bookingUrl,
  exact,
  flag,
  object,
  text,
  validateRule,
  validateSettings,
  validateWebhook,
} from './validation.js';
import { PROVIDERS, type Provider } from './types.js';
export function validateSender(
  actual: unknown,
  expected: unknown,
  url: string,
  expectedUrl: string,
) {
  if (actual !== expected || url !== expectedUrl) throw new Error('허용되지 않은 앱 요청입니다.');
}
export function validateIpc(channel: string, payload: unknown) {
  switch (channel) {
    case 'getCatalog': {
      const v = object(payload);
      exact(v, ['provider', 'requestId', 'force']);
      if (!PROVIDERS.includes(v.provider as Provider)) throw new Error('영화관을 선택하세요.');
      const requestId = catalogRequestId(v.requestId);
      return {
        provider: v.provider as Provider,
        requestId,
        ...(v.force === undefined ? {} : { force: flag(v.force) }),
      };
    }
    case 'cancelPoster':
    case 'cancelCatalog': {
      const v = object(payload);
      exact(v, ['requestId']);
      return { requestId: catalogRequestId(v.requestId) };
    }
    case 'getPoster': {
      const v = object(payload);
      exact(v, ['provider', 'movieId', 'movieTitle', 'requestId']);
      if (!PROVIDERS.includes(v.provider as Provider)) throw new Error('영화관을 선택하세요.');
      const movieId = v.movieId === undefined ? undefined : text(v.movieId, 80);
      if (movieId && !/^[\dA-Za-z_-]+$/u.test(movieId)) throw new Error('작품 ID를 확인하세요.');
      return {
        provider: v.provider as Provider,
        movieTitle: text(v.movieTitle, 120),
        requestId: catalogRequestId(v.requestId),
        ...(movieId ? { movieId } : {}),
      };
    }
    case 'saveRule':
      return validateRule(payload);
    case 'deleteRule':
      return text(payload, 80);
    case 'setPaused':
      return flag(payload);
    case 'saveWebhook':
      return validateWebhook(payload);
    case 'updateSettings':
      return validateSettings(payload);
    case 'openBooking': {
      const v = object(payload);
      exact(v, ['provider', 'url']);
      if (!['cgv', 'megabox', 'lottecinema'].includes(String(v.provider)))
        throw new Error('영화관 주소를 확인하세요.');
      const url = bookingUrl(v.provider as Provider, v.url);
      if (!url) throw new Error('허용된 영화관 예매 주소가 아닙니다.');
      return { provider: v.provider as Provider, url };
    }
    case 'getUpdateState':
    case 'checkForUpdates':
    case 'downloadUpdate':
    case 'cancelUpdate':
    case 'openUpdateInstaller':
    case 'getSnapshot':
    case 'deleteWebhook':
    case 'refresh':
    case 'recoverStorage':
    case 'quit':
    case 'networkChanged':
      if (payload !== undefined) throw new Error('이 요청에는 입력이 필요하지 않습니다.');
      return undefined;
    default:
      throw new Error('지원하지 않는 앱 요청입니다.');
  }
}

function catalogRequestId(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(value))
    throw new Error('올바른 목록 요청 ID가 필요합니다.');
  return value;
}
