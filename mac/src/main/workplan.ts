// 작업 목록(진척 관리): 미션을 단원(기능 묶음)으로 나누고, 단원마다 완료 기준·상태·확인 근거를 둔다.
// 진척 관리 직원이 사이클마다 갱신안을 내고, 앱이 아래 규칙으로만 반영한다.
// - 완료는 확인 근거가 있어야 한다(없으면 '검증 중'으로 둔다). 진척 비율은 완료한 단원 수로만 센다(시간 추정 없음).
// - 단원을 빼려면 이유가 있어야 한다. 갱신안에서 빠졌다고 지우지 않는다(그대로 둔다).
// - 처음 만든 계획과 이후의 추가·제외·완료 기준 변경은 기록하고, 사용자가 진척 메뉴에서 확인할 때까지 '미확인'으로 보인다.
import type { MissionWorkPlan, WorkChange, WorkItem, WorkStatus } from '../shared/types';

export const WORK_STATUSES: WorkStatus[] = ['todo', 'doing', 'verifying', 'done', 'blocked'];
export const WORK_STATUS_LABEL: Record<WorkStatus, string> = { todo: '시작 전', doing: '진행', verifying: '검증 중', done: '완료', blocked: '막힘' };
const MAX_ITEMS = 30;
const MIN_EVIDENCE = 4;

export const WORKPLAN_SCHEMA = {
  type: 'object', required: ['items', 'summary'],
  properties: {
    summary: { type: 'string' },
    changeReason: { type: 'string' },
    items: { type: 'array', items: { type: 'object', required: ['title', 'criteria', 'status'], properties: {
      id: { type: 'string' }, title: { type: 'string' }, criteria: { type: 'string' }, status: { type: 'string', enum: WORK_STATUSES },
      evidence: { type: 'string' }, note: { type: 'string' } } } },
    removed: { type: 'array', items: { type: 'object', required: ['id', 'reason'], properties: { id: { type: 'string' }, reason: { type: 'string' } } } },
  },
};
export interface RawWorkPlan { summary?: string; changeReason?: string; items?: { id?: string; title?: string; criteria?: string; status?: string; evidence?: string; note?: string }[]; removed?: { id?: string; reason?: string }[] }

const clip = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const status = (v: unknown): WorkStatus => (WORK_STATUSES as string[]).includes(String(v)) ? v as WorkStatus : 'todo';
const nextId = (items: WorkItem[]) => `W${items.reduce((n, x) => Math.max(n, Number(/^W(\d+)$/.exec(x.id)?.[1] ?? 0)), 0) + 1}`;

export interface MergeResult { plan: MissionWorkPlan | null; notes: string[]; changed: WorkChange[] }

