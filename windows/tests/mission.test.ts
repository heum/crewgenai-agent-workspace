// 운영(오퍼레이터 루프) 시험 — 모의 Claude·모의 Codex 사용
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Mission } from '../src/shared/types';
import { gitInit, mkService, plan, sleep, tmpProject } from './helpers';
import { buildCheckpoint, cleanLimits, collectStaffAsks } from '../src/main/mission';

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
  it('참여 직원만 배정, 사용량 기록, 실행 준비 확인 기록', async () => {
    const { svc, p } = setup();
    svc.saveSettings({ missionMaxCycles: 1 });
    const ags = svc.store.listAgents(p.id).filter((a) => a.active && a.code !== '00');
    const writer = ags.find((a) => a.tools.includes('Edit') || a.tools.includes('Write'))!;
    const reader = ags.find((a) => !a.tools.includes('Edit') && !a.tools.includes('Write'))!;
    const m0 = await svc.startMission(p.id, '문서를 정리하라', { staff: [writer.id, reader.id, 'unknown'] });
    expect(m0.limits).toEqual({ staff: [writer.id, reader.id] });
    // 고른 직원을 하나도 찾지 못하면 제한을 풀지 않고 거절한다
    expect(() => cleanLimits({ staff: ['gone'] }, ags)).toThrow('참여 직원');
    const w = await waitMission(svc, m0.id, ['done', 'failed']);
    const ev = svc.missions.events(w.id);
    expect(ev.some((e) => e.kind === 'system' && e.text.startsWith('실행 준비 확인'))).toBe(true);
    svc.close();
  });

  it('(참여 직원 시험 이어서)', async () => {
    const { svc, p } = setup();
    svc.saveSettings({ missionMaxCycles: 1 });
    const ags = svc.store.listAgents(p.id).filter((a) => a.active && a.code !== '00');
    const writer = ags.find((a) => a.tools.includes('Edit') || a.tools.includes('Write'))!;
    const reader = ags.find((a) => !a.tools.includes('Edit') && !a.tools.includes('Write'))!;
    const m0 = await svc.startMission(p.id, '문서를 정리하라', { staff: [writer.id, reader.id] });
    const w = await waitMission(svc, m0.id, ['done', 'failed']);
    const allowed = new Set([writer.id, reader.id, svc.store.listAgents(p.id).find((a) => a.code === '00')!.id]);
    for (const c of svc.missions.detail(w.id).cycles) for (const a of svc.engine.detail(c.runId).attempts.filter((x) => x.role !== 'codex')) expect(allowed.has(a.agentId ?? '')).toBe(true);
    expect(w.usage!.calls).toBeGreaterThan(0);
    svc.close();
  });

  it('실행 준비 확인에서 막히면(구현 담당 없음) 직원에게 작업을 배정하지 않고 막힌 것을 보고한다', async () => {
    const { svc, p } = setup();
    const reader = svc.store.listAgents(p.id).find((a) => a.active && a.code !== '00' && !a.tools.includes('Edit') && !a.tools.includes('Write'))!;
    const m0 = await svc.startMission(p.id, '문서를 정리하라', { staff: [reader.id] });
    const w = await waitMission(svc, m0.id, ['waiting_user', 'done', 'failed']);
    expect(w.checkpoint?.reason).toBe('blocked');
    expect(w.checkpoint?.blocked?.[0]).toContain('구현 담당');
    expect(svc.missions.detail(w.id).cycles.length).toBe(0);
    expect(svc.missions.events(w.id).some((e) => e.kind === 'operator_plan')).toBe(false);
    svc.close();
  });

  it('지시 → 계획 → 수행 → Codex 리뷰 → Claude 재검토(재작업) → 판단(계속) → 다음 사이클 → 완료 보고', async () => {
    const { dir, svc, p } = setup();
    svc.saveSettings({ reviewMode: 'full' }); // 작업마다 Codex 리뷰 + 재검토(예전 방식)
    const m0 = await svc.startMission(p.id, '[[mock:todo-first]] [[mock:code]] 사이클마다 문서를 정리하라');
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

  it('기본 검증 방식: 작업마다 Codex 리뷰를 붙이지 않고, 닫을 때 다른 직원의 검증 한 번(실패하면 재작업)', async () => {
    const { dir, svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:todo-first]] [[mock:code]] 문서를 정리하라');
    const m = await waitMission(svc, m0.id, ['done', 'waiting_user', 'failed']);
    expect(m.status).toBe('done');
    const r1 = svc.engine.detail(svc.missions.detail(m.id).cycles[0].runId);
    // Codex 리뷰는 작업마다가 아니라 사이클에 하나(바뀐 코드 전체)
    expect(r1.graph.nodes.filter((n) => n.kind === 'codexReview').map((n) => !!n.cycleReview)).toEqual([true]);
    expect(r1.graph.nodes.filter((n) => n.kind === 'review').map((n) => n.label.startsWith('검증: '))).toEqual([true]);
    expect(r1.attempts.filter((a) => a.role === 'codex').length).toBe(1);
    expect(r1.reviews.filter((r) => r.kind === 'codex').length).toBe(1);
    expect(r1.artifacts.some((a) => a.relPath.includes('reviews/codex-'))).toBe(true);
    expect(r1.reviews.filter((r) => r.kind === 'agent').map((r) => r.verdict)).toEqual(['changes_requested', 'approve']);
    expect(r1.attempts.filter((a) => a.role === 'author').length).toBe(2);
    expect(readFileSync(join(dir, 'docs/mission/cycle-1.md'), 'utf8')).toContain('FIXED');
    svc.close();
  });

  it("검증이 '작성자가 고칠 수 없음'으로 판정하면 재작업시키지 않고 바로 보류해 확인함에 올린다", async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:code]] [[mock:blocked-env]] 문서를 정리하라');
    // 사이클이 끝나기를 기다리지 않고, 검증 직후에 보류 항목이 생긴다
    const withBlocker = await (async () => { for (let i = 0; i < 1200; i++) { const x = svc.missions.get(m0.id); if (x.blockers?.length) return x; await sleep(50); } throw new Error('보류 항목이 생기지 않음'); })();
    expect(withBlocker.blockers![0].kind).toBe('needs_user');
    expect(withBlocker.blockers![0].reason).toContain('막힘(작성자가 고칠 수 없음): 시연 DB를 쥐고 있는 예전 서버를 정리해야 합니다');
    const runId = svc.missions.detail(m0.id).cycles[0].runId;
    const m = await waitMission(svc, m0.id, ['done', 'waiting_user', 'failed', 'stopped']);
    const r1 = svc.engine.detail(runId);
    expect(r1.attempts.filter((a) => a.role === 'author').length).toBe(1); // 같은 작성자에게 다시 시키지 않았다
    expect(r1.attempts.filter((a) => a.role === 'reviewer').length).toBe(1);
    expect(r1.reviews.filter((r) => r.kind === 'agent').map((r) => r.verdict)).toEqual(['changes_requested']);
    const item = svc.pendingDecisions().find((x) => x.kind === 'blocker' && x.missionId === m0.id);
    expect(item?.urgent).toBe(true);
    expect(item?.explain).toContain('[결정·조치 필요]');
    expect(svc.missions.get(m0.id).blockers!.filter((b) => b.kind === 'needs_user').length).toBe(1); // 사이클 끝 정리에서 중복으로 늘지 않는다
    if (!['stopped', 'done', 'failed'].includes(m.status)) await svc.missions.stop(m0.id);
    svc.close();
  });

  it('문서만 바꾼 작업은 Codex 리뷰와 재검토를 건너뛴다(코드·시험을 바꾸면 리뷰한다)', async () => {
    const { validate } = { validate: await import('../src/main/engine/validate') };
    expect(validate.docsOnly(['docs/STATUS.md', 'docs/screens/a.png'])).toBe(true);
    expect(validate.docsOnly(['docs/STATUS.md', 'src/app/page.tsx'])).toBe(false);
    expect(validate.docsOnly(['docs/a.md', 'tests/a.test.ts'])).toBe(false);
    expect(validate.docsOnly(['docs/result.json'])).toBe(false);
    expect(validate.docsOnly([])).toBe(false); // 바뀐 파일을 모르면 리뷰한다
    for (const f of ['src/.tmp/live.ts', 'CMakeLists.txt', 'requirements.txt', 'data/prices.csv', 'docs/run.log', 'AGENTS.md', 'skills/x/SKILL.md', '.github/pull_request_template.md', '.claude/commands/a.md', 'docs/.tmp/a.md', 'src/handler.md', 'README.md', 'skills/x/references/instructions.md', 'docs/prompts/a.md', 'docs/AGENTS.override.md', 'docs/CLAUDE.local.md'])
      expect(validate.docsOnly([f]), f).toBe(false);
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '문서를 정리하라');
    const m = await waitMission(svc, m0.id, ['done', 'waiting_user', 'failed']);
    expect(m.status).toBe('done');
    const r1 = svc.engine.detail(svc.missions.detail(m.id).cycles[0].runId);
    expect(r1.attempts.filter((a) => a.role === 'author').length).toBe(1);
    expect(r1.attempts.filter((a) => a.role === 'codex' || a.role === 'reviewer').length).toBe(0);
    expect(r1.reviews.length).toBe(0);
    const skipped = r1.graph.nodes.filter((n) => n.kind === 'codexReview' || n.kind === 'review').map((n) => r1.nodes.find((x) => x.nodeId === n.id));
    expect(skipped.length).toBe(2); // 검증 단계와 사이클 Codex 리뷰 둘 다 건너뛴다(바뀐 코드 없음)
    for (const n of skipped) { expect(n?.status).toBe('succeeded'); expect(n?.summary).toContain('건너뜀'); }
    // 검사 단계 뒤에 있는 다른 작성 단계까지 거슬러 올라가 본다: 그 단계가 무엇을 바꿨는지 모르면 건너뛰지 않는다
    const rv = r1.graph.nodes.find((n) => n.kind === 'review')!; const au = r1.graph.nodes.find((n) => n.kind === 'agent')!;
    const eng = svc.engine as unknown as { lightSkip: (runId: string, g: unknown, n: unknown, up: string[]) => unknown };
    const runId = svc.missions.detail(m.id).cycles[0].runId;
    expect(eng.lightSkip(runId, r1.graph, rv, [])).not.toBeNull();
    const other = { ...au, id: 'other-author' }; const ck = { ...au, id: 'other-check', kind: 'check' };
    const mixed = { nodes: [...r1.graph.nodes, other, ck], edges: [...r1.graph.edges, { id: 'x1', source: 'other-author', target: 'other-check', kind: 'next' }, { id: 'x2', source: 'other-check', target: rv.id, kind: 'next' }] };
    expect(eng.lightSkip(runId, mixed, rv, [])).toBeNull();
    // 작성 단계 앞에 리뷰 없이 이어진 다른 작성 단계도 본다(A → B → 검증)
    const chain = { nodes: [...r1.graph.nodes, other], edges: [...r1.graph.edges, { id: 'x3', source: 'other-author', target: au.id, kind: 'next' }] };
    expect(eng.lightSkip(runId, chain, rv, [])).toBeNull();
    // 실패 연결로 들어오는 작성 단계도 본다
    const failIn = { nodes: [...r1.graph.nodes, other], edges: [...r1.graph.edges, { id: 'x4', source: 'other-author', target: rv.id, kind: 'fail' }] };
    expect(eng.lightSkip(runId, failIn, rv, [])).toBeNull();
    // 앞 작성 단계 뒤에 리뷰 단계가 있어도 멈추지 않는다: 리뷰 단계가 있다고 승인된 것은 아니다(A → 리뷰A → B → 검증)
    const rvA = { ...rv, id: 'other-review' };
    const reviewed = { nodes: [...r1.graph.nodes, other, rvA], edges: [...r1.graph.edges, { id: 'x5', source: 'other-author', target: 'other-review', kind: 'next' }, { id: 'x6', source: 'other-review', target: au.id, kind: 'next' }] };
    expect(eng.lightSkip(runId, reviewed, rv, [])).toBeNull();
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

  it('정기 결과 보고(검토 지점)는 확인함에 올리고 멈추지 않는다. 경과 사이클 수만으로 미션이 멈추지 않는다', async () => {
    const { svc, p } = setup();
    svc.saveSettings({ missionMaxCycles: 1 });
    const m0 = await svc.startMission(p.id, '문서를 정리하라');
    const m = await waitMission(svc, m0.id, ['done', 'waiting_user', 'failed']);
    expect(m.status).toBe('done'); // 사용자 답 없이 끝까지 진행
    expect(m.cycle).toBe(2);
    expect(svc.missions.events(m.id).some((e) => e.kind === 'system' && e.text.includes('확인함에 올렸습니다'))).toBe(true);
    expect(svc.missions.events(m.id).some((e) => e.kind === 'question' && e.text.includes('검토 지점'))).toBe(false);
    svc.close();
  });

  it('검토 카드: 결과·시연 순서·검증 범위·결정·가정을 한곳에 두고, 기다리지 않고 개발을 이어 가며, 나중에 고른 결정·피드백이 다음 사이클에 반영된다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:review]] 회사 관리 화면을 만들어라');
    let cp = null as Mission['checkpoint'];
    for (let i = 0; i < 2400 && !cp; i++) { await sleep(25); cp = svc.missions.get(m0.id).checkpoint ?? null; }
    expect(cp?.reason).toBe('ready');
    expect(cp?.features[0].status).toBe('reviewable');
    expect(cp?.decisions.length).toBe(1);
    expect(cp?.assumptions).toContain('메모는 최대 500자로 가정');
    const done = await waitMission(svc, m0.id, ['done', 'waiting_user', 'failed']);
    expect(done.status).toBe('done'); // 검토를 기다리지 않고 진행
    const c = done.checkpoint!;
    svc.missions.review(done.id, [{ doc: c.decisions[0].doc, question: c.decisions[0].question, choice: '2차로 미룬다' }], '목록 맨 위에 검색창을 두세요', 'continue');
    const m = await waitMission(svc, done.id, ['done', 'failed']);
    expect(m.status).toBe('done');
    expect(m.decisions?.some((d) => d.doc === '검토 지점' && d.choice === '2차로 미룬다')).toBe(true);
    expect(svc.missions.events(m.id).some((e) => e.kind === 'directive' && e.text.includes('검색창'))).toBe(true);
    svc.close();
  });

  it('진행 중에 검토 카드에 답하면 멈추지 않고 다음 계획부터 반영한다(답하지 않은 결정은 미결로 남음)', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:hang]] 회사 관리 화면을 만들어라');
    for (let i = 0; i < 400 && svc.missions.get(m0.id).status !== 'running'; i++) await sleep(25);
    // 실행 중인 미션에 이전 사이클의 검토 카드가 올라와 있는 상태
    const cp = buildCheckpoint({ title: '회사 관리', decisions: [{ question: '삭제 기능을 1차에 넣을까요?', choices: [{ label: '넣는다', effect: '', recommended: false, why: '' }] }] }, 1, [], [], [], 'ready', 'x');
    (svc.missions as unknown as { save: (m: object) => void }).save({ ...svc.missions.get(m0.id), checkpoint: cp });
    svc.missions.review(m0.id, [], '버튼 문구를 짧게', 'continue');
    const m = svc.missions.get(m0.id);
    expect(['running', 'planning', 'evaluating']).toContain(m.status); // 멈추지 않음
    expect(m.checkpoint).toBeNull();
    expect(m.gaps?.some((g) => g.issue === '삭제 기능을 1차에 넣을까요?')).toBe(true);
    expect(svc.missions.events(m.id).some((e) => e.kind === 'directive' && e.text.includes('버튼 문구'))).toBe(true);
    await svc.missions.stop(m0.id);
    svc.close();
  });

  it('정기 검토 카드가 남아 있어도 미션을 멈춘 새 질문은 확인함과 미션 화면에 따로 보인다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:hang]] 문서를 정리하라');
    await svc.missions.stop(m0.id);
    const cp = buildCheckpoint({ title: '정기 보고' }, 1, [], [], [], 'budget', 'x');
    (svc.missions as unknown as { save: (m: object) => void }).save({ ...svc.missions.get(m0.id), status: 'waiting_user', checkpoint: cp, question: '어느 저장소를 기준으로 할까요?', questionOptions: ['A', 'B'] });
    const items = svc.pendingDecisions().filter((d) => d.missionId === m0.id);
    expect(items.find((d) => d.kind === 'question')?.urgent).toBe(true);
    expect(items.find((d) => d.kind === 'checkpoint')?.urgent).toBe(false);
    // 정기 카드에 답해도 기다리던 질문을 건너뛰고 진행하지 않는다
    svc.missions.review(m0.id, [], '좋아요', 'continue');
    expect(svc.missions.get(m0.id).status).toBe('waiting_user');
    expect(svc.missions.get(m0.id).question).toBe('어느 저장소를 기준으로 할까요?');
    svc.close();
  });

  it('실행이 끝난 뒤 판단 전에 앱이 꺼지면, 다시 켤 때 같은 사이클을 다시 계획·실행하지 않고 판단부터 이어 간다(사용량 중복 없음)', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '문서를 정리하라');
    const done = await waitMission(svc, m0.id, ['done', 'waiting_user', 'failed']);
    const run1 = svc.missions.detail(done.id).cycles[0].runId;
    const calls = done.usage!.calls; const plans = svc.missions.events(done.id).filter((e) => e.kind === 'operator_plan').length;
    const authors1 = svc.engine.detail(run1).attempts.filter((a) => a.role === 'author').length;
    // 사이클 1 실행 직후(판단 전) 상태로 되돌려 재시작을 흉내 낸다
    (svc.missions as unknown as { save: (m: object) => void }).save({ ...svc.missions.get(done.id), status: 'evaluating', cycle: 1, currentRunId: run1 });
    const file = svc.store.file; svc.close();
    const { Service } = await import('../src/main/service');
    const { MOCK, MOCK_CODEX } = await import('./helpers');
    const re = new Service({ dbFile: file, mockScript: MOCK, mockCodexScript: MOCK_CODEX, emit: () => {} });
    re.saveSettings({ executor: 'mock' });
    await re.engine.recoverOnStartup(); await re.missions.recoverProcesses(); re.missions.recoverOnStartup();
    for (let i = 0; i < 400 && re.missions.get(done.id).cycle === 1; i++) await sleep(25);
    expect(re.engine.detail(run1).attempts.filter((a) => a.role === 'author').length).toBe(authors1); // 끝난 실행을 다시 돌리지 않음
    expect(plans).toBeGreaterThan(0);
    expect(re.missions.events(done.id).filter((e) => e.kind === 'operator_plan' && e.cycle === 1).length).toBe(1); // 사이클 1을 다시 계획하지 않음
    expect(re.missions.events(done.id).filter((e) => e.kind === 'cycle_end' && e.cycle === 1).length).toBe(1); // 종료 기록·사용량 중복 없음
    expect(re.missions.get(done.id).usage!.calls).toBeGreaterThan(calls); // 판단 호출만 더해짐
    await re.missions.stop(done.id);
    re.close();
  });

  it('되돌리기 쉬운 세부는 묻지 않고 가정하고 진행하며, 사람이 정할 결정은 진행 중 팝업으로 띄우지 않는다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:assume]] [[mock:hang]] 화면을 만들어라');
    for (let i = 0; i < 400 && svc.missions.get(m0.id).status === 'planning'; i++) await sleep(25);
    const m = svc.missions.get(m0.id);
    expect(m.assumptions?.map((a) => a.text)).toContain('저장 버튼은 화면 오른쪽 위에 둔다');
    expect(m.gaps?.length).toBe(1); // 결정 항목은 남겨 두고
    const gapItems = svc.pendingDecisions().filter((d) => d.missionId === m.id && d.kind === 'gap');
    expect(gapItems.length).toBe(1); // 확인함에는 모아 두고
    expect(gapItems.some((d) => d.urgent)).toBe(false); // 진행 중에는 팝업(긴급)으로 띄우지 않는다
    expect(gapItems[0].held).toContain('나머지는 계속');
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

  it('앱 재시작 시 진행 중이던 미션은 다시 계획하지 않고 같은 사이클 실행을 이어서 진행한다. 사용자가 중지한 미션은 다시 돌지 않는다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:hang]] 문서를 정리하라');
    let runId: string | null = null;
    for (let i = 0; i < 400 && !runId; i++) { await sleep(25); const m = svc.missions.get(m0.id); if (m.currentRunId && svc.store.runAttempts(m.currentRunId).some((a) => a.pid)) runId = m.currentRunId; }
    expect(runId).not.toBeNull();
    const plans = svc.missions.events(m0.id).filter((e) => e.kind === 'operator_plan').length;
    const file = svc.store.file; svc.close();
    const { Service } = await import('../src/main/service');
    const { MOCK } = await import('./helpers');
    const re = new Service({ dbFile: file, mockScript: MOCK, emit: () => {} });
    await re.engine.recoverOnStartup(); await re.missions.recoverProcesses(); re.missions.recoverOnStartup();
    for (let i = 0; i < 200 && !re.engine.isActive(runId!); i++) await sleep(25);
    const m1 = re.missions.get(m0.id);
    expect(m1.status).toBe('running');
    expect(m1.currentRunId).toBe(runId); // 같은 실행을 이어 감(새 사이클·새 계획 없음)
    expect(re.engine.isActive(runId!)).toBe(true);
    expect(re.missions.events(m0.id).filter((e) => e.kind === 'operator_plan').length).toBe(plans);
    expect(re.missions.events(m0.id).some((e) => e.text.includes('멈춘 지점부터'))).toBe(true);
    expect(re.pendingDecisions().filter((d) => d.missionId === m0.id)).toEqual([]); // 사용자 결정이 아니므로 묻지 않는다
    // 사용자가 중지하면 다음 재시작에도 다시 돌지 않는다
    await re.missions.stop(m0.id);
    for (let i = 0; i < 200 && re.engine.isActive(runId!); i++) await sleep(25);
    const file2 = re.store.file; re.close();
    const re2 = new Service({ dbFile: file2, mockScript: MOCK, emit: () => {} });
    await re2.engine.recoverOnStartup(); await re2.missions.recoverProcesses(); re2.missions.recoverOnStartup();
    await sleep(300);
    expect(re2.missions.get(m0.id).status).toBe('stopped');
    expect(re2.engine.isActive(runId!)).toBe(false);
    re2.close();
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
    svc.saveSettings({ reviewMode: 'full' });
    const m0 = await svc.startMission(p.id, '[[mock:todo-first]] [[mock:code]] 문서를 정리하라');
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


