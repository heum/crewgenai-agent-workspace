// 확인 필요 항목을 골라서 계속 진행하기 — 선택지 달린 근거 부족·선택형 질문
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  return { svc, p, dir };
}

describe('확인 필요 항목 고르기', () => {
  it('항목마다 쉬운 설명과 근거 위치를 주고, 근거 위치는 프로젝트 안 파일만 해당 줄 앞뒤로 보여 준다', async () => {
    const { svc, p, dir } = setup();
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', '기능 대조표.md'), '# 기능 대조표\n버튼은 위에 둔다 token=sk-ant-api03-FAKEFAKEFAKEFAKE00\n셋째 줄\n');
    const m0 = await svc.startMission(p.id, '[[mock:gaps-options-only]] 기능표를 정리하라');
    const w = await waitMission(svc, m0.id, ['waiting_user', 'done', 'failed']);
    expect(w.gaps?.[0]?.explain).toContain('정해야');
    expect(w.gaps?.[0]?.refs).toEqual([{ path: 'docs/기능 대조표.md', line: 2 }]);
    const s = svc.refSnippet(w.id, 'docs/기능 대조표.md', 2);
    expect(s.exists).toBe(true);
    expect(s.target).toBe(2);
    expect(s.lines[1]).toContain('버튼은 위에 둔다');
    expect(s.lines.join('\n')).not.toContain('FAKEFAKE'); // 비밀값은 가린다
    // 여러 줄 비밀값(개인 키)은 본문까지 가리고, 줄 번호는 그대로 둔다
    writeFileSync(join(dir, 'docs', 'k.md'), ['첫 줄', '-----BEGIN PRIVATE KEY-----', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', '-----END PRIVATE KEY-----', '다섯째 줄'].join('\n'));
    const k = svc.refSnippet(w.id, 'docs/k.md', 5);
    expect(k.lines.join('\n')).not.toContain('QUJDREVG');
    expect(k.lines[k.target! - k.start]).toBe('다섯째 줄');
    // 수정 허용 경로 아래 기준으로 적어도 찾는다
    expect(svc.refSnippet(w.id, '기능 대조표.md', null).exists).toBe(true);
    // 프로젝트 밖은 읽지 않는다: 상위 경로·절대 경로·밖을 가리키는 링크
    expect(svc.refSnippet(w.id, '../../../../../../etc/hosts', null).exists).toBe(false);
    expect(svc.refSnippet(w.id, '/etc/hosts', null).exists).toBe(false);
    try { symlinkSync('/etc/hosts', join(dir, 'docs', 'link.md')); expect(svc.refSnippet(w.id, 'docs/link.md', null).exists).toBe(false); } catch { /* 링크를 만들 수 없는 환경 */ }
    svc.missions.answer(w.id, '', 'stop');
    svc.close();
  });

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

describe('직원 제안', () => {
  it('오퍼레이터가 새 직원·역할 변경을 제안하면 진행은 계속하고, 사용자가 그대로·고쳐서 적용하거나 무시한다(권한은 바뀌지 않음)', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:staff]] 문서를 정리하라');
    const m = await waitMission(svc, m0.id, ['waiting_user', 'done', 'failed']);
    expect(m.status).toBe('done');
    const ps = m.staffProposals ?? [];
    expect(ps.map((x) => x.kind).sort()).toEqual(['add', 'update']); // 오퍼레이터(00) 변경은 걸러짐
    expect(ps.filter((x) => x.status === 'pending')).toHaveLength(2); // 다음 사이클에 같은 제안을 다시 내지 않음
    expect(svc.attention().items.some((i) => i.missionId === m.id && i.kind === 'staff')).toBe(true);

    const add = ps.find((x) => x.kind === 'add')!;
    const before = svc.store.listAgents(p.id);
    svc.resolveStaffProposal(m.id, add.id, 'apply', { name: '화면 검수 담당', role: add.role, instructions: add.instructions });
    const created = svc.store.listAgents(p.id).find((a) => !before.some((b) => b.id === a.id))!;
    expect(created.name).toBe('화면 검수 담당');
    expect(created.tools).not.toContain('Bash');
    expect(created.allowedCommands).toEqual([]);
    expect(created.workPaths).toEqual(['docs/qa']);
    expect(() => svc.resolveStaffProposal(m.id, add.id, 'apply', null)).toThrow('이미 처리');

    const up = ps.find((x) => x.kind === 'update')!;
    const target = before.find((a) => a.code === up.agentCode)!;
    svc.resolveStaffProposal(m.id, up.id, 'apply', null);
    const changed = svc.store.getAgent(target.id);
    expect(changed.instructions).toBe('근거 문서의 줄 번호를 붙여 작성한다.');
    expect(changed.tools).toEqual(target.tools);
    expect(changed.allowedCommands).toEqual(target.allowedCommands);
    const after = svc.missions.get(m.id);
    expect(after.staffProposals?.every((x) => x.status === 'applied')).toBe(true);
    expect(svc.attention().items.some((i) => i.missionId === m.id && i.kind === 'staff')).toBe(false);
    svc.missions.answer(m.id, '', 'stop');
    svc.close();
  });

  it('무시한 제안은 기록에 남고 다시 제안하지 않는다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:staff]] 문서를 정리하라');
    const m = await waitMission(svc, m0.id, ['waiting_user', 'done', 'failed']);
    // 제안 뒤 그 직원을 해고하면, 같은 코드를 이어받은 새 직원에게 옛 제안이 적용되지 않는다
    const up = m.staffProposals!.find((x) => x.kind === 'update')!;
    svc.fireAgent(up.agentId!);
    const add = m.staffProposals!.find((x) => x.kind === 'add')!;
    svc.resolveStaffProposal(m.id, add.id, 'apply', null);
    expect(svc.store.listAgents(p.id).some((a) => a.code === up.agentCode)).toBe(true); // 코드를 이어받은 새 직원
    expect(() => svc.resolveStaffProposal(m.id, up.id, 'apply', null)).toThrow('직원이 없습니다');
    for (const x of svc.missions.get(m.id).staffProposals ?? []) if (x.status === 'pending') svc.resolveStaffProposal(m.id, x.id, 'dismiss', null);
    const d = svc.missions.get(m.id);
    expect(d.staffProposals?.every((x) => x.status !== 'pending')).toBe(true);
    svc.missions.answer(d.id, '다음 사이클', 'continue');
    const e = await waitMission(svc, d.id, ['waiting_user', 'done', 'failed']);
    expect((e.staffProposals ?? []).filter((x) => x.status === 'pending')).toHaveLength(0);
    svc.missions.answer(e.id, '', 'stop');
    svc.close();
  });
});
