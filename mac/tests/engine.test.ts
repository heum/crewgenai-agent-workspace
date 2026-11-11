// 실행 엔진 시험 — 모의 CLI 사용(실제 Claude 미사용). 실제 CLI 연결은 scripts/real-cli-check.mjs로 별도 검증한다.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LiveEvent, WorkGraph } from '../src/shared/types';
import { Service } from '../src/main/service';
import { alive, agentFields, e, mkService, n, plan, sleep, tmpProject, waitRun } from './helpers';

function setup(extraPlan = {}) {
  const dir = tmpProject();
  const events: LiveEvent[] = [];
  const svc = mkService(dir, events);
  const p = svc.createProject(plan(dir, extraPlan));
  return { dir, svc, p, events };
}

describe('1. 프로젝트 저장·재열기·기획 이력', () => {
  it('프로젝트를 저장하고 새 연결로 다시 열며, 기획 변경 이력을 남긴다', () => {
    const { dir, svc, p } = setup();
    svc.updatePlan(p.id, { ...p.plan, goal: '바뀐 목표 한글' });
    const file = svc.store.file; svc.close();
    const re = new Service({ dbFile: file, mockScript: '', emit: () => {} });
    const got = re.store.getProject(p.id);
    expect(got.plan.goal).toBe('바뀐 목표 한글');
    expect(got.plan.folder).toContain('프로젝트 폴더 A');
    const hist = re.store.planHistory(p.id);
    expect(hist.map((h) => h.version)).toEqual([2, 1]);
    expect(hist[0].changedFields).toEqual(['goal']);
    re.close();
  });
});

describe('2. 그래프 검사', () => {
  it('끊긴 단계·없는 담당·출력 계약 누락·잘못된 분기·무한 순환·동시 수정 충돌을 찾는다', () => {
    const { svc, p } = setup();
    const a = svc.saveAgent(p.id, null, agentFields('01', '작성자'));
    const inp = n('input', '입력');
    const w1 = n('agent', '작업1', { agentId: a.id, writeScope: ['docs'], outputs: [{ path: 'docs/a.md', format: 'markdown', required: true }] });
    const w2 = n('agent', '작업2', { agentId: a.id, writeScope: ['docs'], outputs: [{ path: 'docs/b.md', format: 'markdown', required: true }] });
    const ghost = n('agent', '유령', { agentId: 'none', outputs: [] });
    const lonely = n('check', '고립', { command: ['/bin/true'] });
    const br = n('branch', '분기');
    const c1 = n('check', '순환1', { command: ['/bin/true'] }); const c2 = n('check', '순환2', { command: ['/bin/true'] });
    const g: WorkGraph = { nodes: [inp, w1, w2, ghost, lonely, br, c1, c2], edges: [e(inp, w1), e(inp, w2), e(inp, ghost), e(w1, br), e(br, c1, 'next'), e(c1, c2), e(c2, c1)] };
    const codes = svc.validate(p.id, g).filter((i) => i.level === 'error').map((i) => i.code);
    for (const c of ['unreachable', 'missing_agent', 'no_output', 'no_condition', 'branch_arms', 'branch_next', 'cycle', 'write_conflict']) expect(codes).toContain(c);
    expect(svc.saveGraph(p.id, g, '').version).toBeNull();
  });
});

function linear(svc: ReturnType<typeof setup>['svc'], pid: string, opts: { marker?: string; check?: string[]; reviewer?: boolean; maxVisits?: number } = {}) {
  const w = svc.saveAgent(pid, null, agentFields('01', '작성자'));
  const r = svc.saveAgent(pid, null, agentFields('02', '검토자', { tools: ['Read', 'Grep', 'Glob'] }));
  const inp = n('input', '입력');
  const work = n('agent', '작성', { agentId: w.id, instructions: `작성하라 ${opts.marker ?? ''}`, writeScope: ['docs'], maxVisits: opts.maxVisits ?? 3, outputs: [{ path: 'docs/결과 문서.md', format: 'markdown', required: true }] });
  const nodes = [inp, work]; const edges = [e(inp, work)];
  let last = work;
  if (opts.check) { const c = n('check', '검사', { command: opts.check }); nodes.push(c); edges.push(e(last, c), e(c, work, 'fail')); last = c; }
  if (opts.reviewer) { const rv = n('review', '독립검토', { agentId: r.id, inputs: ['docs/결과 문서.md'] }); nodes.push(rv); edges.push(e(last, rv), e(rv, work, 'fail')); last = rv; }
  const m = n('merge', '취합'); const ur = n('userReview', '팀장 검토');
  nodes.push(m, ur); edges.push(e(last, m), e(m, ur), e(ur, work, 'fail'));
  const saved = svc.saveGraph(pid, { nodes, edges }, '시험');
  if (!saved.version) throw new Error(JSON.stringify(saved.issues));
  return { gv: saved.version, work, ur, w, r };
}

