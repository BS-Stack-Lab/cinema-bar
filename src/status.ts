import type { Snapshot, Rule } from '../electron/types';
export function status(snapshot: Snapshot, rule?: Rule) {
  if (snapshot.recoveryError) return '복구 필요';
  if (snapshot.settings.isPaused || (rule && !rule.isEnabled)) return '일시 정지';
  if (snapshot.isSuspended) return '절전 대기';
  if (!snapshot.isOnline) return '네트워크 대기';
  if (snapshot.isChecking) return '확인 중';
  if (rule && snapshot.progress[rule.id]?.error) return '공급자 오류';
  if (snapshot.isWebhookBlocked) return '웹훅 오류';
  if (!snapshot.hasWebhook) return '웹훅 연결 필요';
  if (!rule && snapshot.rules.some((r) => snapshot.progress[r.id]?.error)) return '공급자 오류';
  if (rule && !snapshot.progress[rule.id]?.lastSuccess) return '대기';
  return snapshot.rules.length ? '감시 중' : '시작 준비';
}
