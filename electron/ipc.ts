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
import type { Provider } from './types.js';
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