describe('3. 그래프와 실행 일치', () => {
  it('기본 흐름: 병렬 작업 → 검사 → 독립검토 → 통합 검사 → 취합 → 팀장 검토 순서로 실행하고 병렬 합류를 기다린다', async () => {
    const { svc, p } = setup();
    svc.loadAgentTemplates(p.id);
    const g = svc.defaultGraph(p.id);
    const saved = svc.saveGraph(p.id, g, '기본');
    expect(saved.issues.filter((i) => i.level === 'error')).toEqual([]);
    const run = await svc.startRun(p.id, saved.version!.id);
    // 실행 중 흐름을 수정해도 실행은 시작 당시 버전을 유지한다
    const g2 = structuredClone(g); g2.nodes[1].label = '수정된 라벨';
    const v2 = svc.saveGraph(p.id, g2, '수정').version!;
    expect(v2.version).toBe(2);
    await waitRun(svc, run.id, ['review_wait']);
    const d = svc.engine.detail(run.id);
    expect(d.run.graphVersionId).toBe(saved.version!.id);
    expect(d.graph.nodes[1].label).toBe('담당 작업 A');
    const label = (id: string) => g.nodes.find((x) => x.id === id)!.label;
    const at = (lbl: string) => d.attempts.filter((a) => label(a.nodeId) === lbl);
    const first = (lbl: string) => Date.parse(at(lbl)[0].startedAt);
    const end = (lbl: string) => Math.max(...at(lbl).map((a) => Date.parse(a.finishedAt!)));
    expect(end('담당 작업 A')).toBeLessThanOrEqual(first('자동 검사'));
    expect(end('자동 검사')).toBeLessThanOrEqual(first('독립 검토'));
    expect(end('독립 검토')).toBeLessThanOrEqual(first('통합 검사'));
    expect(end('담당 작업 B')).toBeLessThanOrEqual(first('통합 검사'));
    // 병렬: A와 B가 시간상 겹친다
    expect(first('담당 작업 B')).toBeLessThan(end('담당 작업 A'));
    expect(d.nodes.find((x) => label(x.nodeId) === '팀장 검토')!.status).toBe('review_wait');
    expect(d.deliverable).not.toBeNull();
    expect(existsSync(d.deliverable!.reportPath)).toBe(true);
    await svc.submitReview(run.id, d.nodes.find((x) => label(x.nodeId) === '팀장 검토')!.nodeId, 'approve', '좋습니다', null, d.currentSubjectHash!);
    const fin = await waitRun(svc, run.id, ['succeeded', 'failed']);
    expect(fin.status).toBe('succeeded');
    svc.close();
  });

  it('조건 분기: JSON 산출물 값에 따라 한쪽 경로만 실행한다', async () => {
    const { svc, p } = setup();
    const w = svc.saveAgent(p.id, null, agentFields('01', '작성자'));
    const inp = n('input', '입력');
    const work = n('agent', '판정', { agentId: w.id, writeScope: ['docs'], outputs: [{ path: 'docs/v.json', format: 'json', required: true }] });
    const br = n('branch', '분기', { condition: { sourceNodeId: work.id, field: 'json', jsonPath: 'status', equals: 'done' } });
    const yes = n('check', '참경로', { command: ['/usr/bin/true'] }); const no = n('check', '거짓경로', { command: ['/usr/bin/true'] });
    const saved = svc.saveGraph(p.id, { nodes: [inp, work, br, yes, no], edges: [e(inp, work), e(work, br), e(br, yes, 'true'), e(br, no, 'false')] }, '');
    expect(saved.version).not.toBeNull();
    const run = await svc.startRun(p.id, saved.version!.id);
    const fin = await waitRun(svc, run.id, ['succeeded', 'failed']);
    expect(fin.status).toBe('succeeded');
    const st = Object.fromEntries(svc.store.runNodes(run.id).map((x) => [x.nodeId, x.status]));
    expect(st[yes.id]).toBe('succeeded'); expect(st[no.id]).toBe('skipped');
    svc.close();
  });
});

