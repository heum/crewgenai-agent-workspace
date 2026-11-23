// 진척 관리: 진척 관리 직원이 작업 목록(단원·완료 기준·상태)을 사이클마다 갱신하고, 모든 단원이 완료일 때만 미션이 끝난다
import { describe, expect, it } from 'vitest';
import { CLOSE_FIRST, mergeWorkPlan, needsUser, workPlanSection, workProgress } from '../src/main/workplan';
import type { MissionWorkPlan, WorkItem } from '../src/shared/types';
import { buildNextDraft } from '../src/main/mission';
import { gitInit, mkService, plan, sleep, tmpProject } from './helpers';

async function until<T>(f: () => T | null | undefined | false, ms = 60000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('시간 초과'); await sleep(50); }
}
function setup() {
  const dir = tmpProject(); gitInit(dir); const svc = mkService(dir);
  const p = svc.createProject(plan(dir, { writablePaths: ['docs'] }));
  svc.loadAgentTemplates(p.id);
  return { svc, p };
}
const texts = (svc: ReturnType<typeof mkService>, id: string) => svc.missions.detail(id).events.map((e) => e.text);

describe('작업 목록 반영 규칙', () => {
  it('근거 없는 완료는 검증 중으로 두고, 빠진 단원은 지우지 않으며, 이유 없는 제외와 완료 단원 제외는 거부한다', () => {
    const a = mergeWorkPlan(null, { items: [{ title: 'A', criteria: 'a', status: 'done', evidence: 'npm test 1 passed' }, { title: 'B', criteria: 'b', status: 'done' }, { title: 'C', criteria: 'c', status: 'todo' }] }, 1, 't');
    expect(a.plan!.items.map((i) => [i.id, i.status])).toEqual([['W1', 'done'], ['W2', 'verifying'], ['W3', 'todo']]);
    expect(a.plan!.changes).toHaveLength(1);
    const b = mergeWorkPlan(a.plan, { changeReason: '추가 지시', items: [{ id: 'W3', title: 'C', criteria: 'c', status: 'doing' }, { title: 'D', criteria: 'd', status: 'todo' }], removed: [{ id: 'W2', reason: '' }, { id: 'W1', reason: '필요 없음' }] }, 2, 't');
    expect(b.plan!.items.map((i) => [i.id, i.status])).toEqual([['W1', 'done'], ['W2', 'verifying'], ['W3', 'doing'], ['W4', 'todo']]);
    expect(b.changed.map((c) => [c.kind, c.id, c.reason])).toEqual([['add', 'W4', '추가 지시']]);
    expect(b.notes.join(' ')).toContain('W2: 이유 없이');
    expect(b.notes.join(' ')).toContain('W1: 완료한 기능은 빼지 않음');
    const c = mergeWorkPlan(b.plan, { changeReason: '범위 축소 지시', items: [], removed: [{ id: 'W4', reason: '사용자가 범위에서 뺌' }] }, 3, 't');
    expect(c.plan!.items.map((i) => i.id)).toEqual(['W1', 'W2', 'W3']);
    expect(c.plan!.removed.map((i) => i.id)).toEqual(['W4']);
    expect(workProgress(c.plan)).toMatchObject({ total: 3, done: 1, pct: 33 });
  });
});

describe('작업 목록 반영 규칙 — 리뷰 반영', () => {
  it('처음 만들 때 갱신안의 단계 id 순서가 달라도 서로 다른 단계를 합치지 않는다', () => {
    const r = mergeWorkPlan(null, { phases: [{ id: 'P2', title: '화면', goal: 'g' }, { id: 'P1', title: '기반', goal: 'g' }], items: [{ phase: 'P2', title: '목록', criteria: 'c', status: 'todo' }, { phase: 'P1', title: '저장', criteria: 'c', status: 'todo' }] }, 1, 't');
    expect(r.plan!.phases!.map((p) => p.title)).toEqual(['화면', '기반']);
    const of = (t: string) => r.plan!.phases!.find((p) => p.id === r.plan!.items.find((i) => i.title === t)!.phase)!.title;
    expect([of('목록'), of('저장')]).toEqual(['화면', '기반']);
  });
  it('완료 기준이 바뀌면 예전 근거로는 완료를 유지하지 않는다', () => {
    const a = mergeWorkPlan(null, { items: [{ title: '로그인', criteria: '로그인 성공', status: 'done', evidence: 'login test 3 passed' }] }, 1, 't');
    const b = mergeWorkPlan(a.plan, { changeReason: '보안 지시', items: [{ id: 'W1', title: '로그인', criteria: '로그인과 2단계 인증 성공', status: 'done' }] }, 2, 't');
    expect(b.plan!.items[0].status).toBe('verifying');
    const c = mergeWorkPlan(b.plan, { items: [{ id: 'W1', title: '로그인', criteria: '로그인과 2단계 인증 성공', status: 'done', evidence: '2fa test 2 passed' }] }, 3, 't');
    expect(c.plan!.items[0].status).toBe('done');
    // 검증 중이던 기능도 기준이 바뀌면 예전 근거가 지워진다
    const d = mergeWorkPlan(c.plan, { items: [{ id: 'W1', title: '로그인', criteria: '로그인·2단계·잠금', status: 'verifying' }] }, 4, 't');
    expect(d.plan!.items[0].evidence).toBe('');
    expect(mergeWorkPlan(d.plan, { items: [{ id: 'W1', title: '로그인', status: 'done', criteria: '로그인·2단계·잠금' }] }, 5, 't').plan!.items[0].status).toBe('verifying');
  });
  it('변경 기록을 줄여도 확인하지 않은 변경 수는 그대로 보인다', () => {
    let p = mergeWorkPlan(null, { items: [{ title: 'A', criteria: 'a', status: 'todo' }] }, 1, 't').plan!;
    for (let i = 0; i < 85; i++) p = mergeWorkPlan(p, { changeReason: 'x', items: [{ title: `N${i}`, criteria: 'n', status: 'todo' }] }, 2, 't').plan!;
    p = { ...p, reviewedChanges: p.changes.length };
    p = mergeWorkPlan(p, { changeReason: 'y', items: [{ id: 'W1', title: 'A', criteria: 'a2', status: 'todo' }] }, 3, 't').plan!;
    expect(p.changes.length - p.reviewedChanges).toBe(1);
  });
});

