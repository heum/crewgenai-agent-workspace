// 운영(오퍼레이터 루프) 시험 — 모의 Claude·모의 Codex 사용
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Mission } from '../src/shared/types';
import { gitInit, mkService, plan, sleep, tmpProject } from './helpers';
import { cleanLimits } from '../src/main/mission';

async function waitMission(svc: ReturnType<typeof mkService>, id: string, statuses: Mission['status'][], ms = 60000) {
  const t0 = Date.now();
  for (;;) {
    const m = svc.missions.get(id);
    if (statuses.includes(m.status)) return m;
    if (Date.now() - t0 > ms) throw new Error(`시간 초과: ${m.status}/${m.stage} ${m.question ?? ''}`);
    await sleep(50);
  }
}
function setup(extra = {}) {
  const dir = tmpProject(); gitInit(dir); const svc = mkService(dir);
  const p = svc.createProject(plan(dir, { writablePaths: ['docs'], ...extra }));
  svc.loadAgentTemplates(p.id); // 운영 지시 필수 항목: 오퍼레이터(00)·작성/검토 직원
  return { dir, svc, p };
}

describe('오퍼레이터 루프', () => {
  it('실행 제한: 참여 직원만 배정, 사용량 기록, 실행 준비 확인 기록. 시간 상한을 넘으면 작업 배정 없이 결과·막힌 것·사용량 보고', async () => {
    const { svc, p } = setup();
    svc.saveSettings({ missionMaxCycles: 1 });
    const ags = svc.store.listAgents(p.id).filter((a) => a.active && a.code !== '00');
    const writer = ags.find((a) => a.tools.includes('Edit') || a.tools.includes('Write'))!;
    const reader = ags.find((a) => !a.tools.includes('Edit') && !a.tools.includes('Write'))!;
    const m0 = await svc.startMission(p.id, '문서를 정리하라', { minutes: 90, staff: [writer.id, reader.id, 'unknown'] });
    expect(m0.limits).toEqual({ minutes: 90, staff: [writer.id, reader.id] });
    // 고른 직원을 하나도 찾지 못하면 제한을 풀지 않고 거절한다
    expect(() => cleanLimits({ minutes: null, staff: ['gone'] }, ags)).toThrow('참여 직원');
    const w = await waitMission(svc, m0.id, ['waiting_user', 'done', 'failed']);
    const ev = svc.missions.events(w.id);
    expect(ev.some((e) => e.kind === 'system' && e.text.startsWith('실행 준비 확인'))).toBe(true);
    expect(ev.some((e) => e.kind === 'system' && e.text.includes('시작부터 90분 상한'))).toBe(true);
    // 계획을 받은 직원은 오퍼레이터와 지정한 직원뿐
    const run = svc.engine.detail(svc.missions.detail(w.id).cycles[0].runId);
    const allowed = new Set([writer.id, reader.id, svc.store.listAgents(p.id).find((a) => a.code === '00')!.id]);
    for (const a of run.attempts.filter((x) => x.role !== 'codex')) expect(allowed.has(a.agentId ?? '')).toBe(true);
    expect(w.usage!.calls).toBeGreaterThan(0);
    expect(w.checkpoint?.usage).toContain('CLI 호출');
    // 시간 상한이 지난 상태에서 이어서 진행하면 새 작업을 배정하지 않고 보고한다
    (svc.missions as unknown as { set: (id: string, p: object) => void }).set(w.id, { limitStart: new Date(Date.now() - 91 * 60_000).toISOString() });
    const cycles = svc.missions.detail(w.id).cycles.length;
    svc.missions.review(w.id, [], '', 'continue');
    const l = await waitMission(svc, w.id, ['waiting_user', 'done', 'failed']);
    expect(l.checkpoint?.reason).toBe('limit');
    expect(svc.missions.detail(w.id).cycles.length).toBe(cycles);
    // 이어서 진행하면 시간 상한을 새로 잰다
    const before = Date.parse(l.limitStart!);
    svc.missions.review(l.id, [], '', 'stop');
    expect(Date.parse(svc.missions.get(l.id).limitStart!)).toBeGreaterThanOrEqual(before);
    svc.close();
  });

  it('시간 상한: 사용자 답을 기다린 시간은 빼고 잰다', async () => {
    const { svc, p } = setup();
    svc.saveSettings({ missionMaxCycles: 1 });
    const m0 = await svc.startMission(p.id, '문서를 정리하라', { minutes: 90, staff: null });
    const w = await waitMission(svc, m0.id, ['waiting_user', 'done', 'failed']);
    expect(w.checkpoint?.reason).toBe('budget');
    // 80분 전에 시작했지만 그중 40분은 사용자 답을 기다림 → 실제로 잰 시간 40분이라 상한 전
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    (svc.missions as unknown as { save: (m: object) => void }).save({ ...svc.missions.get(w.id), limitStart: ago(80), waitingSince: ago(40) });
    svc.missions.review(w.id, [], '', 'continue');
    const next = await waitMission(svc, w.id, ['waiting_user', 'done', 'failed']);
    expect(next.checkpoint?.reason ?? next.status).not.toBe('limit');
    expect(Date.now() - Date.parse(svc.missions.get(w.id).limitStart!)).toBeLessThan(45 * 60_000);
    svc.close();
  });

  it('실행 준비 확인에서 막히면(구현 담당 없음) 직원에게 작업을 배정하지 않고 막힌 것을 보고한다', async () => {
    const { svc, p } = setup();
    const reader = svc.store.listAgents(p.id).find((a) => a.active && a.code !== '00' && !a.tools.includes('Edit') && !a.tools.includes('Write'))!;
    const m0 = await svc.startMission(p.id, '문서를 정리하라', { minutes: null, staff: [reader.id] });
    const w = await waitMission(svc, m0.id, ['waiting_user', 'done', 'failed']);
    expect(w.checkpoint?.reason).toBe('blocked');
    expect(w.checkpoint?.blocked?.[0]).toContain('구현 담당');
    expect(svc.missions.detail(w.id).cycles.length).toBe(0);
    expect(svc.missions.events(w.id).some((e) => e.kind === 'operator_plan')).toBe(false);
    svc.close();
  });

  it('지시 → 계획 → 수행 → Codex 리뷰 → Claude 재검토(재작업) → 판단(계속) → 다음 사이클 → 완료 보고', async () => {
    const { dir, svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:todo-first]] 사이클마다 문서를 정리하라');
    const m = await waitMission(svc, m0.id, ['done', 'waiting_user', 'failed']);
    expect(m.status).toBe('done');
    expect(m.cycle).toBe(2);
    const d = svc.missions.detail(m.id);
    expect(d.cycles.map((c) => c.status)).toEqual(['succeeded', 'succeeded']);
    const kinds = d.events.map((e) => e.kind);
    for (const k of ['user', 'operator_plan', 'cycle_start', 'cycle_end', 'operator_judge', 'question']) expect(kinds).toContain(k);
    // 사이클 1: Codex가 TODO를 지적 → Claude 재검토가 수정 요청 → 작성자 재작업
    const r1 = svc.engine.detail(d.cycles[0].runId);
    expect(r1.graph.nodes.map((n) => n.kind)).toEqual(expect.arrayContaining(['agent', 'codexReview', 'review', 'merge']));
    expect(r1.reviews.filter((r) => r.kind === 'codex').map((r) => r.verdict)).toEqual(['changes_requested', 'approve']);
    expect(r1.reviews.filter((r) => r.kind === 'agent').map((r) => r.verdict)).toEqual(['changes_requested', 'approve']);
    expect(r1.attempts.filter((a) => a.role === 'author').length).toBe(2);
    expect(readFileSync(join(dir, 'docs/mission/cycle-1.md'), 'utf8')).toContain('FIXED');
    expect(existsSync(join(dir, 'docs/mission/cycle-2.md'))).toBe(true);
    // Codex 리뷰 보고서가 산출물로 남는다
    expect(r1.artifacts.some((a) => a.relPath.includes('reviews/codex-'))).toBe(true);
    svc.close();
  });

  it('정보가 부족하면 사용자에게 묻고, 답변 후 이어서 진행한다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:ask]] 문서를 정리하라');
    const w = await waitMission(svc, m0.id, ['waiting_user', 'done', 'failed']);
    expect(w.status).toBe('waiting_user');
    expect(w.question).toContain('어느 문서');
    expect(svc.missions.detail(w.id).cycles.length).toBe(0); // 묻기 전에는 실행하지 않는다
    svc.missions.answer(w.id, 'docs 폴더 기준으로 해 주세요', 'continue');
    const m = await waitMission(svc, w.id, ['done', 'failed']);
    expect(m.status).toBe('done');
    expect(svc.missions.events(m.id).some((e) => e.kind === 'answer' && e.text.includes('docs 폴더'))).toBe(true);
    svc.close();
  });

  it('자동 진행 한도에 닿으면 단독 질문 대신 검토 지점(결과·결정 묶음)으로 멈추고, 팝업은 한 건이며, 확인하면 이어서 진행한다', async () => {
    const { svc, p } = setup();
    svc.saveSettings({ missionMaxCycles: 1 });
    const m0 = await svc.startMission(p.id, '문서를 정리하라');
    const w = await waitMission(svc, m0.id, ['waiting_user', 'done']);
    expect(w.status).toBe('waiting_user');
    expect(w.checkpoint?.reason).toBe('budget');
    expect(w.question).toContain('검토 준비됨');
    const pend = svc.pendingDecisions().filter((d) => d.missionId === w.id);
    expect(pend.map((d) => d.kind)).toEqual(['checkpoint']); // 상한 질문·근거 부족 항목을 따로 띄우지 않는다
    svc.missions.review(w.id, [], '', 'continue');
    expect(svc.missions.events(w.id).some((e) => e.kind === 'answer' && e.text.includes('검토 지점 확인'))).toBe(true); // 피드백 없이 넘겨도 사용자 확인 기록이 남는다
    const m = await waitMission(svc, w.id, ['done', 'waiting_user']);
    expect(m.status).toBe('done');
    expect(m.cycle).toBe(2);
    svc.close();
  });

  it('검토 지점: 결과·시연 순서·검증 범위·결정·가정을 한곳에 두고, 고른 결정은 미션 결정으로 남아 다시 묻지 않으며 피드백은 다음 사이클 지시가 된다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:review]] 회사 관리 화면을 만들어라');
    const w = await waitMission(svc, m0.id, ['waiting_user', 'done', 'failed']);
    expect(w.checkpoint?.reason).toBe('ready');
    expect(w.checkpoint?.features[0].status).toBe('reviewable');
    expect(w.checkpoint?.decisions.length).toBe(1);
    expect(w.checkpoint?.assumptions).toContain('메모는 최대 500자로 가정');
    // 결정을 고르지 않고 확인만 하면 그 결정은 미결로 남아 다음 검토 지점에 다시 나온다
    svc.missions.review(w.id, [], '', 'continue');
    expect(svc.missions.get(w.id).gaps?.some((g) => g.issue === '삭제 기능을 1차에 넣을까요?')).toBe(true);
    const w2 = await waitMission(svc, w.id, ['waiting_user', 'done', 'failed']);
    if (w2.status === 'waiting_user' && w2.checkpoint) {
      svc.missions.review(w2.id, [{ doc: w2.checkpoint.decisions[0].doc, question: w2.checkpoint.decisions[0].question, choice: '2차로 미룬다' }], '목록 맨 위에 검색창을 두세요', 'continue');
      const m = await waitMission(svc, w2.id, ['done', 'failed']);
      expect(m.status).toBe('done');
      expect(m.decisions?.some((d) => d.doc === '검토 지점' && d.choice === '2차로 미룬다')).toBe(true);
      expect(svc.missions.events(m.id).some((e) => e.kind === 'directive' && e.text.includes('검색창'))).toBe(true);
    }
    svc.close();
  });

  it('되돌리기 쉬운 세부는 묻지 않고 가정하고 진행하며, 사람이 정할 결정은 진행 중 팝업으로 띄우지 않는다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:assume]] [[mock:hang]] 화면을 만들어라');
    for (let i = 0; i < 400 && svc.missions.get(m0.id).status === 'planning'; i++) await sleep(25);
    const m = svc.missions.get(m0.id);
    expect(m.assumptions?.map((a) => a.text)).toContain('저장 버튼은 화면 오른쪽 위에 둔다');
    expect(m.gaps?.length).toBe(1); // 결정 항목은 남겨 두고
    expect(svc.pendingDecisions().filter((d) => d.missionId === m.id && d.kind === 'gap')).toEqual([]); // 진행 중에는 띄우지 않는다
    let runId: string | null = null;
    for (let i = 0; i < 400 && !runId; i++) { await sleep(25); const x = svc.missions.get(m.id); if (x.currentRunId && svc.store.runAttempts(x.currentRunId).some((t) => t.pid)) runId = x.currentRunId; }
    await svc.missions.stop(m.id);
    for (let i = 0; i < 200 && runId && svc.engine.isActive(runId); i++) await sleep(25);
    await sleep(300);
    svc.close();
  });

  it('중단하면 진행 중인 실행을 실제로 취소하고 루프를 멈춘다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:hang]] 문서를 정리하라');
    let runId: string | null = null;
    for (let i = 0; i < 400 && !runId; i++) { await sleep(25); const m = svc.missions.get(m0.id); if (m.currentRunId && svc.store.runAttempts(m.currentRunId).some((a) => a.pid)) runId = m.currentRunId; }
    expect(runId).not.toBeNull();
    await svc.missions.stop(m0.id);
    for (let i = 0; i < 200 && svc.engine.isActive(runId!); i++) await sleep(25);
    expect(svc.store.getRun(runId!).status).toBe('cancelled');
    expect(svc.missions.get(m0.id).status).toBe('stopped');
    await sleep(300);
    expect(svc.missions.get(m0.id).status).toBe('stopped'); // 다시 돌지 않는다
    svc.close();
  });

  it('앱 재시작 시 진행 중이던 미션은 조용히 다시 돌지 않고 사용자 확인을 기다린다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:hang]] 문서를 정리하라');
    await sleep(300);
    const file = svc.store.file; svc.close();
    const { Service } = await import('../src/main/service');
    const { MOCK } = await import('./helpers');
    const re = new Service({ dbFile: file, mockScript: MOCK, emit: () => {} });
    re.missions.recoverOnStartup();
    expect(re.missions.get(m0.id).status).toBe('waiting_user');
    expect(re.missions.get(m0.id).pauseKind).toBe('restart');
    expect(re.pendingDecisions().filter((d) => d.missionId === m0.id)).toEqual([]); // 사용자 결정이 아니므로 팝업으로 묻지 않는다
    re.close();
  });
});