/** 진척 관리 직원의 갱신안을 지금 작업 목록에 반영한다 */
export function mergeWorkPlan(prev: MissionWorkPlan | null | undefined, raw: RawWorkPlan | null | undefined, cycle: number, at: string): MergeResult {
  const notes: string[] = []; const changed: WorkChange[] = [];
  const rawItems = (Array.isArray(raw?.items) ? raw!.items : []).filter((x) => x && clip(x.title, 200));
  const reason = clip(raw?.changeReason, 400);
  const settle = (s: WorkStatus, evidence: string, title: string): WorkStatus => {
    if (s === 'done' && evidence.length < MIN_EVIDENCE) { notes.push(`${title}: 확인 근거 없이 완료로 올려 '검증 중'으로 둠`); return 'verifying'; }
    return s;
  };
  if (!prev || !prev.items.length && !prev.removed.length) {
    if (!rawItems.length) return { plan: prev ?? null, notes, changed };
    const items: WorkItem[] = [];
    for (const x of rawItems.slice(0, MAX_ITEMS)) {
      const title = clip(x.title, 200); const evidence = clip(x.evidence, 600);
      items.push({ id: nextId(items), title, criteria: clip(x.criteria, 600), status: settle(status(x.status), evidence, title), evidence, note: clip(x.note, 400), addedCycle: cycle, updatedCycle: cycle });
    }
    const c: WorkChange = { cycle, at, kind: 'create', id: '', title: `작업 목록 ${items.length}개 단원`, reason: reason || '미션 진행 관리용 첫 계획' };
    return { plan: { items, removed: [], changes: [c], createdCycle: cycle, reviewedChanges: 0, reviewedAt: null }, notes, changed: [c] };
  }
  const items = prev.items.map((x) => ({ ...x })); const removed = [...prev.removed];
  for (const x of rawItems) {
    const title = clip(x.title, 200); const criteria = clip(x.criteria, 600); const evidence = clip(x.evidence, 600); const note = clip(x.note, 400);
    const id = clip(x.id, 10).toUpperCase();
    const cur = items.find((i) => i.id === id) ?? items.find((i) => i.title === title);
    if (cur) {
      const st = settle(status(x.status), evidence || cur.evidence, cur.title);
      if (criteria && criteria !== cur.criteria || title !== cur.title) {
        const c: WorkChange = { cycle, at, kind: 'edit', id: cur.id, title, reason: reason || '완료 기준·이름 조정' };
        changed.push(c); cur.title = title; if (criteria) cur.criteria = criteria;
      }
      if (st !== cur.status || evidence && evidence !== cur.evidence || note !== cur.note) cur.updatedCycle = cycle;
      cur.status = st; if (evidence) cur.evidence = evidence; cur.note = note;
      continue;
    }
    if (removed.some((r) => r.title === title)) continue; // 뺀 단원을 이름만 바꿔 되살리지 않는다(되살리려면 사용자 지시)
    if (items.length >= MAX_ITEMS) { notes.push(`단원이 ${MAX_ITEMS}개를 넘어 '${title}'을(를) 더하지 않음`); continue; }
    const nid = nextId([...items, ...removed]);
    items.push({ id: nid, title, criteria, status: settle(status(x.status), evidence, title), evidence, note, addedCycle: cycle, updatedCycle: cycle });
    changed.push({ cycle, at, kind: 'add', id: nid, title, reason: reason || '새 단원' });
  }
  for (const r of Array.isArray(raw?.removed) ? raw!.removed : []) {
    const id = clip(r?.id, 10).toUpperCase(); const why = clip(r?.reason, 400);
    const at0 = items.findIndex((i) => i.id === id); if (at0 < 0) continue;
    if (!why) { notes.push(`${id}: 이유 없이 빼려 해 그대로 둠`); continue; }
    if (items[at0].status === 'done') { notes.push(`${id}: 완료한 단원은 빼지 않음`); continue; }
    const [gone] = items.splice(at0, 1); removed.push({ ...gone, updatedCycle: cycle });
    changed.push({ cycle, at, kind: 'remove', id, title: gone.title, reason: why });
  }
  return { plan: { ...prev, items, removed: removed.slice(-30), changes: [...prev.changes, ...changed].slice(-80) }, notes, changed };
}

export interface WorkProgress { total: number; done: number; doing: number; verifying: number; blocked: number; todo: number; pct: number }
export function workProgress(p: MissionWorkPlan | null | undefined): WorkProgress {
  const items = p?.items ?? []; const n = (s: WorkStatus) => items.filter((i) => i.status === s).length;
  const done = n('done');
  return { total: items.length, done, doing: n('doing'), verifying: n('verifying'), blocked: n('blocked'), todo: n('todo'), pct: items.length ? Math.round((done / items.length) * 100) : 0 };
}
export const allDone = (p: MissionWorkPlan | null | undefined) => !!p && p.items.length > 0 && p.items.every((i) => i.status === 'done');
export const unreviewed = (p: MissionWorkPlan | null | undefined) => (p ? Math.max(0, p.changes.length - (p.reviewedChanges ?? 0)) : 0);
export function progressLine(p: MissionWorkPlan | null | undefined): string {
  const g = workProgress(p);
  if (!g.total) return '작업 목록 없음';
  return `단원 ${g.total}개 중 ${g.done}개 완료(${g.pct}%)${g.doing ? ` · 진행 ${g.doing}` : ''}${g.verifying ? ` · 검증 중 ${g.verifying}` : ''}${g.blocked ? ` · 막힘 ${g.blocked}` : ''}`;
}

/** 오퍼레이터 계획·판단 프롬프트에 넣는 작업 목록 */
export function workPlanSection(p: MissionWorkPlan | null | undefined): string[] {
  if (!p?.items.length) return ['## 작업 목록(진척 관리)', '- 아직 없음(진척 관리 직원이 이번 판단 뒤에 만든다).', ''];
  return ['## 작업 목록(진척 관리 — 단원별 완료 기준과 상태)', `- ${progressLine(p)}`,
    ...p.items.map((i) => `- ${i.id} [${WORK_STATUS_LABEL[i.status]}] ${i.title} — 완료 기준: ${i.criteria || '(없음)'}${i.evidence ? ` · 근거: ${i.evidence}` : ''}${i.note ? ` · 메모: ${i.note}` : ''}`),
    '- 계획은 완료되지 않은 단원부터, 막힘·검증 중 단원을 먼저 풀도록 짠다. 모든 단원이 완료되면 미션이 끝난다.', ''];
}