describe('4. 자동 검사와 교차검토', () => {
  it('의도적으로 실패하는 검사는 완료 처리하지 않고 담당에게 재작업을 배정한다', async () => {
    const { dir, svc, p } = setup();
    writeFileSync(join(dir, 'check.cjs'), "const t=require('fs').readFileSync('docs/결과 문서.md','utf8');if(t.includes('TODO')){console.error('TODO 남음');process.exit(1)}");
    const { gv, work } = linear(svc, p.id, { marker: '[[mock:todo-first]]', check: [process.execPath, 'check.cjs'] });
    const run = await svc.startRun(p.id, gv.id);
    await waitRun(svc, run.id, ['review_wait', 'failed']);
    const d = svc.engine.detail(run.id);
    expect(d.checks.map((c) => c.ok)).toEqual([false, true]);
    const authors = d.attempts.filter((a) => a.nodeId === work.id && a.role === 'author');
    expect(authors.map((a) => a.visit)).toEqual([1, 2]);
    expect(readFileSync(join(dir, 'docs/결과 문서.md'), 'utf8')).toContain('FIXED');
    expect(d.nodes.find((x) => x.nodeId === work.id)!.visits).toBe(2);
    svc.close();
  });

  it('재작업 상한을 넘으면 실패로 끝나고 완료로 표시하지 않는다', async () => {
    const { svc, p } = setup();
    const { gv } = linear(svc, p.id, { check: ['/usr/bin/false'], maxVisits: 2 });
    const run = await svc.startRun(p.id, gv.id);
    const fin = await waitRun(svc, run.id, ['failed', 'succeeded', 'review_wait']);
    expect(fin.status).toBe('failed');
    expect(fin.reason).toContain('재작업 상한');
    expect(svc.store.checks(run.id).every((c) => !c.ok)).toBe(true);
    svc.close();
  });

  it('검사 파일을 실행 중 바꾸면(검사 약화) 통과로 처리하지 않는다', async () => {
    const { dir, svc, p } = setup();
    writeFileSync(join(dir, 'gate.cjs'), 'process.exit(1)');
    const { gv } = linear(svc, p.id, { marker: '[[mock:hang]]', check: [process.execPath, 'gate.cjs'] });
    const g = svc.store.getGraphVersion(gv.id).graph; g.nodes[1].timeoutSec = 2; g.nodes[1].maxRetries = 0; g.nodes[1].instructions = '작성하라';
    const v = svc.saveGraph(p.id, g, '').version!;
    const run = await svc.startRun(p.id, v.id);
    writeFileSync(join(dir, 'gate.cjs'), 'process.exit(0)'); // 실행 중 약화
    await waitRun(svc, run.id, ['failed', 'review_wait', 'succeeded']);
    const cks = svc.store.checks(run.id);
    expect(cks.length).toBeGreaterThan(0);
    expect(cks.every((c) => !c.ok)).toBe(true);
    expect(cks[0].output).toContain('검사 파일이 실행 중 변경');
    svc.close();
  });

  it('독립 검토자가 수정 요청하면 작성자에게 돌아가고 검토 기록이 남는다', async () => {
    const { svc, p } = setup();
    const { gv, work, r } = linear(svc, p.id, { marker: '[[mock:todo-first]]', reviewer: true });
    const run = await svc.startRun(p.id, gv.id);
    await waitRun(svc, run.id, ['review_wait', 'failed']);
    const rv = svc.store.reviews(run.id).filter((x) => x.kind === 'agent');
    expect(rv.map((x) => x.verdict)).toEqual(['changes_requested', 'approve']);
    expect(rv.every((x) => x.reviewerAgentId === r.id)).toBe(true);
    expect(svc.store.runAttempts(run.id).filter((a) => a.nodeId === work.id && a.role === 'author').length).toBe(2);
    // 검토자는 읽기 전용 도구만 받는다
    const revAttempt = svc.store.runAttempts(run.id).find((a) => a.role === 'reviewer')!;
    const ti = revAttempt.argvRedacted.indexOf('--tools');
    expect(revAttempt.argvRedacted[ti + 1]).toBe('Read,Grep,Glob');
    svc.close();
  });
});

