// 진척(프로젝트 완성도): 프로젝트 전체를 큰 단계(3~8개)로 나누고, 단계마다 기능 목록(근거 문서 ID 포함)을 둔다.
// 미션이 바뀌어도 프로젝트에 하나로 이어진다. 진척 관리 직원이 사이클마다 갱신안을 내고, 앱이 아래 규칙으로만 반영한다.
// - 완료는 확인 근거가 있어야 한다(없으면 '검증 중'). 진척 비율은 완료한 기능 수로만 센다(시간 추정 없음).
// - 기능을 빼려면 이유가 있어야 한다. 갱신안에서 빠졌다고 지우지 않는다(그대로 둔다). 완료 기준이 바뀌면 예전 근거로 완료를 유지하지 않는다.
// - 처음 만든 목록과 이후의 단계·기능 추가·제외·기준 변경은 기록하고, 사용자가 진척 메뉴에서 확인할 때까지 '미확인'으로 보인다.
import type { MissionWorkPlan, WorkChange, WorkItem, WorkPhase, WorkStatus } from '../shared/types';

export const WORK_STATUSES: WorkStatus[] = ['todo', 'doing', 'verifying', 'done', 'blocked'];
export const WORK_STATUS_LABEL: Record<WorkStatus, string> = { todo: '시작 전', doing: '진행', verifying: '검증 중', done: '완료', blocked: '막힘' };
const MAX_ITEMS = 120;
const MAX_PHASES = 10;
const MIN_EVIDENCE = 4;

export const WORKPLAN_SCHEMA = {
  type: 'object', required: ['phases', 'items', 'summary'],
  properties: {
    summary: { type: 'string' },
    changeReason: { type: 'string' },
    phases: { type: 'array', items: { type: 'object', required: ['title', 'goal'], properties: { id: { type: 'string' }, title: { type: 'string' }, goal: { type: 'string' } } } },
    items: { type: 'array', items: { type: 'object', required: ['phase', 'title', 'criteria', 'status'], properties: {
      id: { type: 'string' }, phase: { type: 'string' }, title: { type: 'string' }, criteria: { type: 'string' }, status: { type: 'string', enum: WORK_STATUSES },
      refs: { type: 'array', items: { type: 'string' } }, evidence: { type: 'string' }, note: { type: 'string' } } } },
    removed: { type: 'array', items: { type: 'object', required: ['id', 'reason'], properties: { id: { type: 'string' }, reason: { type: 'string' } } } },
  },
};
type RawItem = { id?: string; phase?: string; title?: string; criteria?: string; status?: string; refs?: unknown; evidence?: string; note?: string };
export interface RawWorkPlan { summary?: string; changeReason?: string; phases?: { id?: string; title?: string; goal?: string }[]; items?: RawItem[]; removed?: { id?: string; reason?: string }[] }

const clip = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const status = (v: unknown): WorkStatus => (WORK_STATUSES as string[]).includes(String(v)) ? v as WorkStatus : 'todo';
const nextNum = (ids: string[], p: string) => ids.reduce((n, x) => Math.max(n, Number(new RegExp(`^${p}(\\d+)$`).exec(x)?.[1] ?? 0)), 0) + 1;
const refsOf = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => clip(x, 40)).filter((x) => /^[A-Za-z]{1,8}-?[A-Za-z0-9._-]{1,20}$/.test(x)).slice(0, 8);

export interface MergeResult { plan: MissionWorkPlan | null; notes: string[]; changed: WorkChange[] }