describe('Codex 5차 반영(운영 루프)', () => {
  it('오퍼레이터가 셸 실행 검사 명령을 계획해도 실행하지 않고 기록만 남긴다', async () => {
    const { dir, svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:check-sh]] 문서를 정리하라');
    const m = await waitMission(svc, m0.id, ['done', 'waiting_user', 'failed']);
    expect(existsSync(join(dir, 'pwned.txt'))).toBe(false);
    const d = svc.missions.detail(m.id);
    expect(d.events.some((e) => e.kind === 'system' && e.text.includes('허용되지 않은 검사 명령'))).toBe(true);
    expect(svc.engine.detail(d.cycles[0].runId).graph.nodes.some((n) => n.kind === 'check')).toBe(false);
    svc.close();
  });

  it('미션 지시에 들어간 토큰 형태 비밀값은 화면 전달·조회에서 가려진다', async () => {
    const dir = tmpProject(); gitInit(dir); const events: import('../src/shared/types').LiveEvent[] = [];
    const svc = mkService(dir, events);
    const p = svc.createProject(plan(dir, { writablePaths: ['docs'] }));
    svc.loadAgentTemplates(p.id);
    const m0 = await svc.startMission(p.id, '키 sk-ant-api03-MISSIONFAKEFAKE1234 를 쓰지 말고 문서를 정리하라');
    await waitMission(svc, m0.id, ['done', 'waiting_user', 'failed']);
    const dump = JSON.stringify(events.filter((e) => e.type === 'mission' || e.type === 'missionEvent')) + JSON.stringify(svc.missions.list(p.id)) + JSON.stringify(svc.missions.detail(m0.id).mission);
    expect(dump).not.toContain('MISSIONFAKE');
    svc.close();
  });
});