describe('진척 관리 직원', () => {
  it('없으면 채용해 첫 판단 뒤 작업 목록을 만들고, 모든 단원이 근거와 함께 완료되면 미션이 끝난다', async () => {
    const { svc, p } = setup();
    svc.store.db.prepare('DELETE FROM agents WHERE id=?').run(svc.store.listAgents(p.id).find((a) => a.code === 'PM')!.id); // 진척 관리 직원이 생기기 전의 프로젝트
    const m0 = await svc.startMission(p.id, '[[mock:workplan]] 문서를 정리하라');
    const w1 = await until(() => { const w = svc.missions.progress(p.id); return w?.items.length ? w : null; });
    expect(w1.items.map((i) => [i.id, i.phase, i.status])).toEqual([['W1', 'P2', 'done'], ['W2', 'P2', 'verifying'], ['W3', 'P1', 'todo']]);
    expect(w1.phases!.map((x) => [x.id, x.title])).toEqual([['P1', '기반'], ['P2', '화면']]);
    expect(w1.items[0].refs).toEqual(['FN-001']);
    expect(svc.store.listAgents(p.id).some((a) => a.code === 'PM' && a.name === '진척 관리')).toBe(true);
    expect(svc.missions.reviewProgress(p.id).reviewedChanges).toBe(1);
    await until(() => svc.missions.get(m0.id).status === 'done');
    expect(svc.missions.progress(p.id)!.items.every((i) => i.status === 'done')).toBe(true);
    expect(svc.missions.detail(m0.id).progress!.items).toHaveLength(3);
    const t = texts(svc, m0.id).join('\n');
    expect(t).toContain('진척 관리 직원을 채용했습니다');
    expect(t).toContain("'검증 중'으로 둠");
    // 진척 관리 직원에게는 개발 작업을 배정하지 않는다
    const pm = svc.store.listAgents(p.id).find((a) => a.code === 'PM')!;
    for (const c of svc.missions.detail(m0.id).cycles) expect(svc.engine.detail(c.runId).graph.nodes.some((n) => n.agentId === pm.id)).toBe(false);
    svc.close();
  });

  it('프로젝트에 남은 기능이 있어도 미션 완료는 오퍼레이터 판단을 따르고 완료 보고에 남은 진척을 보이며, 이유 없는 제외는 받지 않는다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:workplan-stuck]] 문서를 정리하라');
    const m = await until(() => { const x = svc.missions.get(m0.id); return x.status === 'done' ? x : null; });
    expect(m.question).toContain('프로젝트 진척: 단계 2개 · 기능 3개 중 2개 완료');
    expect(svc.missions.progress(p.id)!.items.find((i) => i.id === 'W3')!.status).toBe('doing');
    expect(texts(svc, m0.id).join('\n')).toContain('W3: 이유 없이 빼려 해 그대로 둠');
    await svc.missions.stop(m0.id); svc.close();
  });

  it('다음 미션 추천 초안: 남은 기능만 다루고 완료 기준은 진척 목록 원문을 그대로 붙이며, 미션을 시작하거나 상태를 바꾸지 않는다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:workplan-stuck]] 문서를 정리하라');
    await until(() => { const x = svc.missions.get(m0.id); return x.status === 'done' ? x : null; });
    const before = svc.missions.list(p.id).map((m) => [m.id, m.status]);
    const w3 = svc.missions.progress(p.id)!.items.find((i) => i.id === 'W3')!;
    const d = await svc.missions.suggestNext(p.id);
    expect(d.scopeIds).toEqual(['W3']); // 모델이 고른 것 중 진척 목록에 있고 완료되지 않은 것만(W999·완료 기능은 빠짐)
    expect(d.text).toContain('모의 다음 미션 지시문');
    expect(d.text).toContain('## 고정 완료 기준');
    expect(d.text).toContain(`- W3 ${w3.title}: ${w3.criteria}`);
    expect(d.ask).toEqual(['결제 키를 어디에 둘지']);
    expect(d.fromMissionId).toBe(m0.id);
    expect(svc.missions.list(p.id).map((m) => [m.id, m.status])).toEqual(before); // 새 미션 없음, 상태 그대로
    expect(texts(svc, m0.id).join('\n')).toContain('다음 미션 추천 초안을 만들었습니다');
    await svc.missions.stop(m0.id); svc.close();
  });

  it('다음 미션 초안 조립: 본문이 없으면 실패하고, 고른 기능이 하나도 맞지 않으면 남은 기능 전부의 기준을 붙인다', () => {
    const open = [{ id: 'W1', phase: 'P1', refs: [], title: '가', criteria: '기준 가', status: 'todo', evidence: '', note: '', addedCycle: 1, updatedCycle: 1 }, { id: 'W2', phase: 'P1', refs: [], title: '나', criteria: '', status: 'doing', evidence: '', note: '', addedCycle: 1, updatedCycle: 1 }] as never;
    expect(() => buildNextDraft({ prompt: '짧음', scopeIds: ['W1'] }, open, 'm', 't')).toThrow('본문 없음');
    const body = '다음 미션 지시문\n\n## 목표\n남은 기능을 이어서 닫는다. 범위와 한도는 아래를 따른다.';
    const d = buildNextDraft({ title: ' 이름 ', prompt: body, scopeIds: ['w2', 'X9'], ask: 'not-array' }, open, 'm', 't');
    expect(d.scopeIds).toEqual(['W2']); expect(d.title).toBe('이름'); expect(d.ask).toEqual([]);
    expect(d.text).toContain('- W2 나: (완료 기준 없음 — 팀장이 정해야 함)'); expect(d.text).not.toContain('- W1 가');
    const all = buildNextDraft({ prompt: body, scopeIds: ['X9'] }, open, 'm', 't');
    expect(all.scopeIds).toEqual(['W1', 'W2']); expect(all.text).toContain('- W1 가: 기준 가');
  });

  it('진척 관리 직원이 휴가 중이면 작업 목록을 갱신하지 않고 예전처럼 오퍼레이터 판단으로 끝난다', async () => {
    const { svc, p } = setup();
    const agents = svc.store.listAgents(p.id);
    svc.setAgentActive(agents.find((a) => a.code === 'PM')!.id, false);
    const m0 = await svc.startMission(p.id, '문서를 정리하라');
    const done = await until(() => { const m = svc.missions.get(m0.id); return m.status === 'done' ? m : null; });
    expect(done.status).toBe('done');
    expect(svc.missions.progress(p.id)).toBeNull();
    svc.close();
  });
});

