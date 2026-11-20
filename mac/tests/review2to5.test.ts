// 앱 리뷰 2~5순위 개선: 추가 지시가 오래 살아남음·닫기, 결정 중복 정리, 확인함과 위쪽 막대의 종류 맞춤
import { describe, expect, it } from 'vitest';
import { gitInit, mkService, plan, sleep, tmpProject } from './helpers';

async function until<T>(f: () => T | null | undefined | false, ms = 60000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('시간 초과'); await sleep(50); }
}
function setup() {
  const dir = tmpProject(); gitInit(dir); const svc = mkService(dir);
  const p = svc.createProject(plan(dir, { writablePaths: ['docs'] })); svc.loadAgentTemplates(p.id);
  return { svc, p };
}
type Inner = { set(id: string, patch: object): void; event(m: object, kind: string, text: string): void; planPrompt(m: object, plan: object, agents: object[]): string; judgeDirectives?: unknown };

describe('추가 지시가 오래 살아남는다', () => {
  it('지시 뒤 판단이 20번 넘게 쌓여도 계획에 그 지시가 그대로 있고, 판단이 근거와 함께 닫으면 빠진다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '문서를 정리하라');
    await until(() => svc.missions.get(m0.id).currentRunId); svc.missions.pause(m0.id);
    await svc.missions.addDirective(m0.id, '모바일에서도 확인해야 합니다', 'next');
    const inner = svc.missions as unknown as Inner;
    for (let i = 0; i < 25; i++) inner.event(svc.missions.get(m0.id), 'operator_judge', `판단 ${i}`);
    const prompt = () => inner.planPrompt(svc.missions.get(m0.id), svc.store.getProject(p.id).plan, svc.store.listAgents(p.id));
    expect(prompt()).toContain('모바일에서도 확인해야 합니다');
    expect(prompt()).toContain('## 유효한 사용자 지시');
    const seq = svc.missions.detail(m0.id).events.filter((e) => e.kind === 'directive').at(-1)!.seq;
    inner.set(m0.id, { closedDirectives: [seq] });
    expect(prompt()).not.toContain('모바일에서도 확인해야 합니다');
    await svc.missions.stop(m0.id); svc.close();
  });
});

describe('결정 중복과 확인함 종류', () => {
  it('같은 대상을 다른 문구로 다시 답하면 확정 목록에 하나만 남고, 답이 다르면 기록에 알린다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '문서를 정리하라'); await svc.missions.stop(m0.id);
    const inner = svc.missions as unknown as Inner;
    inner.set(m0.id, { status: 'waiting_user', gaps: [{ doc: '화면.md', issue: "'저장 버튼 위치'를 어디에 둘까", need: '', kind: 'decide' }, { doc: '기획.md', issue: "'저장 버튼 위치' 확정 필요", need: '', kind: 'decide' }] });
    svc.missions.decide(m0.id, [{ doc: '화면.md', issue: "'저장 버튼 위치'를 어디에 둘까", choice: '오른쪽 위' }], false);
    svc.missions.decide(m0.id, [{ doc: '기획.md', issue: "'저장 버튼 위치' 확정 필요", choice: '아래 고정' }], false);
    const ds = (svc.missions.get(m0.id).decisions ?? []).filter((d) => d.issue.includes('저장 버튼 위치'));
    expect(ds.map((d) => d.choice)).toEqual(['아래 고정']);
    expect(svc.missions.detail(m0.id).events.some((e) => e.text.startsWith('방금 답이 같은 대상의 이전 결정과 다릅니다'))).toBe(true);
    svc.close();
  });

  it('위쪽 막대에 뜨는 보류한 업무·직원 제안이 확인함에도 항목으로 뜨고, 고르면 처리된다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '문서를 정리하라'); await until(() => svc.missions.get(m0.id).currentRunId); svc.missions.pause(m0.id);
    const inner = svc.missions as unknown as Inner;
    inner.set(m0.id, { blockers: [{ step: '시험 서버', reason: 'DB 접속 실패', kind: 'environment' }],
      staffProposals: [{ id: 'sp1', kind: 'add', agentId: null, agentCode: '', name: '모바일 확인', role: '모바일 화면 확인', instructions: '모바일에서 확인한다', workPaths: [], reason: '모바일 지시', cycle: 1, at: 't', status: 'pending' }] });
    const kinds = svc.pendingDecisions().filter((x) => x.missionId === m0.id).map((x) => x.kind);
    expect(kinds).toEqual(expect.arrayContaining(['blocker', 'staff']));
    const attn = svc.attention().items.filter((x) => x.missionId === m0.id).map((x) => x.kind);
    expect(attn).toEqual(expect.arrayContaining(['blocked', 'staff']));
    const bk = svc.pendingDecisions().find((x) => x.kind === 'blocker')!;
    expect(svc.applyDecisions([{ key: bk.key, choice: '해결했으니 다시 시도' }]).applied).toBe(1);
    expect(svc.missions.get(m0.id).blockers ?? null).toBeNull();
    const st = svc.pendingDecisions().find((x) => x.kind === 'staff')!;
    expect(svc.applyDecisions([{ key: st.key, choice: '적용하지 않음' }]).applied).toBe(1);
    expect(svc.missions.get(m0.id).staffProposals![0].status).toBe('dismissed');
    await svc.missions.stop(m0.id); svc.close();
  });
});