/** 진척 관리 직원의 갱신안을 지금 진척 목록에 반영한다 */
export function mergeWorkPlan(prev: MissionWorkPlan | null | undefined, raw: RawWorkPlan | null | undefined, cycle: number, at: string): MergeResult {
  const notes: string[] = []; const changed: WorkChange[] = [];
  const rawItems = (Array.isArray(raw?.items) ? raw!.items : []).filter((x) => x && clip(x.title, 200));
  const rawPhases = (Array.isArray(raw?.phases) ? raw!.phases : []).filter((x) => x && clip(x.title, 120));
  const reason = clip(raw?.changeReason, 400);
  const settle = (s: WorkStatus, evidence: string, title: string): WorkStatus => {
    if (s === 'done' && evidence.length < MIN_EVIDENCE) { notes.push(`${title}: 확인 근거 없이 완료로 올려 '검증 중'으로 둠`); return 'verifying'; }
    return s;
  };
  const fresh = !prev || (!prev.items.length && !prev.removed.length);
  const phases: WorkPhase[] = fresh ? [] : (prev!.phases ?? []).map((p) => ({ ...p }));
  // 단계: id·이름으로 맞추고, 새 단계는 P번호를 붙인다(단계는 빼지 않는다 — 기능을 옮기거나 빼는 것으로 정리)
  const phaseMap = new Map<string, string>(); // 갱신안의 id·이름 → 실제 단계 id
  const existing = new Set(phases.map((p) => p.id)); // 갱신안의 id는 원래 있던 단계에만 맞춘다(이번에 새로 붙인 id와 섞지 않음)
  for (const x of rawPhases) {
    const title = clip(x.title, 120); const goal = clip(x.goal, 400); const rid = clip(x.id, 10).toUpperCase();
    let cur = (rid && existing.has(rid) ? phases.find((p) => p.id === rid) : undefined) ?? phases.find((p) => p.title === title);
    if (!cur) {
      if (phases.length >= MAX_PHASES) { notes.push(`단계가 ${MAX_PHASES}개를 넘어 '${title}'을(를) 더하지 않음`); continue; }
      cur = { id: `P${nextNum(phases.map((p) => p.id), 'P')}`, title, goal };
      phases.push(cur);
      if (!fresh) changed.push({ cycle, at, kind: 'add', id: cur.id, title: `단계: ${title}`, reason: reason || '새 단계' });
    } else if (title !== cur.title || (goal && goal !== cur.goal)) {
      if (!fresh) changed.push({ cycle, at, kind: 'edit', id: cur.id, title: `단계: ${title}`, reason: reason || '단계 이름·목표 조정' });
      cur.title = title; if (goal) cur.goal = goal;
    }
    if (rid) phaseMap.set(rid, cur.id);
    phaseMap.set(title, cur.id);
  }
  const phaseOf = (v: unknown, fallback = ''): string => {
    const s = clip(v, 120); const id = phaseMap.get(s.toUpperCase()) ?? phaseMap.get(s) ?? phases.find((p) => (existing.has(s.toUpperCase()) && p.id === s.toUpperCase()) || p.title === s)?.id;
    if (id) return id;
    if (fallback) return fallback;
    let other = phases.find((p) => p.title === '기타');
    if (!other) { other = { id: `P${nextNum(phases.map((p) => p.id), 'P')}`, title: '기타', goal: '단계가 정해지지 않은 기능' }; phases.push(other); }
    return other.id;
  };
  if (fresh) {
    if (!rawItems.length) return { plan: prev ?? null, notes, changed };
    const items: WorkItem[] = [];
    for (const x of rawItems.slice(0, MAX_ITEMS)) {
      const title = clip(x.title, 200); const evidence = clip(x.evidence, 600);
      items.push({ id: `W${nextNum(items.map((i) => i.id), 'W')}`, phase: phaseOf(x.phase), refs: refsOf(x.refs), title, criteria: clip(x.criteria, 600), status: settle(status(x.status), evidence, title), evidence, note: clip(x.note, 400), addedCycle: cycle, updatedCycle: cycle });
    }
    if (rawItems.length > MAX_ITEMS) notes.push(`기능이 ${MAX_ITEMS}개를 넘어 앞의 ${MAX_ITEMS}개만 넣음`);
    const c: WorkChange = { cycle, at, kind: 'create', id: '', title: `진척 목록: 단계 ${phases.length}개 · 기능 ${items.length}개`, reason: reason || '프로젝트 전체 완성도 관리용 첫 목록' };
    return { plan: { phases, items, removed: [], changes: [c], createdCycle: cycle, reviewedChanges: 0, reviewedAt: null }, notes, changed: [c] };
  }
  const items = prev!.items.map((x) => ({ ...x })); const removed = [...prev!.removed];
  for (const x of rawItems) {
    const title = clip(x.title, 200); const criteria = clip(x.criteria, 600); const evidence = clip(x.evidence, 600); const note = clip(x.note, 400);
    const id = clip(x.id, 10).toUpperCase();
    const cur = items.find((i) => i.id === id) ?? items.find((i) => i.title === title);
    if (cur) {
      const criteriaChanged = !!criteria && criteria !== cur.criteria;
      const phase = x.phase ? phaseOf(x.phase, cur.phase ?? '') : cur.phase;
      // 완료 기준이 바뀌면 예전 근거로는 완료로 보지 않는다(새 기준의 근거가 있어야 함)
      const st = settle(status(x.status), criteriaChanged ? evidence : evidence || cur.evidence, cur.title);
      if (criteriaChanged && !evidence) cur.evidence = ''; // 기준이 바뀌면 상태와 관계없이 예전 근거를 지운다
      if (criteriaChanged || title !== cur.title || phase !== cur.phase) {
        changed.push({ cycle, at, kind: 'edit', id: cur.id, title, reason: reason || (phase !== cur.phase ? '단계 이동' : '완료 기준·이름 조정') });
        cur.title = title; if (criteria) cur.criteria = criteria; cur.phase = phase;
      }
      const refs = refsOf(x.refs); if (refs.length) cur.refs = refs;
      if (st !== cur.status || evidence && evidence !== cur.evidence || note !== cur.note) cur.updatedCycle = cycle;
      cur.status = st; if (evidence) cur.evidence = evidence; cur.note = note;
      continue;
    }
    if (removed.some((r) => r.title === title)) continue; // 뺀 기능을 이름만 바꿔 되살리지 않는다(되살리려면 사용자 지시)
    if (items.length >= MAX_ITEMS) { notes.push(`기능이 ${MAX_ITEMS}개를 넘어 '${title}'을(를) 더하지 않음`); continue; }
    const nid = `W${nextNum([...items, ...removed].map((i) => i.id), 'W')}`;
    items.push({ id: nid, phase: phaseOf(x.phase), refs: refsOf(x.refs), title, criteria, status: settle(status(x.status), evidence, title), evidence, note, addedCycle: cycle, updatedCycle: cycle });
    changed.push({ cycle, at, kind: 'add', id: nid, title, reason: reason || '새 기능' });
  }
  for (const r of Array.isArray(raw?.removed) ? raw!.removed : []) {
    const id = clip(r?.id, 10).toUpperCase(); const why = clip(r?.reason, 400);
    const at0 = items.findIndex((i) => i.id === id); if (at0 < 0) continue;
    if (!why) { notes.push(`${id}: 이유 없이 빼려 해 그대로 둠`); continue; }
    if (items[at0].status === 'done') { notes.push(`${id}: 완료한 기능은 빼지 않음`); continue; }
    const [gone] = items.splice(at0, 1); removed.push({ ...gone, updatedCycle: cycle });
    changed.push({ cycle, at, kind: 'remove', id, title: gone.title, reason: why });
  }
  const all = [...prev!.changes, ...changed]; const drop = Math.max(0, all.length - 80);
  return { plan: { ...prev!, phases, items, removed: removed.slice(-60), changes: all.slice(drop), reviewedChanges: Math.max(0, (prev!.reviewedChanges ?? 0) - drop) }, notes, changed };
}

