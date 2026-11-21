// 사용량 속도 조절: Claude 요금제의 주간(7일)·5시간 사용 한도를 초기화 시각까지 나눠 쓰게 한다.
// 근거는 Claude CLI가 실행할 때마다 알려 주는 실제 사용률(rate_limit_event)뿐이다. 추정·계산한 토큰으로 판단하지 않는다.
// 사용률은 계정 전체 값이다(이 앱 밖에서 직접 쓴 Claude 사용량도 포함). 그래서 사람이 직접 쓸 몫을 남겨 둔다.

export interface UsageWindow { utilization: number; resetsAt: number }
export interface UsageSnapshot { sevenDay: UsageWindow | null; fiveHour: UsageWindow | null; at: number }
export interface PaceOptions {
  /** 주간 한도 중 앱이 쓰지 않고 남겨 둘 몫(0~0.5). 사람이 직접 쓰는 Claude 사용량과 여유분 */ reserve: number;
  /** 주 초반에 바로 일을 시작할 수 있게 미리 허용하는 몫 */ headStart: number;
  /** 5시간 창 사용률이 이 값 이상이면 그 창이 풀릴 때까지 새 사이클을 시작하지 않는다 */ fiveHourMax: number;
  /** 주간 사용률이 이 값 전이면 나눠 쓰지 않고 그대로 진행한다(기본 0.8). 이 값부터 초기화까지 시간 비율로 나눠 쓴다 */ startAt: number;
}
export type PaceDecision = { wait: false; note: string } | { wait: true; until: number; reason: string };

export const WEEK_MS = 7 * 24 * 3600 * 1000;
export const DEFAULT_PACE: PaceOptions = { reserve: 0.1, headStart: 0.05, fiveHourMax: 0.9, startAt: 0.8 };
const SLACK_MS = 60 * 1000; // 초기화 시각 직후 1분 여유를 두고 다시 시작

let latest: UsageSnapshot | null = null;
const listeners = new Set<(s: UsageSnapshot) => void>();

const toMs = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
};
const win = (v: unknown): UsageWindow | null => {
  const o = (v ?? {}) as Record<string, unknown>;
  const u = typeof o.utilization === 'number' ? o.utilization : NaN; const at = toMs(o.resetsAt);
  return Number.isFinite(u) && u >= 0 && at ? { utilization: Math.min(u, 1.5), resetsAt: at } : null;
};

/** CLI의 rate_limit_event(rate_limit_info)를 읽어 최신 사용률을 기억한다 */
export function noteRateLimit(info: Record<string, unknown>, now = Date.now()): UsageSnapshot | null {
  const uw = (info.unifiedWindows ?? {}) as Record<string, unknown>;
  let seven = win(uw.seven_day); let five = win(uw.five_hour);
  // 창별 값이 없으면 대표 값(rateLimitType)만 쓴다
  if (!seven && info.rateLimitType === 'seven_day') seven = win(info);
  if (!five && info.rateLimitType === 'five_hour') five = win(info);
  if (!seven && !five) return null;
  latest = { sevenDay: seven ?? latest?.sevenDay ?? null, fiveHour: five ?? latest?.fiveHour ?? null, at: now };
  for (const f of listeners) { try { f(latest); } catch { /* 무시 */ } }
  return latest;
}
export function usageSnapshot(): UsageSnapshot | null { return latest; }
/** 앱 재시작 때 저장해 둔 마지막 값을 되살린다(더 새 값이 이미 있으면 그대로) */
export function restoreUsage(s: UsageSnapshot | null | undefined): void {
  if (!s || typeof s.at !== 'number' || (latest && latest.at >= s.at)) return;
  latest = { sevenDay: s.sevenDay ?? null, fiveHour: s.fiveHour ?? null, at: s.at };
}
export function onUsage(f: (s: UsageSnapshot) => void): () => void { listeners.add(f); return () => listeners.delete(f); }
/** 시험용 */ export function resetUsageForTest(): void { latest = null; listeners.clear(); }

const pct = (x: number) => `${Math.round(x * 100)}%`;
const at = (ms: number) => new Date(ms).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });

/** 지금 새 사이클을 시작해도 되는지: 주간 사용률이 조절 시작값(기본 80%)을 넘으면 지난 시간 비율만큼만 쓰게 한다 */
export function paceDecision(s: UsageSnapshot | null, now: number, o: PaceOptions = DEFAULT_PACE): PaceDecision {
  if (!s) return { wait: false, note: '아직 사용률을 받지 못했습니다(첫 Claude 호출 뒤 표시)' };
  const f = s.fiveHour;
  if (f && f.resetsAt > now && f.utilization >= o.fiveHourMax) {
    return { wait: true, until: f.resetsAt + SLACK_MS, reason: `5시간 사용률 ${pct(f.utilization)} — ${at(f.resetsAt)} 초기화까지 쉽니다` };
  }
  const w = s.sevenDay;
  if (!w || w.resetsAt <= now) return { wait: false, note: w ? '새 주간 창이 시작됐습니다(다음 호출 때 사용률을 다시 받음)' : '주간 사용률 미보고' };
  const cap = 1 - Math.min(0.5, Math.max(0, o.reserve));
  const start = w.resetsAt - WEEK_MS;
  const frac = Math.min(1, Math.max(0, (now - start) / WEEK_MS));
  const allowed = Math.min(cap, cap * frac + o.headStart);
  // 조절 시작 사용률 전에는 나눠 쓰지 않는다(남길 몫이 더 크면 그 몫까지만)
  const free = Math.min(cap, Math.min(1, Math.max(0, o.startAt ?? 0)));
  if (w.utilization < free) return { wait: false, note: `주간 ${pct(w.utilization)} 사용 · ${pct(free)}부터 나눠 씀 · 초기화 ${at(w.resetsAt)} — 조절 전` };
  const tail = `주간 ${pct(w.utilization)} 사용 · 지금까지 쓸 몫 ${pct(allowed)} · 초기화 ${at(w.resetsAt)}`;
  if (w.utilization < allowed) return { wait: false, note: `${tail} — 정상 속도` };
  // 쓸 몫이 지금 사용률을 따라잡는 시각까지 기다린다(앱 몫을 다 썼으면 초기화까지)
  const until = w.utilization >= cap ? w.resetsAt + SLACK_MS : start + ((w.utilization - o.headStart) / cap) * WEEK_MS;
  if (until - now < SLACK_MS) return { wait: false, note: `${tail} — 곧 따라잡음` };
  return { wait: true, until, reason: w.utilization >= cap
    ? `주간 사용률 ${pct(w.utilization)} — 앱 몫(${pct(cap)})을 다 써서 ${at(w.resetsAt)} 초기화까지 쉽니다`
    : `주간 사용률 ${pct(w.utilization)}가 지금까지 쓸 몫 ${pct(allowed)}보다 앞서 ${at(until)}까지 쉽니다(초기화 ${at(w.resetsAt)})` };
}