describe('운영 루프와 사용자 흐름 분리', () => {
  it('미션 사이클 흐름은 사용자가 편집하는 흐름의 최신 버전을 가리지 않는다', async () => {
    const { svc, p } = setup();
    svc.loadAgentTemplates(p.id);
    const mine = svc.saveGraph(p.id, svc.defaultGraph(p.id), '내 흐름').version!;
    const m0 = await svc.startMission(p.id, '문서를 정리하라');
    await waitMission(svc, m0.id, ['done', 'waiting_user', 'failed']);
    expect(svc.store.latestGraph(p.id)!.id).toBe(mine.id);
    expect(svc.store.listGraphVersions(p.id).length).toBeGreaterThan(1); // 미션 흐름도 기록은 남는다
    svc.close();
  });
});

describe('운영 지시 필수 항목', () => {
  it('목표·완료 조건·수정 허용 경로·직원이 없으면 지시를 받지 않고, 빠진 항목을 알려 준다', async () => {
    const dir = tmpProject(); const svc = mkService(dir);
    const p = svc.createProject(plan(dir, { goal: '', doneCriteria: '', writablePaths: [] }));
    const r = await svc.missionReadiness(p.id);
    expect(r.ready).toBe(false);
    expect(r.items.filter((i) => !i.ok).map((i) => i.key).sort()).toEqual(['done', 'git', 'goal', 'operator', 'team', 'writable']);
    await expect(svc.startMission(p.id, '문서를 정리하라')).rejects.toThrow('지시하려면 먼저 설정하세요');
    expect(svc.missions.list(p.id)).toEqual([]);
    svc.updatePlan(p.id, { ...p.plan, goal: '목표', doneCriteria: '완료 조건', writablePaths: ['docs'] });
    svc.loadAgentTemplates(p.id); gitInit(dir);
    expect((await svc.missionReadiness(p.id)).ready).toBe(true);
    svc.close();
  });
});