export interface WorkProgress { total: number; done: number; doing: number; verifying: number; blocked: number; todo: number; pct: number }
export function countItems(items: WorkItem[]): WorkProgress {
  const n = (s: WorkStatus) => items.filter((i) => i.status === s).length; const done = n('done');
  return { total: items.length, done, doing: n('doing'), verifying: n('verifying'), blocked: n('blocked'), todo: n('todo'), pct: items.length ? Math.round((done / items.length) * 100) : 0 };
}
export function workProgress(p: MissionWorkPlan | null | undefined): WorkProgress { return countItems(p?.items ?? []); }
export const allDone = (p: MissionWorkPlan | null | undefined) => !!p && p.items.length > 0 && p.items.every((i) => i.status === 'done');
export const unreviewed = (p: MissionWorkPlan | null | undefined) => (p ? Math.max(0, p.changes.length - (p.reviewedChanges ?? 0)) : 0);
export function progressLine(p: MissionWorkPlan | null | undefined): string {
  const g = workProgress(p);
  if (!g.total) return '진척 목록 없음';
  const ph = (p?.phases ?? []).length;
  return `${ph ? `단계 ${ph}개 · ` : ''}기능 ${g.total}개 중 ${g.done}개 완료(${g.pct}%)${g.doing ? ` · 진행 ${g.doing}` : ''}${g.verifying ? ` · 검증 중 ${g.verifying}` : ''}${g.blocked ? ` · 막힘 ${g.blocked}` : ''}`;
}
/** 단계별 진척 한 줄씩 */
export function phaseLines(p: MissionWorkPlan | null | undefined): string[] {
  return (p?.phases ?? []).map((ph) => { const g = countItems((p?.items ?? []).filter((i) => i.phase === ph.id)); return `${ph.id} ${ph.title}: ${g.done}/${g.total} 완료(${g.pct}%)${g.blocked ? ` · 막힘 ${g.blocked}` : ''}`; });
}

