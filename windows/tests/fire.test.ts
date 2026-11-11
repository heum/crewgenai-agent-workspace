// 직원 해고(삭제) 시험 — 목록·배정에서 빠지고 기록은 남는다
import { describe, expect, it } from 'vitest';
import { gitInit, mkService, plan, sleep, tmpProject } from './helpers';

describe('직원 해고', () => {
  it('해고하면 목록에서 빠지고, 이 직원을 검토 담당으로 둔 직원의 지정을 비우며, 기록용 목록에는 해고 표시로 남는다', () => {
    const dir = tmpProject(); const svc = mkService(dir);
    const p = svc.createProject(plan(dir));
    const agents = svc.loadAgentTemplates(p.id, 'general');
    const reviewer = agents.find((a) => a.code === '05')!;
    const users = agents.filter((a) => a.reviewerAgentId === reviewer.id).map((a) => `${a.code} ${a.name}`);
    expect(users.length).toBeGreaterThan(0);
    const r = svc.fireAgent(reviewer.id);
    expect(r.cleared.sort()).toEqual(users.sort());
    const now = svc.store.listAgents(p.id);
    expect(now.some((a) => a.id === reviewer.id)).toBe(false);
    expect(now.every((a) => a.reviewerAgentId !== reviewer.id)).toBe(true);
    const all = svc.store.listAgents(p.id, true);
    expect(all.find((a) => a.id === reviewer.id)?.fired).toBe(true);
    expect(() => svc.fireAgent(reviewer.id)).toThrow('이미 해고');
    // 해고한 직원이 담당인 흐름은 저장 전에 오류로 잡힌다
    const g = svc.defaultGraph(p.id);
    const node = g.nodes.find((n) => n.kind === 'agent')!;
    node.agentId = reviewer.id;
    expect(svc.validate(p.id, g).some((i) => i.level === 'error' && i.nodeId === node.id)).toBe(true);
    // 같은 코드의 템플릿을 다시 불러오면 새 직원으로 들어온다
    const again = svc.loadAgentTemplates(p.id, 'general');
    expect(again.filter((a) => a.code === '05').length).toBe(1);
    expect(again.find((a) => a.code === '05')!.id).not.toBe(reviewer.id);
    svc.close();
  });

  it('작동 중인 미션의 오퍼레이터(00)는 해고하지 않는다', async () => {
    const dir = tmpProject(); gitInit(dir); const svc = mkService(dir);
    const p = svc.createProject(plan(dir, { writablePaths: ['docs'] }));
    svc.loadAgentTemplates(p.id);
    const m = await svc.startMission(p.id, '[[mock:hang]] 일하라');
    for (let i = 0; i < 100 && !['planning', 'running'].includes(svc.missions.get(m.id).status); i++) await sleep(50);
    const lead = svc.store.listAgents(p.id).find((a) => a.code === '00')!;
    expect(() => svc.fireAgent(lead.id)).toThrow(/(오퍼레이터|일하는 중)/);
    await svc.missions.stop(m.id);
    svc.close();
  });
});
