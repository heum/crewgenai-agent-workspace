// 문의 대화와 대기 중인 추가 지시: 개발을 멈추지 않고 묻고, 오퍼레이터가 읽기 전의 추가 지시는 취소할 수 있다
import { describe, expect, it } from 'vitest';
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

describe('대기 중인 추가 지시', () => {
  it('오퍼레이터 계획 전에는 목록에 보이고 취소할 수 있으며, 계획에 들어간 뒤에는 취소할 수 없다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '문서를 정리하라');
    await until(() => svc.missions.get(m0.id).currentRunId);
    svc.missions.pause(m0.id);
    await svc.missions.addDirective(m0.id, '표지를 먼저 만들어라', 'next');
    await svc.missions.addDirective(m0.id, '색은 파란색으로', 'next');
    const pend = svc.missions.pendingDirectives(m0.id);
    expect(pend.map((x) => x.text)).toEqual(['[다음 사이클 반영] 표지를 먼저 만들어라', '[다음 사이클 반영] 색은 파란색으로']);
    svc.missions.cancelDirective(m0.id, pend[0].seq);
    expect(() => svc.missions.cancelDirective(m0.id, pend[0].seq)).toThrow();
    expect(svc.missions.pendingDirectives(m0.id).map((x) => x.seq)).toEqual([pend[1].seq]);
    expect(svc.missions.detail(m0.id, 10).pendingDirectives).toHaveLength(1);
    svc.missions.resume(m0.id);
    await until(() => svc.missions.pendingDirectives(m0.id).length === 0);
    expect(() => svc.missions.cancelDirective(m0.id, pend[1].seq)).toThrow('이미 오퍼레이터 계획에 반영');
    await svc.missions.stop(m0.id); svc.close();
  });
});

describe('문의 대화', () => {
  it('미션이 없어도 문의 응대 직원을 채용해 답하고, 대화는 이 PC에 남으며 작업 배정에는 쓰지 않는다', async () => {
    const { svc, p } = setup();
    svc.store.db.prepare('DELETE FROM agents WHERE id=?').run(svc.store.listAgents(p.id).find((a) => a.code === 'HD')!.id);
    const list = await svc.missions.qaAsk(p.id, '지금 무엇을 하고 있어?');
    expect(list.map((m) => m.role)).toEqual(['user', 'staff']);
    expect(list[1].text).toContain('모의 답변');
    expect(list[1].who).toBe('HD 문의 응대');
    expect(svc.store.listAgents(p.id).some((a) => a.code === 'HD')).toBe(true);
    expect(svc.missions.qaList(p.id)).toHaveLength(2);
    await expect(svc.missions.qaAsk(p.id, '   ')).rejects.toThrow('질문을 입력');
    svc.missions.qaClear(p.id);
    expect(svc.missions.qaList(p.id)).toHaveLength(0);
    svc.close();
  });

  it('직원이 제안한 추가 지시는 사용자가 눌러야 대기 중인 추가 지시로 들어가고, 한 번만 보낸다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '문서를 정리하라');
    await until(() => svc.missions.get(m0.id).currentRunId);
    svc.missions.pause(m0.id);
    const list = await svc.missions.qaAsk(p.id, '저장부터 하면 안 돼? [[mock:qa-directive]]');
    const ans = list.at(-1)!;
    expect(ans.directive).toBe('저장 기능을 목록보다 먼저 하라');
    expect(svc.missions.pendingDirectives(m0.id)).toHaveLength(0); // 누르기 전에는 전달하지 않음
    await svc.missions.qaSendDirective(p.id, ans.seq);
    expect(svc.missions.pendingDirectives(m0.id).map((x) => x.text)).toEqual(['[다음 사이클 반영] [문의 대화에서] 저장 기능을 목록보다 먼저 하라']);
    await expect(svc.missions.qaSendDirective(p.id, ans.seq)).rejects.toThrow('이미 보낸');
    const hd = svc.store.listAgents(p.id).find((a) => a.code === 'HD')!;
    svc.missions.resume(m0.id);
    await until(() => svc.missions.pendingDirectives(m0.id).length === 0);
    for (const c of svc.missions.detail(m0.id).cycles) expect(svc.engine.detail(c.runId).graph.nodes.some((n) => n.agentId === hd.id)).toBe(false);
    await svc.missions.stop(m0.id); svc.close();
  });
});
