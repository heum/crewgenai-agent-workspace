// 진척 관리: 진척 관리 직원이 작업 목록(단원·완료 기준·상태)을 사이클마다 갱신하고, 모든 단원이 완료일 때만 미션이 끝난다
import { describe, expect, it } from 'vitest';
import { mergeWorkPlan, workProgress } from '../src/main/workplan';
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
    expect(b.notes.join(' ')).toContain('W1: 완료한 단원은 빼지 않음');
    const c = mergeWorkPlan(b.plan, { changeReason: '범위 축소 지시', items: [], removed: [{ id: 'W4', reason: '사용자가 범위에서 뺌' }] }, 3, 't');
    expect(c.plan!.items.map((i) => i.id)).toEqual(['W1', 'W2', 'W3']);
    expect(c.plan!.removed.map((i) => i.id)).toEqual(['W4']);
    expect(workProgress(c.plan)).toMatchObject({ total: 3, done: 1, pct: 33 });
  });
});

describe('진척 관리 직원', () => {
  it('없으면 채용해 첫 판단 뒤 작업 목록을 만들고, 모든 단원이 근거와 함께 완료되면 미션이 끝난다', async () => {
    const { svc, p } = setup();
    svc.store.db.prepare('DELETE FROM agents WHERE id=?').run(svc.store.listAgents(p.id).find((a) => a.code === 'PM')!.id); // 진척 관리 직원이 생기기 전의 프로젝트
    const m0 = await svc.startMission(p.id, '[[mock:workplan]] 문서를 정리하라');
    const m1 = await until(() => { const m = svc.missions.get(m0.id); return m.workPlan?.items.length ? m : null; });
    expect(m1.workPlan!.items.map((i) => [i.id, i.status])).toEqual([['W1', 'done'], ['W2', 'verifying'], ['W3', 'todo']]);
    expect(svc.store.listAgents(p.id).some((a) => a.code === 'PM' && a.name === '진척 관리')).toBe(true);
    expect(svc.missions.reviewWorkPlan(m0.id).workPlan!.reviewedChanges).toBe(1);
    const done = await until(() => { const m = svc.missions.get(m0.id); return m.status === 'done' ? m : null; });
    expect(done.workPlan!.items.every((i) => i.status === 'done')).toBe(true);
    const t = texts(svc, m0.id).join('\n');
    expect(t).toContain('진척 관리 직원을 채용했습니다');
    expect(t).toContain("'검증 중'으로 둠");
    // 진척 관리 직원에게는 개발 작업을 배정하지 않는다
    const pm = svc.store.listAgents(p.id).find((a) => a.code === 'PM')!;
    for (const c of svc.missions.detail(m0.id).cycles) expect(svc.engine.detail(c.runId).graph.nodes.some((n) => n.agentId === pm.id)).toBe(false);
    svc.close();
  });

  it('오퍼레이터가 완료로 판단해도 끝나지 않은 단원이 남으면 계속 진행하고, 이유 없는 제외는 받지 않는다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:workplan-stuck]] 문서를 정리하라');
    await until(() => texts(svc, m0.id).some((x) => x.includes('끝나지 않은 단원이 남아')));
    const m = svc.missions.get(m0.id);
    expect(m.status).not.toBe('done');
    expect(m.workPlan!.items.find((i) => i.id === 'W3')!.status).toBe('doing');
    expect(texts(svc, m0.id).join('\n')).toContain('W3: 이유 없이 빼려 해 그대로 둠');
    await svc.missions.stop(m0.id); svc.close();
  });

  it('진척 관리 직원이 휴가 중이면 작업 목록을 갱신하지 않고 예전처럼 오퍼레이터 판단으로 끝난다', async () => {
    const { svc, p } = setup();
    const agents = svc.store.listAgents(p.id);
    svc.setAgentActive(agents.find((a) => a.code === 'PM')!.id, false);
    const m0 = await svc.startMission(p.id, '문서를 정리하라');
    const done = await until(() => { const m = svc.missions.get(m0.id); return m.status === 'done' ? m : null; });
    expect(done.workPlan ?? null).toBeNull();
    svc.close();
  });
});
