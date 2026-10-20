import { validateWebhook } from './validation.js';
export interface SecretCodec {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}
export class SecretStore {
  constructor(private codec: SecretCodec) {}
  isAvailable() {
    return this.codec.isAvailable();
  }
  encode(value: unknown) {
    const url = validateWebhook(value);
    if (!this.isAvailable())
      throw new Error('OS 암호화 저장소를 사용할 수 없습니다. 로그인 키체인을 확인하세요.');
    return this.codec.encrypt(url).toString('base64');
  }
  decode(encrypted?: string) {
    if (!encrypted || !this.isAvailable()) throw new Error('OS 암호화 저장소에 연결해야 합니다.');
    try {
      return validateWebhook(this.codec.decrypt(Buffer.from(encrypted, 'base64')));
    } catch {
      throw new Error('암호화 연결 정보를 읽을 수 없습니다. 웹훅을 다시 연결하세요.');
    }
  }
}