describe('미션 단일 실행·추가 지시', () => {
  it('미션이 작동 중이면 다른 프로젝트·같은 프로젝트 모두 새 지시를 받지 않고, 중단 뒤에는 받는다', async () => {
    const { svc, p } = setup();
    const dir2 = tmpProject(); gitInit(dir2);
    const p2 = svc.createProject(plan(dir2, { writablePaths: ['docs'] })); svc.loadAgentTemplates(p2.id);
    const m0 = await svc.startMission(p.id, '[[mock:hang]] 문서를 정리하라');
    await expect(svc.startMission(p2.id, '다른 일')).rejects.toThrow('미션은 한 번에 하나만');
    await expect(svc.startMission(p.id, '또 다른 일')).rejects.toThrow('추가 지시하거나 종료');
    const r = await svc.missionReadiness(p2.id);
    expect(r.activeMission?.id).toBe(m0.id);
    expect(r.items.find((i) => i.key === 'single')?.ok).toBe(false);
    await svc.missions.stop(m0.id);
    expect((await svc.missionReadiness(p2.id)).activeMission).toBeNull();
    const m2 = await svc.startMission(p2.id, '문서를 정리하라');
    await waitMission(svc, m2.id, ['done', 'waiting_user']);
    svc.close();
  });

  it("'지금 반영' 추가 지시는 진행 중인 실행을 실제로 멈추고, 지시를 반영해 다음 사이클을 바로 계획한다", async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:hang]] 문서를 정리하라');
    let run1: string | null = null;
    for (let i = 0; i < 400 && !run1; i++) { await sleep(25); const m = svc.missions.get(m0.id); if (m.currentRunId && svc.store.runAttempts(m.currentRunId).some((a) => a.pid)) run1 = m.currentRunId; }
    expect(run1).not.toBeNull();
    await svc.missions.addDirective(m0.id, '표 대신 목록으로 정리하라', 'now');
    let run2: string | null = null;
    for (let i = 0; i < 400 && !run2; i++) { await sleep(25); const m = svc.missions.get(m0.id); if (m.currentRunId && m.currentRunId !== run1) run2 = m.currentRunId; }
    expect(svc.store.getRun(run1!).status).toBe('cancelled');
    expect(run2).not.toBeNull();
    const m = svc.missions.get(m0.id);
    expect(m.cycle).toBe(2);
    const ev = svc.missions.events(m0.id);
    expect(ev.some((e) => e.kind === 'directive' && e.text.includes('목록으로'))).toBe(true);
    expect(ev.filter((e) => e.kind === 'operator_plan').length).toBe(2);
    expect(ev.some((e) => e.kind === 'operator_judge')).toBe(false); // 1사이클 판단을 건너뛰고 다시 계획
    await expect(svc.missions.addDirective(m0.id, '', 'next')).rejects.toThrow('입력하세요');
    await svc.missions.stop(m0.id);
    await expect(svc.missions.addDirective(m0.id, '더 하라', 'next')).rejects.toThrow('작동 중인 미션에만');
    svc.close();
  });
});