/** 사람이 직접 봐야만 알 수 있는 것만 남은 기능: 진척 관리 직원이 메모를 이 말로 시작한다(진척 메뉴에 한 번에 모아 보여 준다) */
export const USER_CHECK = '사용자 확인:';
export const needsUser = (i: Pick<WorkItem, 'note'>) => (i.note ?? '').trimStart().startsWith(USER_CHECK);
/** '검증 중'이 이만큼 쌓이면 새 기능을 시작하지 않고 닫는 일만 한다 */
export const CLOSE_FIRST = 5;

/** 오퍼레이터 계획·판단 프롬프트에 넣는 진척: 단계별 비율과, 완료되지 않은 기능(최대 30개). 닫을 수 있는 기능(막힘·검증 중, 오래 머문 것)부터 보여 준다. */
export function workPlanSection(p: MissionWorkPlan | null | undefined, cycle?: number): string[] {
  if (!p?.items.length) return ['## 프로젝트 진척(진척 관리)', '- 아직 없음(진척 관리 직원이 이번 판단 뒤에 만든다).', ''];
  const open = p.items.filter((i) => i.status !== 'done');
  const waiting = open.filter(needsUser); const work = open.filter((i) => !needsUser(i));
  const order: WorkStatus[] = ['blocked', 'verifying', 'doing', 'todo'];
  work.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.updatedCycle - b.updatedCycle);
  const toClose = work.filter((i) => i.status === 'verifying' || i.status === 'blocked').length;
  const age = (i: WorkItem) => (cycle && cycle > i.updatedCycle ? ` · ${cycle - i.updatedCycle}사이클째 그대로` : '');
  const line = (i: WorkItem) => `- ${i.id} [${WORK_STATUS_LABEL[i.status]}${age(i)}] ${i.phase ?? ''} ${i.title}${i.refs?.length ? ` (${i.refs.join(', ')})` : ''} — 완료 기준: ${i.criteria || '(없음)'}${i.note ? ` · 메모: ${i.note}` : ''}`;
  return ['## 프로젝트 진척(전체 완성도 — 진척 관리 직원이 갱신)', `- ${progressLine(p)}`, ...phaseLines(p).map((l) => `- ${l}`),
    '### 남은 기능(닫을 것 먼저: 막힘·검증 중은 오래 머문 순, 최대 30개)',
    ...work.slice(0, 30).map(line),
    ...(work.length > 30 ? [`- … 그 밖에 ${work.length - 30}개`] : []),
    ...(waiting.length ? [`### 사용자 확인을 기다리는 기능 ${waiting.length}개(작업으로 다시 넣지 않는다)`, ...waiting.slice(0, 10).map((i) => `- ${i.id} ${i.title} — ${i.note}`)] : []),
    '### 닫기 우선 규칙',
    toClose >= CLOSE_FIRST
      ? `- 닫지 못한 기능(검증 중·막힘)이 ${toClose}개다. 이번 사이클의 작업은 모두 이 기능들을 '완료'로 닫는 일로 짠다. '시작 전' 기능은 시작하지 않는다(사용자 추가 지시가 직접 요구한 것만 예외).`
      : `- 닫지 못한 기능(검증 중·막힘) ${toClose}개를 닫는 작업을 먼저 넣고, 남는 자리에 지금 단계의 다음 기능을 넣는다.`,
    '- 닫는 작업 하나는 기능 하나(또는 같은 화면·같은 시험으로 함께 닫히는 기능 묶음)를 맡아, 그 기능의 완료 기준과 메모에 남은 것을 이번에 끝내고 완료 기준을 직접 확인한 근거(시험 명령과 결과 수, 화면 기록 파일)를 보고에 남기게 한다. 오래 머문 기능부터 고른다.',
    '- 코드를 더 고칠 것이 없고 확인만 남은 기능은 확인만 하는 작업으로 여러 개를 한 작업에 묶는다(기능마다 근거를 따로 적게 한다).',
    '- 판정 스크립트·검증 도구 자체를 고치는 작업은 기능을 닫는 데 바로 필요할 때만, 한 사이클에 하나까지 넣는다.',
    '- 화면은 숨은 창(headless) 브라우저 측정과 화면 사진도 확인 근거로 인정한다. "사용자 브라우저 확인 필요"를 이유로 같은 기능을 다시 작업하지 않는다.',
    '- 리뷰의 경미한 지적(P2·표현·완성도)은 기능을 닫는 것을 막지 않는다. 그것만 고치는 작업을 따로 만들지 않는다. 진척 목록은 진척 관리 직원이 갱신한다.', ''];
}
