// 확인 필요 항목을 골라서 계속 진행하기 — 선택지 달린 근거 부족·선택형 질문
import { describe, expect, it } from 'vitest';
import type { Mission } from '../src/shared/types';
import { gitInit, mkService, plan, sleep, tmpProject } from './helpers';

async function waitMission(svc: ReturnType<typeof mkService>, id: string, statuses: Mission['status'][], ms = 60000) {
  const t0 = Date.now();
  for (;;) {
    const m = svc.missions.get(id);
    if (statuses.includes(m.status)) return m;
    if (Date.now() - t0 > ms) throw new Error(`시간 초과: ${m.status}/${m.stage}`);
    await sleep(50);
  }
}

function setup() {
  const dir = tmpProject(); gitInit(dir); const svc = mkService(dir);
  const p = svc.createProject(plan(dir, { writablePaths: ['docs'] }));
  svc.loadAgentTemplates(p.id);
  return { svc, p };
}

describe('확인 필요 항목 고르기', () => {
  it('근거 부족만 있어 멈추면 선택지를 보여 주고, 고르면 그 결정을 따라 바로 이어서 진행한다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:gaps-options-only]] 기능표를 정리하라');
    const w = await waitMission(svc, m0.id, ['waiting_user', 'done', 'failed']);
    expect(w.status).toBe('waiting_user');
    expect(w.gaps?.[0]?.options).toEqual(['HTML 기준 유지 — 제품을 HTML에 맞춘다', '제품 기준 승인 — HTML을 제품에 맞춘다']);
    expect(svc.attention().items.some((i) => i.missionId === w.id && i.kind === 'gaps')).toBe(true);

    const g = w.gaps![0];
    // 목록이 바뀐 뒤 들어온 선택(다른 항목)은 엉뚱한 항목에 붙지 않고 거절한다
    expect(() => svc.missions.decide(w.id, [{ doc: g.doc, issue: '바뀐 항목', choice: 'x' }], true)).toThrow('목록이 바뀌었습니다');
    expect(() => svc.missions.decide(w.id, [{ doc: g.doc, issue: g.issue, choice: '   ' }], true)).toThrow();

    svc.missions.decide(w.id, [{ doc: g.doc, issue: g.issue, choice: g.options![0] }], true);
    // 결정이 계획에 '사용자 결정'으로 들어가야 모의 오퍼레이터가 작업을 계획한다 → 완료까지 간다
    const d = await waitMission(svc, w.id, ['waiting_user', 'done', 'failed']);
    expect(d.status).toBe('done');
    expect(d.decisions?.map((x) => x.choice)).toEqual(['HTML 기준 유지 — 제품을 HTML에 맞춘다']);
    expect(d.gaps ?? []).toHaveLength(0);
    expect(svc.missions.events(d.id).some((e) => e.kind === 'answer' && e.text.includes('확인 필요 항목 결정'))).toBe(true);
    svc.missions.answer(d.id, '', 'stop');
    svc.close();
  });

  it('작업을 계속하는 중에 생긴 선택 항목은 진행을 막지 않고, 고르면 목록에서 빠지고 결정으로 남는다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:gaps-options]] 기능표를 정리하라');
    const m = await waitMission(svc, m0.id, ['waiting_user', 'done', 'failed']);
    expect(m.status).toBe('done');
    expect(m.gaps?.[0]?.options?.length).toBe(2);
    expect(svc.attention().items.some((i) => i.missionId === m.id && i.kind === 'gaps')).toBe(true);
    const after = svc.missions.decide(m.id, [{ doc: m.gaps![0].doc, issue: m.gaps![0].issue, choice: '직접 적은 결정: 보류 없이 HTML 기준' }], false);
    expect(after.status).toBe('done');
    expect(after.gaps ?? null).toBeNull();
    expect(after.decisions?.[0]?.choice).toBe('직접 적은 결정: 보류 없이 HTML 기준');
    expect(svc.attention().items.some((i) => i.missionId === m.id && i.kind === 'gaps')).toBe(false);
    svc.missions.answer(m.id, '', 'stop');
    expect(() => svc.missions.decide(m.id, [{ doc: 'a', issue: 'b', choice: 'x' }], false)).toThrow();
    svc.close();
  });

  it('선택지 버튼으로 질문에만 답하면 남은 확인 필요 항목은 그대로 둔다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:gaps-options-only]] 기능표를 정리하라');
    const w = await waitMission(svc, m0.id, ['waiting_user', 'done', 'failed']);
    expect(w.gaps).toHaveLength(1);
    const n = svc.missions.answer(w.id, '참고 답변', 'continue', 'pending');
    expect(n.gaps).toHaveLength(1);
    expect(n.questionOptions ?? null).toBeNull();
    const again = await waitMission(svc, w.id, ['waiting_user', 'done', 'failed']);
    expect(again.gaps?.map((g) => g.issue)).toEqual([w.gaps![0].issue]); // 같은 항목이 중복 없이 남는다
    svc.missions.answer(again.id, '', 'stop');
    svc.close();
  });

  it('선택형 질문은 선택지를 함께 보여 주고, 답하면 선택지를 지운다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:ask-options]] 기능표를 정리하라');
    const w = await waitMission(svc, m0.id, ['waiting_user', 'done', 'failed']);
    expect(w.status).toBe('waiting_user');
    expect(w.question).toBe('어느 기준으로 진행할까요?');
    expect(w.questionOptions).toEqual(['HTML 기준', '제품 기준']);
    const n = svc.missions.answer(w.id, 'HTML 기준', 'continue');
    expect(n.questionOptions ?? null).toBeNull();
    const d = await waitMission(svc, w.id, ['waiting_user', 'done', 'failed']);
    expect(d.status).toBe('done');
    svc.missions.answer(d.id, '', 'stop');
    svc.close();
  });
});