describe('git: 직원별 커밋·스냅샷·되돌리기', () => {
  it('직원이 만든 변경만 그 직원 이름으로 커밋하고, 미션 시작·사이클마다 스냅샷을 남기며, 사용자의 다른 변경은 건드리지 않는다', async () => {
    const { dir, svc, p } = setup();
    const g = (...a: string[]) => require('node:child_process').execFileSync('git', ['-C', dir, ...a]).toString();
    require('node:fs').writeFileSync(join(dir, 'user-wip.txt'), '사용자가 작업 중인 파일');
    const m0 = await svc.startMission(p.id, '[[mock:todo-first]] 문서를 정리하라');
    await waitMission(svc, m0.id, ['done', 'waiting_user', 'failed']);
    const log = g('log', '--format=%an|%s');
    expect(log).toMatch(/CREWGENAI 00 총괄\|\[CREWGENAI\] 00 총괄 · 문서 작성 1/);
    expect(log).toContain('CREWGENAI Codex 리뷰|');
    expect(log).toContain('CREWGENAI 00 총괄(결과물 취합)|');
    expect(g('log', '-1', '--format=%B', '--grep=Crewgenai-Mission')).toContain(`Crewgenai-Mission: ${m0.id}`);
    expect(g('status', '--porcelain')).toContain('?? user-wip.txt'); // 사용자 파일은 커밋되지 않음
    const snaps = await svc.missions.snapshots(m0.id);
    expect(snaps.map((s) => s.tag.split('/').pop())).toEqual(['start', 'cycle-1', 'cycle-2']);
    expect(g('tag', '--list', 'crewgenai/*').split('\n').filter(Boolean).length).toBe(3);
    const atts = svc.engine.detail(svc.missions.detail(m0.id).cycles[0].runId).attempts.filter((a) => a.role === 'author');
    expect(atts.every((a) => !!a.commitSha)).toBe(true);
    svc.close();
  });

  it('스냅샷 시점으로 되돌리면 그 이후 미션 커밋만 revert하고 기록은 남긴다. 작동 중에는 거부한다', async () => {
    const { dir, svc, p } = setup();
    const g = (...a: string[]) => require('node:child_process').execFileSync('git', ['-C', dir, ...a]).toString();
    const m0 = await svc.startMission(p.id, '문서를 정리하라');
    await waitMission(svc, m0.id, ['done', 'waiting_user', 'failed']);
    expect(existsSync(join(dir, 'docs/mission/cycle-2.md'))).toBe(true);
    const snaps = await svc.missions.snapshots(m0.id);
    const c1 = snaps.find((s) => s.tag.endsWith('cycle-1'))!;
    expect(c1.commitsAfter.length).toBeGreaterThan(0);
    const before = g('rev-list', '--count', 'HEAD');
    const r = await svc.missions.rollback(m0.id, c1.tag);
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, 'docs/mission/cycle-2.md'))).toBe(false); // 사이클 2 결과가 사라짐
    expect(existsSync(join(dir, 'docs/mission/cycle-1.md'))).toBe(true);  // 사이클 1 결과는 유지
    expect(Number(g('rev-list', '--count', 'HEAD'))).toBe(Number(before) + r.reverted.length); // 기록 보존(revert 커밋 추가)
    expect(svc.missions.events(m0.id).some((e) => e.text.includes('되돌리기'))).toBe(true);
    // 작동 중 거부
    svc.missions.answer(m0.id, '', 'stop');
    const m1 = await svc.startMission(p.id, '[[mock:hang]] 다른 일');
    await sleep(300);
    await expect(svc.missions.rollback(m1.id, 'x')).rejects.toThrow('먼저 중단');
    await svc.missions.stop(m1.id);
    svc.close();
  });
});