describe('5. 취소·시간 초과·중복 방지·충돌 제어', () => {
  it('취소하면 실제 프로세스를 종료하고 실행을 취소 상태로 둔다', async () => {
    const { svc, p } = setup();
    const { gv, work } = linear(svc, p.id, { marker: '[[mock:hang]]' });
    const run = await svc.startRun(p.id, gv.id);
    let pid = 0;
    for (let i = 0; i < 100 && !pid; i++) { await sleep(50); pid = svc.store.runAttempts(run.id).find((a) => a.nodeId === work.id)?.pid ?? 0; }
    expect(alive(pid)).toBe(true);
    await svc.engine.cancel(run.id);
    const fin = await waitRun(svc, run.id, ['cancelled']);
    expect(fin.status).toBe('cancelled');
    await sleep(300);
    expect(alive(pid)).toBe(false);
    expect(svc.store.runAttempts(run.id)[0].status).toBe('cancelled');
    svc.close();
  });

  it('시간 제한을 넘으면 프로세스를 종료하고 실패로 기록한다', async () => {
    const { svc, p } = setup();
    const { gv } = linear(svc, p.id, { marker: '[[mock:hang]]' });
    const g = svc.store.getGraphVersion(gv.id).graph; g.nodes[1].timeoutSec = 1;
    const v = svc.saveGraph(p.id, g, '').version!;
    const run = await svc.startRun(p.id, v.id);
    const fin = await waitRun(svc, run.id, ['failed', 'review_wait']);
    const a = svc.store.runAttempts(run.id).filter((x) => x.role === 'author');
    expect(a.every((x) => x.status === 'timeout')).toBe(true);
    expect(fin.status).toBe('failed');
    expect(alive(a[0].pid!)).toBe(false);
    svc.close();
  });

  it('같은 흐름 버전의 중복 시작을 막는다', async () => {
    const { svc, p } = setup();
    const { gv } = linear(svc, p.id, { marker: '[[mock:hang]]' });
    const run = await svc.startRun(p.id, gv.id);
    await expect(svc.startRun(p.id, gv.id)).rejects.toThrow('이미 진행 중');
    await svc.engine.cancel(run.id); await waitRun(svc, run.id, ['cancelled']);
    svc.close();
  });

  it('수정 범위가 겹치는 작업은 실행 계층에서 동시에 실행되지 않는다', async () => {
    const { svc, p } = setup();
    const w = svc.saveAgent(p.id, null, agentFields('01', '작성자'));
    const inp = n('input', '입력');
    const a1 = n('agent', '쓰기1', { agentId: w.id, writeScope: ['docs'], outputs: [{ path: 'docs/1.md', format: 'markdown', required: true }] });
    const a2 = n('agent', '쓰기2', { agentId: w.id, writeScope: ['docs'], outputs: [{ path: 'docs/2.md', format: 'markdown', required: true }] });
    const v = svc.store.saveGraph(p.id, { nodes: [inp, a1, a2], edges: [e(inp, a1), e(inp, a2)] }, '검사 우회 저장(엔진 잠금 시험)');
    const run = svc.engine.startRun(p.id, v.id);
    await waitRun(svc, run.id, ['succeeded', 'failed']);
    const [x, y] = svc.store.runAttempts(run.id);
    const overlap = Date.parse(x.startedAt) < Date.parse(y.finishedAt!) && Date.parse(y.startedAt) < Date.parse(x.finishedAt!);
    // 시도 기록은 대기 전에 만들어지므로, 실제 프로세스 구간으로 비교: 이벤트 첫 시각
    const ev = (id: string) => svc.store.events(id);
    const xs = Date.parse(ev(x.id)[0].at), xe = Date.parse(ev(x.id).at(-1)!.at), ys = Date.parse(ev(y.id)[0].at), ye = Date.parse(ev(y.id).at(-1)!.at);
    expect(xs < ye && ys < xe).toBe(false);
    void overlap;
    svc.close();
  });
});

describe('6. 권한과 산출물·비밀값', () => {
  it('허용 범위 밖 편집 시도는 거부로 기록되고, 범위 밖 직접 변경은 탐지해 실패 처리한다', async () => {
    const { dir, svc, p } = setup();
    mkdirSync(join(dir, 'secret area'), { recursive: true });
    const { gv, work } = linear(svc, p.id, { marker: '[[mock:try-edit:secret area/x.txt]] [[mock:write-outside:secret area/leak.txt]]' });
    const run = await svc.startRun(p.id, gv.id);
    const fin = await waitRun(svc, run.id, ['failed', 'review_wait']);
    expect(fin.status).toBe('failed');
    const a = svc.store.runAttempts(run.id).find((x) => x.nodeId === work.id)!;
    expect(a.permissionDenials.join(' ')).toContain('secret area/x.txt');
    expect(a.outOfScopeChanges).toContain('secret area/leak.txt');
    expect(a.acceptance!.checks.find((c) => c.name === '수정 범위 준수')!.ok).toBe(false);
    expect(existsSync(join(dir, 'secret area/x.txt'))).toBe(false);
    svc.close();
  });

  it('로그·기록에 토큰 형태 비밀값을 남기지 않는다', async () => {
    const { svc, p } = setup();
    const { gv } = linear(svc, p.id, { marker: '[[mock:leak]]' });
    const run = await svc.startRun(p.id, gv.id);
    await waitRun(svc, run.id, ['review_wait', 'failed']);
    const dump = JSON.stringify(svc.store.runAttempts(run.id).map((a) => svc.store.events(a.id)));
    expect(dump).not.toContain('sk-ant-api03-FAKE');
    expect(dump).not.toContain('ghp_FAKEFAKE');
    expect(dump).toContain('[숨김]');
    svc.close();
  });

  it('산출물 기록이 실제 파일과 일치한다(경로·크기·해시)', async () => {
    const { svc, p } = setup();
    const { gv } = linear(svc, p.id);
    const run = await svc.startRun(p.id, gv.id);
    await waitRun(svc, run.id, ['review_wait']);
    const { fileSha } = await import('../src/main/engine/fsutil');
    for (const a of svc.store.artifacts(run.id)) { expect(existsSync(a.path)).toBe(true); expect(fileSha(a.path)).toBe(a.sha256); }
    svc.close();
  });
});