describe('직원이 올린 결정 필요', () => {
  it('직원 보고와 검증 메모에서 결정이 필요하다고 적은 줄만 모으고 중복은 한 번만 넣는다', () => {
    const asks = collectStaffAsks([
      '## 수행 요약\n- 측정 도구: 도구가 없어 대체 도구로 측정했습니다.\n- 결정 필요: 화면 확인 도구를 설치할지, 지금 방식을 계속 인정할지 정해 주세요.',
      '완료 조건 4개 중 4개 통과\n- [후속] 화면 확인 도구를 설치할지 결정이 필요합니다.\n- [후속] 판정용 속성을 두는 쪽이 안전합니다.',
      '- [후속] 시연 데이터를 다음 시연 전에 정리할지 정해야 합니다.',
    ]);
    expect(asks).toEqual([
      '화면 확인 도구를 설치할지, 지금 방식을 계속 인정할지 정해 주세요.',
      '화면 확인 도구를 설치할지 결정이 필요합니다.',
      '시연 데이터를 다음 시연 전에 정리할지 정해야 합니다.',
    ]);
    expect(collectStaffAsks(['통과했습니다.', ''])).toEqual([]);
    expect(collectStaffAsks(['추가 결정이 필요하지 않습니다.', '- 결정은 필요 없습니다.'])).toEqual([]);
    expect(collectStaffAsks(['결정은 필요합니다: 설치 방식은 사용자에게 확인해야 합니다.'])).toEqual(['결정은 필요합니다: 설치 방식은 사용자에게 확인해야 합니다.']);
    expect(collectStaffAsks(Array.from({ length: 30 }, (_, i) => `- 결정 필요: 항목 ${i}번을 어떻게 할지 정해 주세요.`)).length).toBe(12);
  });
});