describe('git 안전장치(Codex 6차)', () => {
  const sh = (dir: string) => (...a: string[]) => require('node:child_process').execFileSync('git', ['-C', dir, ...a]).toString();

  it('사용자가 미리 바꿔 둔 파일을 직원이 수정하면 자동 커밋하지 않고 이유를 남긴다', async () => {
    const { dir, svc, p } = setup();
    const g = sh(dir); const fs = require('node:fs');
    fs.mkdirSync(join(dir, 'docs/mission'), { recursive: true });
    fs.writeFileSync(join(dir, 'docs/mission/cycle-1.md'), '원본\n'); g('add', '-A'); g('commit', '-q', '-m', '원본 추가');
    fs.writeFileSync(join(dir, 'docs/mission/cycle-1.md'), '사용자가 고치는 중\n'); // 미커밋 사용자 변경
    const m0 = await svc.startMission(p.id, '문서를 정리하라');
    await waitMission(svc, m0.id, ['done', 'waiting_user', 'failed']);
    expect(g('log', '--format=%an', '--', 'docs/mission/cycle-1.md')).not.toContain('CREWGENAI');
    const a = svc.engine.detail(svc.missions.detail(m0.id).cycles[0].runId).attempts.find((x) => x.role === 'author')!;
    expect(a.commitSha ?? null).toBeNull();
    expect(a.commitNote).toContain('사용자 미커밋 변경');
    expect(g('log', '--format=%an', '--', 'docs/mission/cycle-2.md')).toContain('CREWGENAI'); // 사용자 변경이 없던 파일은 커밋
    svc.close();
  });

  it('경로는 문자 그대로 해석해 다른 파일을 함께 커밋하지 않는다', async () => {
    const dir = tmpProject(); const g = gitInit(dir); const fs = require('node:fs');
    fs.mkdirSync(join(dir, 'docs'), { recursive: true });
    // Windows판: 파일 이름에 *를 쓸 수 없어 [a](글롭이면 a.md에도 일치)로 시험한다
    fs.writeFileSync(join(dir, 'docs/a.md'), '사용자 문서'); g('add', '-A'); g('commit', '-q', '-m', 'other');
    fs.writeFileSync(join(dir, 'docs/a.md'), '사용자 수정 중');
    fs.writeFileSync(join(dir, 'docs/[a].md'), '이름에 대괄호가 있는 파일');
    const { commitPaths } = await import('../src/main/git');
    const r = await commitPaths(dir, ['docs/[a].md'], { name: 'CREWGENAI 01 시험', email: 'a@b' }, '시험', {});
    expect(r.sha).not.toBeNull();
    expect(g('show', '--name-only', '--format=', 'HEAD').trim()).toBe('docs/[a].md');
    expect(g('status', '--porcelain')).toContain(' M docs/a.md');
  });

  it("다른 미션이 작동 중이면 확인 대기 미션에 '계속'으로 답해도 진행하지 않는다", async () => {
    const { svc, p } = setup();
    const dir2 = tmpProject(); gitInit(dir2);
    const p2 = svc.createProject(plan(dir2, { writablePaths: ['docs'] })); svc.loadAgentTemplates(p2.id);
    const a = await svc.startMission(p.id, '[[mock:ask]] 문서를 정리하라');
    await waitMission(svc, a.id, ['waiting_user']);
    const b = await svc.startMission(p2.id, '[[mock:hang]] 다른 일'); // A는 대기라 다른 프로젝트 시작 가능
    await sleep(200);
    expect(() => svc.missions.answer(a.id, 'docs 기준', 'continue')).toThrow('한 번에 하나만');
    expect(svc.missions.get(a.id).status).toBe('waiting_user');
    await svc.missions.stop(b.id);
    svc.close();
  });

  it('되돌리기가 충돌하면 아무것도 바꾸지 않고 그 사실을 알린다', async () => {
    const dir = tmpProject(); const g = gitInit(dir); const fs = require('node:fs');
    const { revertCommits } = await import('../src/main/git');
    fs.writeFileSync(join(dir, 'a.txt'), '1\n'); g('add', '-A'); g('commit', '-q', '-m', 'm1');
    const c1 = g('rev-parse', 'HEAD').trim();
    fs.writeFileSync(join(dir, 'a.txt'), '2\n'); g('commit', '-qam', 'user'); // 같은 줄을 사용자가 다시 바꿈 → c1 revert 충돌
    const head = g('rev-parse', 'HEAD').trim();
    const r = await revertCommits(dir, [c1]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('충돌');
    expect(g('rev-parse', 'HEAD').trim()).toBe(head);
    expect(g('status', '--porcelain').trim()).toBe('');
  });

  it('커밋이 하나도 없는 저장소는 지시 준비가 되지 않은 것으로 본다', async () => {
    const dir = tmpProject(); const svc = mkService(dir);
    require('node:child_process').execFileSync('git', ['-C', dir, 'init', '-q']);
    const p = svc.createProject(plan(dir, { writablePaths: ['docs'] })); svc.loadAgentTemplates(p.id);
    const it = (await svc.missionReadiness(p.id)).items.find((i) => i.key === 'git')!;
    expect(it.ok).toBe(false); expect(it.detail).toContain('첫 커밋');
    svc.close();
  });
});

describe('중단한 미션 이어서 다시 시작', () => {
  it('같은 미션에서 다음 사이클부터 다시 계획하고 기록을 이어받으며, 다른 미션이 작동 중이면 거부한다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:hang]] 문서를 정리하라');
    for (let i = 0; i < 400; i++) { await sleep(25); const m = svc.missions.get(m0.id); if (m.currentRunId && svc.store.runAttempts(m.currentRunId).some((a) => a.pid)) break; }
    await svc.missions.stop(m0.id);
    expect(svc.missions.get(m0.id).status).toBe('stopped');
    // 다른 프로젝트 미션이 작동 중이면 거부
    const dir2 = tmpProject(); gitInit(dir2);
    const p2 = svc.createProject(plan(dir2, { writablePaths: ['docs'] })); svc.loadAgentTemplates(p2.id);
    const other = await svc.startMission(p2.id, '[[mock:hang]] 다른 일');
    expect(() => svc.missions.answer(m0.id, '', 'continue')).toThrow('한 번에 하나만');
    await svc.missions.stop(other.id);
    // 이어서 다시 시작
    svc.missions.answer(m0.id, '이번에는 목록으로 정리하라', 'continue');
    let m = svc.missions.get(m0.id);
    for (let i = 0; i < 400 && !(m.currentRunId && m.cycle === 2); i++) { await sleep(25); m = svc.missions.get(m0.id); }
    expect(m.cycle).toBe(2);
    expect(['planning', 'running']).toContain(m.status);
    const ev = svc.missions.events(m0.id);
    expect(ev.some((e) => e.kind === 'directive' && e.text.includes('목록으로'))).toBe(true);
    expect(ev.some((e) => e.text.includes('이어서 다시 시작'))).toBe(true);
    expect(svc.missions.detail(m0.id).cycles.map((c) => c.status)[0]).toBe('cancelled'); // 중단된 사이클은 다시 하지 않음
    await svc.missions.stop(m0.id);
    svc.close();
  });
});