describe('7. 팀장 검토', () => {
  it('수정 요청은 지정한 담당의 후속 작업으로 이어지고, 결과물이 바뀌면 이전 결정을 재사용하지 않는다', async () => {
    const { dir, svc, p } = setup();
    const { gv, work, ur } = linear(svc, p.id);
    const run = await svc.startRun(p.id, gv.id);
    await waitRun(svc, run.id, ['review_wait']);
    const s1 = svc.engine.detail(run.id).currentSubjectHash!;
    // 보류: 상태 보존
    await svc.submitReview(run.id, ur.id, 'hold', '잠시 보류', null, s1);
    expect(svc.store.getRun(run.id).status).toBe('on_hold');
    // 수정 요청 → 작성 담당 재작업
    await svc.submitReview(run.id, ur.id, 'changes_requested', '표를 추가해 주세요', work.id, s1);
    await waitRun(svc, run.id, ['review_wait']);
    const authors = svc.store.runAttempts(run.id).filter((a) => a.nodeId === work.id && a.role === 'author');
    expect(authors.length).toBe(2);
    expect(readFileSync(join(dir, 'docs/결과 문서.md'), 'utf8')).toContain('FIXED');
    const s2 = svc.engine.detail(run.id).currentSubjectHash!;
    expect(s2).not.toBe(s1);
    // 이전 대상 해시로는 승인할 수 없다
    await expect(svc.submitReview(run.id, ur.id, 'approve', '', null, s1)).rejects.toThrow('바뀌었습니다');
    // 파일을 바꾸면 현재 해시도 바뀐다
    writeFileSync(join(dir, 'docs/결과 문서.md'), '사용자가 바꾼 내용');
    expect(svc.engine.detail(run.id).currentSubjectHash).not.toBe(s2);
    await expect(svc.submitReview(run.id, ur.id, 'approve', '', null, s2)).rejects.toThrow('바뀌었습니다');
    const s3 = svc.engine.detail(run.id).currentSubjectHash!;
    await svc.submitReview(run.id, ur.id, 'approve', '확인', null, s3);
    const fin = await waitRun(svc, run.id, ['succeeded', 'failed']);
    expect(fin.status).toBe('succeeded');
    const stale = svc.store.reviews(run.id).filter((r) => r.kind === 'user');
    expect(stale.find((r) => r.verdict === 'changes_requested')!.stale).toBe(true);
    svc.close();
  });

  it('선택 단계부터 재실행하면 완료 단계는 재사용하고 새 결과물에는 새 검토가 필요하다', async () => {
    const { svc, p } = setup();
    const { gv, work, ur } = linear(svc, p.id, { check: ['/usr/bin/true'] });
    const run = await svc.startRun(p.id, gv.id);
    await waitRun(svc, run.id, ['review_wait']);
    await svc.submitReview(run.id, ur.id, 'approve', '', null, svc.engine.detail(run.id).currentSubjectHash!);
    await waitRun(svc, run.id, ['succeeded']);
    const chk = svc.store.getGraphVersion(gv.id).graph.nodes.find((x) => x.kind === 'check')!;
    const r2 = svc.engine.rerunFrom(run.id, chk.id);
    await waitRun(svc, r2.id, ['review_wait']);
    expect(svc.store.runAttempts(r2.id).filter((a) => a.nodeId === work.id).length).toBe(0); // 작성 단계는 다시 실행하지 않음
    expect(svc.store.runNodes(r2.id).find((x) => x.nodeId === work.id)!.status).toBe('succeeded');
    expect(svc.store.reviews(r2.id).filter((r) => r.kind === 'user').length).toBe(0); // 이전 승인이 넘어오지 않음
    await svc.engine.cancel(r2.id);
    svc.close();
  });
});
