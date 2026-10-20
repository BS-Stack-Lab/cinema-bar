import { createProviders } from '../dist-electron/providers/index.js';
import { koreanToday } from '../dist-electron/validation.js';
const providers = createProviders();
const date = koreanToday();
for (const provider of ['cgv', 'megabox', 'lottecinema']) {
  const rule = {
    id: 'probe',
    revision: 1,
    provider,
    theaterId: { cgv: '0056', megabox: '1372', lottecinema: '1016' }[provider],
    theaterName: '공개 조회 검증',
    movieTitle: '공개 조회 확인용 정확한 제목',
    date,
    format: 'ALL',
    isEnabled: true,
  };
  const startedAt = new Date().toISOString();
  try {
    const sessions = await providers[provider](rule, new AbortController().signal);
    process.stdout.write(
      `${JSON.stringify({ provider, startedAt, routeImplemented: true, result: 'validated-success', sessions: sessions.length, catalogWithoutMatchingTitleIsNotShowtimeProof: provider === 'lottecinema' })}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ provider, startedAt, routeImplemented: true, result: 'error', message: error.message })}\n`,
    );
  }
}