describe('닫기 우선', () => {
  const item = (id: string, status: WorkItem['status'], updatedCycle: number, note = ''): WorkItem => ({ id, phase: 'P1', refs: [], title: `기능 ${id}`, criteria: '시험 통과', status, evidence: '', note, addedCycle: 1, updatedCycle });
  const plan = (items: WorkItem[]): MissionWorkPlan => ({ phases: [{ id: 'P1', title: '기반', goal: '' }], items, removed: [], changes: [], reviewedChanges: 0, createdCycle: 1, reviewedAt: null });
  it('검증 중이 쌓이면 새 기능을 시작하지 않게 하고, 오래 머문 것부터 보여 준다', () => {
    const text = workPlanSection(plan([item('W1', 'todo', 1), ...[2, 3, 4, 5, 6].map((n) => item(`W${n}`, 'verifying', 20 - n))]), 30).join('\n');
    expect(text).toContain(`닫지 못한 기능(검증 중·막힘)이 ${CLOSE_FIRST}개다`);
    expect(text).toContain("'시작 전' 기능은 시작하지 않는다");
    expect(text.indexOf('W6 [')).toBeLessThan(text.indexOf('W2 ['));
    expect(text.indexOf('W2 [')).toBeLessThan(text.indexOf('W1 ['));
    expect(text).toContain('16사이클째 그대로');
  });
  it('적게 남았으면 닫는 일을 먼저 넣고 다음 기능도 허용한다', () => {
    const text = workPlanSection(plan([item('W1', 'todo', 1), item('W2', 'verifying', 3)]), 5).join('\n');
    expect(text).toContain('닫는 작업을 먼저 넣고');
    expect(text).not.toContain('시작하지 않는다(');
  });
  it('사용자 확인만 남은 기능은 작업 목록에서 빼고 따로 모은다', () => {
    const items = [item('W1', 'blocked', 3, '사용자 확인: 업로드 화면에서 파일이 올라가는지'), item('W2', 'verifying', 3)];
    expect(needsUser(items[0])).toBe(true); expect(needsUser(items[1])).toBe(false);
    const text = workPlanSection(plan(items), 5).join('\n');
    expect(text).toContain('사용자 확인을 기다리는 기능 1개');
    expect(text).not.toContain('W1 [');
  });
});
