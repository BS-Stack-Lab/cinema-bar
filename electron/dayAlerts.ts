import { isRuleEligible } from './eligibility.js';
import { compareSessions, sessionFormatLabel, sessionTimeLabel } from './sessionTiming.js';
import type { LocalOutboxItem, Rule, RuleInput, Session, State } from './types.js';
import { matches, normalizeTitle, sessionIdentity } from './validation.js';

export function isDayAlert(rule: RuleInput) {
  return rule.format === 'ALL' || rule.shouldNotifyEarliestOnly === true;
}
export function dayAlertKey(rule: RuleInput) {
  return JSON.stringify([
    'day-open',
    rule.provider,
    rule.theaterId,
    rule.date,
    rule.movieId ? ['id', rule.movieId] : ['title', normalizeTitle(rule.movieTitle)],
    rule.format,
  ]);
}
function notificationKind(rules: Rule[]): Session['notificationKind'] {
  return rules.some((rule) => rule.format === 'ALL' && !rule.shouldNotifyEarliestOnly)
    ? 'dayOpen'
    : 'earliest';
}
export function alertHeading(session: Session) {
  return session.notificationKind === 'dayOpen'
    ? '지정 날짜 예매가 열렸어요'
    : session.notificationKind === 'earliest'
      ? '가장 빠른 예매 가능 회차를 찾았어요'
      : '새 예매 가능 상영을 발견했어요.';
}
export function alertSummary(session: Session) {
  return `${session.theaterName} · ${session.date} ${session.notificationKind === 'dayOpen' ? '가장 빠른 회차 ' : ''}${sessionTimeLabel(session)} · ${sessionFormatLabel(session.format)}`;
}
export function alertHistory(session: Session, detail: string) {
  return session.notificationKind ? `${alertHeading(session)} · ${detail}`.slice(0, 240) : detail;
}
export function pinDayAlert(s: State, rule: Rule, movieId: string) {
  const oldKey = dayAlertKey(rule);
  rule.movieId = movieId;
  const key = dayAlertKey(rule);
  for (const dedupe of [s.localDedupe, s.dedupe]) {
    if (dedupe[oldKey] > 0 && !(dedupe[key] > 0)) dedupe[key] = dedupe[oldKey];
  }
}
export function pruneAlertDedupe(record: Record<string, number>, rules: Rule[], now: number) {
  // A saved future subscription protects completion even while its toggle or watch is off.
  const protectedKeys = new Set(
    rules.filter((rule) => isRuleEligible({ ...rule, isEnabled: true }, now)).map(dayAlertKey),
  );
  const entries = Object.entries(record);
  return Object.fromEntries([
    ...entries
      .filter(([key, at]) => !protectedKeys.has(key) && (at === 0 || now - at < 30 * 86400000))
      .slice(-5000),
    ...entries.filter(([key, at]) => protectedKeys.has(key) && at > 0),
    ...entries.filter(([key, at]) => protectedKeys.has(key) && at === 0),
  ]);
}
function liveRules(s: State, item: LocalOutboxItem, now: number) {
  return s.rules.filter(
    (rule) =>
      isRuleEligible(rule, now) &&
      item.ruleRefs.some((ref) => ref.id === rule.id && ref.revision === rule.revision) &&
      matches(rule, item.session, false),
  );
}
export function reconcileDayAlerts(s: State, now: number, raw: Session[] = []) {
  const rules = s.rules.filter((rule) => isDayAlert(rule) && isRuleEligible(rule, now));
  for (const destination of ['localOutbox', 'outbox'] as const) {
    const dedupe = destination === 'localOutbox' ? s.localDedupe : s.dedupe;
    const queue = s[destination];
    for (const rule of rules) {
      const key = dayAlertKey(rule);
      if (dedupe[key] > 0) continue;
      const progress = s.progress[rule.id];
      const evidence = [
        ...(progress?.revision === rule.revision ? Object.keys(progress.baseline ?? {}) : []),
        ...[...raw, ...queue.map((item) => item.session)]
          .filter((session) => matches(rule, session, false))
          .map(sessionIdentity),
        ...queue.filter((item) => matches(rule, item.session, false)).map((item) => item.id),
      ]
        .map((id) => dedupe[id])
        .filter((at) => at > 0);
      if (evidence.length) dedupe[key] = Math.min(...evidence);
    }
    const normalized = new Map<string, LocalOutboxItem>();
    const add = (item: LocalOutboxItem) => {
      if (dedupe[item.id] > 0) return;
      const previous = normalized.get(item.id);
      if (!previous) {
        normalized.set(item.id, item);
        return;
      }
      const candidates = [previous, item].sort(
        (a, b) =>
          Number(b.attempts > 0) - Number(a.attempts > 0) || compareSessions(a.session, b.session),
      );
      const representative = candidates[0];
      const ruleRefs = [
        ...new Map([...previous.ruleRefs, ...item.ruleRefs].map((ref) => [ref.id, ref])).values(),
      ];
      const mergedRules = s.rules.filter((rule) => ruleRefs.some((ref) => rule.id === ref.id));
      normalized.set(item.id, {
        ...representative,
        ruleRefs,
        session: {
          ...representative.session,
          ...(representative.session.notificationKind &&
          !(s.localDedupe[item.id] > 0) &&
          !candidates.some((candidate) => candidate.attempts > 0)
            ? { notificationKind: notificationKind(mergedRules) }
            : {}),
        },
        attempts: Math.max(previous.attempts, item.attempts),
        nextAt: Math.max(previous.nextAt, item.nextAt),
        createdAt: Math.min(previous.createdAt, item.createdAt),
      });
    };
    for (const item of queue) {
      if (destination === 'localOutbox' && !s.settings.shouldNotifyLocally) continue;
      if (
        destination === 'outbox' &&
        'secretRevision' in item &&
        item.secretRevision !== s.secret.revision
      )
        continue;
      const matching = liveRules(s, item, now);
      const individual = matching.filter((rule) => !isDayAlert(rule));
      if (individual.length) {
        const { notificationKind: _kind, ...session } = item.session;
        void _kind;
        add({
          ...item,
          id: item.session.notificationKind ? sessionIdentity(session) : item.id,
          session,
          ruleRefs: individual.map(({ id, revision }) => ({ id, revision })),
        });
      }
      const groups = new Map<string, Rule[]>();
      for (const rule of matching.filter(isDayAlert)) {
        const key = dayAlertKey(rule);
        groups.set(key, [...(groups.get(key) ?? []), rule]);
      }
      for (const [id, grouped] of groups)
        add({
          ...item,
          id,
          session: {
            ...item.session,
            notificationKind:
              item.session.notificationKind && (item.attempts > 0 || s.localDedupe[id] > 0)
                ? item.session.notificationKind
                : notificationKind(grouped),
          },
          ruleRefs: grouped.map(({ id, revision }) => ({ id, revision })),
        });
    }
    for (const item of queue)
      if (dedupe[item.id] === 0 && !normalized.has(item.id)) delete dedupe[item.id];
    for (const id of normalized.keys()) dedupe[id] = 0;
    if (destination === 'localOutbox') s.localOutbox = [...normalized.values()];
    else
      s.outbox = [...normalized.values()].map((item) => ({
        ...item,
        secretRevision: s.secret.revision,
      }));
  }
}
export function enqueueDayAlert(s: State, rule: Rule, session: Session, now: number) {
  const id = dayAlertKey(rule);
  const grouped = s.rules.filter(
    (candidate) =>
      isDayAlert(candidate) && isRuleEligible(candidate, now) && dayAlertKey(candidate) === id,
  );
  const frozen =
    s.localDedupe[id] > 0 || s.outbox.some((item) => item.id === id && item.attempts > 0);
  for (const destination of ['localOutbox', 'outbox'] as const) {
    if (destination === 'localOutbox' ? !s.settings.shouldNotifyLocally : !s.secret.encrypted)
      continue;
    const dedupe = destination === 'localOutbox' ? s.localDedupe : s.dedupe;
    if (dedupe[id] > 0) continue;
    const existing = s[destination].find((item) => item.id === id);
    const ruleRefs = grouped.map(({ id, revision }) => ({ id, revision }));
    const copy = { ...session, notificationKind: notificationKind(grouped) };
    if (existing) {
      existing.ruleRefs = ruleRefs;
      if (!frozen) existing.session = copy;
    } else {
      const common = { id, session: copy, ruleRefs, createdAt: now, nextAt: now, attempts: 0 };
      dedupe[id] = 0;
      if (destination === 'localOutbox') s.localOutbox.push(common);
      else s.outbox.push({ ...common, secretRevision: s.secret.revision });
    }
  }
}
