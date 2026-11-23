// Codex 리뷰(2026-11-10) 지적 사항 회귀 시험 — 모의 CLI 사용
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Service } from '../src/main/service';
import * as fs from 'node:fs';
import { applyIsolated, checkOutput, cleanupIsolated, diffSnapshots, isolatedDir, prepareIsolated, snapshot } from '../src/main/engine/fsutil';
import { MOCK, agentFields, alive, e, mkService, n, plan, sleep, tmpProject, waitRun } from './helpers';

function setup(extra = {}) { const dir = tmpProject(); const svc = mkService(dir); const p = svc.createProject(plan(dir, extra)); return { dir, svc, p }; }
const docOut = (f: string) => [{ path: `docs/${f}`, format: 'markdown' as const, required: true }];

describe('Codex 리뷰 반영', () => {
  it('#1 CLI 실행 파일이 없으면(ENOENT) 기존 산출물이 있어도 성공으로 처리하지 않는다', async () => {
    const { dir, svc, p } = setup();
    mkdirSync(join(dir, 'docs'), { recursive: true }); writeFileSync(join(dir, 'docs/a.md'), '이전 실행의 내용');
    const w = svc.saveAgent(p.id, null, agentFields('01', '작성자'));
    const inp = n('input', '입력'); const a = n('agent', 'A', { agentId: w.id, writeScope: ['docs'], outputs: docOut('a.md') });
    const v = svc.saveGraph(p.id, { nodes: [inp, a], edges: [e(inp, a)] }, '').version!;
    svc.saveSettings({ executor: 'claude', cliPath: '/nonexistent/claude' });
    const run = svc.engine.startRun(p.id, v.id);
    const fin = await waitRun(svc, run.id, ['failed', 'succeeded']);
    expect(fin.status).toBe('failed');
    const at = svc.store.runAttempts(run.id)[0];
    expect(at.status).toBe('failed');
    expect(at.acceptance!.checks.find((c) => c.name === '프로세스 정상 종료')!.ok).toBe(false);
    svc.close();
  });

  it('#3 병렬 실행 중에도 범위 밖 변경을 면제하지 않는다', async () => {
    const { dir, svc, p } = setup();
    svc.saveSettings({ commandLevel: 'low' }); // 실제 폴더에서 바로 작업하는 경로
    mkdirSync(join(dir, 'forbidden'), { recursive: true });
    const w = svc.saveAgent(p.id, null, agentFields('01', '작성자'));
    const inp = n('input', '입력');
    const a = n('agent', 'A', { agentId: w.id, instructions: '[[mock:write-outside:forbidden/x.txt]]', writeScope: ['docs'], outputs: docOut('a.md') });
    const b = n('agent', 'B', { agentId: w.id, writeScope: ['src'], outputs: [{ path: 'src/b.md', format: 'markdown', required: true }] });
    const v = svc.saveGraph(p.id, { nodes: [inp, a, b], edges: [e(inp, a), e(inp, b)] }, '').version!;
    const run = await svc.startRun(p.id, v.id);
    await waitRun(svc, run.id, ['failed', 'succeeded']);
    const all = svc.store.runAttempts(run.id).flatMap((x) => x.outOfScopeChanges);
    expect(all).toContain('forbidden/x.txt');
    expect(svc.store.getRun(run.id).status).toBe('failed');
    svc.close();
  });

  it('#4 서로 다른 프로젝트라도 같은 실제 경로를 수정하는 작업은 동시에 실행되지 않는다', async () => {
    const dir = tmpProject(); const svc = mkService(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    const p1 = svc.createProject(plan(dir, { writablePaths: ['src'] }));
    const p2 = svc.createProject(plan(join(dir, 'src'), { name: '하위 프로젝트', writablePaths: ['two'], outputDir: 'out' }));
    const mk = (pid: string, scope: string, out: string) => {
      const w = svc.saveAgent(pid, null, agentFields('01', '작성자'));
      const inp = n('input', '입력'); const a = n('agent', 'A', { agentId: w.id, writeScope: [scope], outputs: [{ path: out, format: 'markdown', required: true }] });
      return svc.saveGraph(pid, { nodes: [inp, a], edges: [e(inp, a)] }, '').version!;
    };
    const v1 = mk(p1.id, 'src', 'src/one.md'); const v2 = mk(p2.id, 'two', 'two/two.md'); // 실제 경로 <dir>/src/two — p1의 src 범위와 겹침
    const r1 = await svc.startRun(p1.id, v1.id); const r2 = await svc.startRun(p2.id, v2.id);
    await waitRun(svc, r1.id, ['succeeded', 'failed']); await waitRun(svc, r2.id, ['succeeded', 'failed']);
    const span = (rid: string) => { const a = svc.store.runAttempts(rid)[0]; const ev = svc.store.events(a.id); return [Date.parse(ev[0].at), Date.parse(ev.at(-1)!.at)]; };
    const [s1, e1] = span(r1.id), [s2, e2] = span(r2.id);
    expect(s1 < e2 && s2 < e1).toBe(false);
    svc.close();
  });

  it('#5 직원에 지정한 독립 검토자가 노드 설정 없이도 실행된다', async () => {
    const { svc, p } = setup();
    const r = svc.saveAgent(p.id, null, agentFields('02', '검토자', { tools: ['Read', 'Grep', 'Glob'] }));
    const w = svc.saveAgent(p.id, null, agentFields('01', '작성자', { reviewerAgentId: r.id }));
    const inp = n('input', '입력'); const a = n('agent', 'A', { agentId: w.id, writeScope: ['docs'], outputs: docOut('a.md') });
    const v = svc.saveGraph(p.id, { nodes: [inp, a], edges: [e(inp, a)] }, '').version!;
    const run = await svc.startRun(p.id, v.id);
    await waitRun(svc, run.id, ['succeeded', 'failed']);
    expect(svc.store.runAttempts(run.id).filter((x) => x.role === 'reviewer').length).toBe(1);
    expect(svc.store.reviews(run.id).filter((x) => x.kind === 'agent' && x.reviewerAgentId === r.id).length).toBe(1);
    svc.close();
  });

  it('#7 허용 영역 안의 검사 입력 파일은 고정하지 않아 두 번째 실행도 정상 진행된다', async () => {
    const { svc, p } = setup();
    svc.loadAgentTemplates(p.id);
    const v = svc.saveGraph(p.id, svc.defaultGraph(p.id), '').version!;
    for (let k = 0; k < 2; k++) {
      const run = await svc.startRun(p.id, v.id);
      const st = await waitRun(svc, run.id, ['review_wait', 'failed']);
      expect(st.status).toBe('review_wait');
      expect(svc.store.checks(run.id).every((c) => c.ok)).toBe(true);
      await svc.engine.cancel(run.id); await waitRun(svc, run.id, ['cancelled']);
    }
    svc.close();
  });

  it('#9 정상 종료(shutdown) 후 시도 기록이 일관되고 세션 이어서 재개된다', async () => {
    const { dir, svc, p } = setup();
    const hold = join(dir, '..', 'HOLD-shutdown'); writeFileSync(hold, '1');
    const w = svc.saveAgent(p.id, null, agentFields('01', '작성자'));
    const inp = n('input', '입력'); const a = n('agent', 'A', { agentId: w.id, instructions: `[[mock:wait-while:${hold}]]`, writeScope: ['docs'], outputs: docOut('a.md') });
    const v = svc.saveGraph(p.id, { nodes: [inp, a], edges: [e(inp, a)] }, '').version!;
    const run = await svc.startRun(p.id, v.id);
    let pid = 0; while (!pid) { await sleep(30); pid = svc.store.runAttempts(run.id)[0]?.pid ?? 0; }
    const file = svc.store.file; svc.close();
    await sleep(300); expect(alive(pid)).toBe(false);
    const re = new Service({ dbFile: file, mockScript: MOCK, emit: () => {} });
    re.saveSettings({ executor: 'mock' });
    await re.engine.recoverOnStartup();
    const old = re.store.runAttempts(run.id)[0];
    expect(old.status).toBe('interrupted'); // JSON 내부 상태도 interrupted
    expect(re.store.getRunNode(run.id, a.id).status).toBe('needs_resume');
    require('node:fs').rmSync(hold);
    re.engine.resolveInterrupted(run.id, a.id, 'continue_session');
    await re.engine.resume(run.id);
    expect((await waitRun(re, run.id, ['succeeded', 'failed'])).status).toBe('succeeded');
    expect(re.store.runAttempts(run.id).at(-1)!.resumedFrom).toBe(old.sessionId);
    re.close();
  });

  it('#10 구조화 검토 결과의 비밀값을 마스킹해 저장한다', async () => {
    const { svc, p } = setup();
    const r = svc.saveAgent(p.id, null, agentFields('02', '검토자', { tools: ['Read', 'Grep', 'Glob'] }));
    const w = svc.saveAgent(p.id, null, agentFields('01', '작성자'));
    const inp = n('input', '입력'); const a = n('agent', 'A', { agentId: w.id, reviewerAgentId: r.id, doneCriteria: '[[mock:leak-review]]', writeScope: ['docs'], outputs: docOut('a.md'), maxRetries: 0, maxVisits: 1 });
    const v = svc.saveGraph(p.id, { nodes: [inp, a], edges: [e(inp, a)] }, '').version!;
    const run = await svc.startRun(p.id, v.id);
    await waitRun(svc, run.id, ['succeeded', 'failed']);
    const dump = JSON.stringify(svc.store.db.prepare('SELECT * FROM run_meta').all()) + JSON.stringify(svc.store.reviews(run.id));
    expect(dump).not.toContain('REVIEWFAKE');
    expect(dump).toContain('[숨김]');
    svc.close();
  });

  it('#11 검사 노드도 필수 산출물이 없으면 통과하지 않는다', async () => {
    const { svc, p } = setup();
    const inp = n('input', '입력'); const c = n('check', '검사', { command: ['/usr/bin/true'], outputs: [{ path: 'docs/report.json', format: 'json', required: true }] });
    const v = svc.saveGraph(p.id, { nodes: [inp, c], edges: [e(inp, c)] }, '').version!;
    const run = await svc.startRun(p.id, v.id);
    expect((await waitRun(svc, run.id, ['failed', 'succeeded'])).status).toBe('failed');
    expect(svc.store.checks(run.id)[0].ok).toBe(false);
    svc.close();
  });

  it('#12·#13 폴더를 JSON 산출물로 인정하지 않고, 프로젝트 밖 경로를 거부한다', () => {
    const { dir, svc, p } = setup();
    mkdirSync(join(dir, 'docs/x.json'), { recursive: true });
    expect(checkOutput(dir, { path: 'docs/x.json', format: 'json', required: true }).ok).toBe(false);
    expect(() => svc.updatePlan(p.id, { ...p.plan, outputDir: '../../outside' })).toThrow('프로젝트 밖');
    const w = svc.saveAgent(p.id, null, agentFields('01', '작성자'));
    const inp = n('input', '입력'); const a = n('agent', 'A', { agentId: w.id, writeScope: ['docs/../../x'], outputs: docOut('a.md') });
    expect(svc.validate(p.id, { nodes: [inp, a], edges: [e(inp, a)] }).map((i) => i.code)).toContain('path_escape');
    expect(existsSync(join(dir, '..', '..', 'outside'))).toBe(false);
    svc.close();
  });
});

describe('#15 결과물 Markdown 렌더링', () => {
  it('제목처럼 보이지만 제목이 아닌 줄에서 멈추지 않는다', async () => {
    const { renderToString } = await import('react-dom/server');
    const { createElement } = await import('react');
    const mod = await import('../src/renderer/markdown');
    const Md = (mod as Record<string, unknown>).Markdown as (p: { text: string }) => unknown;
    const html = renderToString(createElement(Md as never, { text: '#1 priority\n#!/bin/bash\n####### title\n본문' }));
    expect(html).toContain('#1 priority');
    expect(html).toContain('본문');
  });
});

describe('Codex 재검토 반영', () => {
  it('수정 허용 영역 안의 검사 스크립트도 실행 중 바뀌면 검사 실패로 처리한다', async () => {
    const dir = tmpProject(); const svc = mkService(dir);
    const p = svc.createProject(plan(dir, { writablePaths: ['docs', 'tests'] }));
    mkdirSync(join(dir, 'tests'), { recursive: true }); writeFileSync(join(dir, 'tests/check.cjs'), 'process.exit(1)');
    const w = svc.saveAgent(p.id, null, agentFields('01', '작성자'));
    const hold = join(dir, '..', 'HOLD-tamper'); writeFileSync(hold, '1');
    const inp = n('input', '입력'); const a = n('agent', 'A', { agentId: w.id, instructions: `[[mock:wait-while:${hold}]]`, writeScope: ['docs'], outputs: docOut('a.md') });
    const c = n('check', '검사', { command: [process.execPath, 'tests/check.cjs'] });
    const v = svc.saveGraph(p.id, { nodes: [inp, a, c], edges: [e(inp, a), e(a, c), e(c, a, 'fail')] }, '').version!;
    const run = await svc.startRun(p.id, v.id);
    writeFileSync(join(dir, 'tests/check.cjs'), 'process.exit(0)'); // 실행 중 약화
    require('node:fs').rmSync(hold);
    await waitRun(svc, run.id, ['failed', 'succeeded']);
    const ck = svc.store.checks(run.id);
    expect(ck.length).toBeGreaterThan(0);
    expect(ck.every((x) => !x.ok)).toBe(true);
    expect(ck[0].output).toContain('검사 파일이 실행 중 변경');
    svc.close();
  });

  it("writablePaths '.'(프로젝트 전체)를 보존하고 검사 노드 산출물의 프로젝트 밖 경로를 거부한다", () => {
    const dir = tmpProject(); const svc = mkService(dir);
    const p = svc.createProject(plan(dir, { writablePaths: ['.'] }));
    expect(p.plan.writablePaths).toEqual(['.']);
    const w = svc.saveAgent(p.id, null, agentFields('01', '작성자'));
    const inp = n('input', '입력'); const a = n('agent', 'A', { agentId: w.id, writeScope: ['.'], outputs: [{ path: 'a.md', format: 'markdown', required: true }] });
    expect(svc.validate(p.id, { nodes: [inp, a], edges: [e(inp, a)] }).filter((i) => i.level === 'error')).toEqual([]);
    const c = n('check', '검사', { command: ['/usr/bin/true'], outputs: [{ path: '../../outside.json', format: 'json', required: true }] });
    expect(svc.validate(p.id, { nodes: [inp, c], edges: [e(inp, c)] }).map((i) => i.code)).toContain('path_escape');
    svc.close();
  });
});

describe('실제 CLI 시나리오에서 찾은 결함', () => {
  it('병렬 작업 중 먼저 끝난 작업의 정상 변경을 늦게 끝난 작업의 범위 밖 변경으로 오인하지 않는다', async () => {
    const dir = tmpProject(); const svc = mkService(dir);
    const p = svc.createProject(plan(dir));
    const w = svc.saveAgent(p.id, null, agentFields('01', '작성자'));
    const hold = join(dir, '..', 'HOLD-slow'); writeFileSync(hold, '1');
    const inp = n('input', '입력');
    const a = n('agent', '느린 A', { agentId: w.id, instructions: `[[mock:wait-while:${hold}]]`, writeScope: ['docs/a'], outputs: [{ path: 'docs/a/plan.md', format: 'markdown', required: true }] });
    const b = n('agent', '빠른 B', { agentId: w.id, writeScope: ['docs/b'], outputs: [{ path: 'docs/b/notes.md', format: 'markdown', required: true }] });
    const v = svc.saveGraph(p.id, { nodes: [inp, a, b], edges: [e(inp, a), e(inp, b)] }, '').version!;
    const run = await svc.startRun(p.id, v.id);
    while (svc.store.getRunNode(run.id, b.id).status !== 'succeeded') await sleep(30); // B가 먼저 끝남
    require('node:fs').rmSync(hold);
    const fin = await waitRun(svc, run.id, ['succeeded', 'failed']);
    expect(svc.store.runAttempts(run.id).flatMap((x) => x.outOfScopeChanges)).toEqual([]);
    expect(fin.status).toBe('succeeded');
    svc.close();
  });

  it('트랜잭션 안에서 오류가 나면 일부 기록만 남지 않는다', () => {
    const dir = tmpProject(); const svc = mkService(dir);
    expect(() => svc.store.tx(() => { svc.store.setSetting('atomic-probe', 1); throw new Error('중단'); })).toThrow('중단');
    expect(svc.store.getSetting('atomic-probe', null)).toBeNull();
    svc.close();
  });
});

describe('Codex 3차 반영', () => {
  it('검사가 실행 자리를 기다리는 동안 바뀐 검사 코드도 실행 직전에 탐지한다', async () => {
    const dir = tmpProject(); const svc = mkService(dir);
    svc.saveSettings({ executor: 'mock', maxConcurrent: 1 });
    const p = svc.createProject(plan(dir));
    writeFileSync(join(dir, 'gate.cjs'), 'process.exit(1)');
    const w = svc.saveAgent(p.id, null, agentFields('01', '작성자'));
    const hold = join(dir, '..', 'HOLD-slot'); writeFileSync(hold, '1');
    const inp = n('input', '입력');
    const busy = n('agent', '자리 점유', { agentId: w.id, instructions: `[[mock:wait-while:${hold}]]`, writeScope: ['docs'], outputs: docOut('busy.md') });
    const c = n('check', '검사', { command: [process.execPath, 'gate.cjs'] });
    const v = svc.saveGraph(p.id, { nodes: [inp, busy, c], edges: [e(inp, busy), e(inp, c)] }, '').version!;
    const run = await svc.startRun(p.id, v.id);
    while (!svc.store.runAttempts(run.id).some((x) => x.role === 'check')) await sleep(20); // 검사가 자리를 기다리는 중
    writeFileSync(join(dir, 'gate.cjs'), 'process.exit(0)');
    require('node:fs').rmSync(hold);
    await waitRun(svc, run.id, ['failed', 'succeeded']);
    const ck = svc.store.checks(run.id);
    expect(ck.every((x) => !x.ok)).toBe(true);
    expect(ck[0].output).toContain('검사 파일이 실행 중 변경');
    svc.close();
  });

  it('직원 작업 폴더가 프로젝트 밖을 가리키면 저장을 거부한다', () => {
    const dir = tmpProject(); const svc = mkService(dir);
    const p = svc.createProject(plan(dir));
    expect(() => svc.saveAgent(p.id, null, agentFields('01', '작성자', { workPaths: ['docs', '../outside'] }))).toThrow('프로젝트 밖');
    svc.close();
  });
});

describe('Bash 작성자 격리 실행(사전 차단)', () => {
  const bashAgent = (svc: ReturnType<typeof mkService>, pid: string, name = '빌드 담당') => svc.saveAgent(pid, null, agentFields('12', name, { tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'], allowedCommands: ['npm test'] }));

  it('기획의 허용 경로 밖 쓰기는 실제 프로젝트에 반영되지 않고 기록된다', async () => {
    const dir = tmpProject(); const svc = mkService(dir);
    const p = svc.createProject(plan(dir));
    mkdirSync(join(dir, 'secret'), { recursive: true });
    const w = bashAgent(svc, p.id);
    const inp = n('input', '입력');
    const a = n('agent', 'A', { agentId: w.id, instructions: '[[mock:write-outside:secret/leak.txt]]', writeScope: ['docs'], outputs: docOut('a.md'), maxRetries: 0, maxVisits: 1 });
    const v = svc.saveGraph(p.id, { nodes: [inp, a], edges: [e(inp, a)] }, '').version!;
    const run = await svc.startRun(p.id, v.id);
    await waitRun(svc, run.id, ['failed', 'succeeded']);
    expect(existsSync(join(dir, 'secret/leak.txt'))).toBe(false); // 실제 프로젝트에 쓰이지 않음(차단)
    const at = svc.store.runAttempts(run.id)[0];
    expect(at.outOfScopeChanges.join(' ')).toContain('secret/leak.txt');
    expect(at.outOfScopeChanges.join(' ')).toContain('허용 경로 밖');
    expect(svc.store.getRun(run.id).status).toBe('failed');
    svc.close();
  });

  it('작업 범위 밖이어도 기획의 허용 경로 안이면 함께 반영하고 실패로 치지 않는다(예: 문서 작업 중 고친 시험 파일)', async () => {
    const dir = tmpProject(); const svc = mkService(dir);
    const p = svc.createProject(plan(dir));
    mkdirSync(join(dir, 'src'), { recursive: true });
    const w = bashAgent(svc, p.id);
    const inp = n('input', '입력');
    const a = n('agent', 'A', { agentId: w.id, instructions: '[[mock:write-outside:src/fix.test.ts]]', writeScope: ['docs'], outputs: docOut('a.md'), maxRetries: 0, maxVisits: 1 });
    const v = svc.saveGraph(p.id, { nodes: [inp, a], edges: [e(inp, a)] }, '').version!;
    const run = await svc.startRun(p.id, v.id);
    await waitRun(svc, run.id, ['failed', 'succeeded']);
    expect(existsSync(join(dir, 'src/fix.test.ts'))).toBe(true);
    const at = svc.store.runAttempts(run.id)[0];
    expect(at.outOfScopeChanges).toEqual([]);
    expect(at.changedFiles).toContain('src/fix.test.ts');
    expect(svc.store.getRun(run.id).status).toBe('succeeded');
    svc.close();
  });

  it('범위 안 변경은 반영되고, Bash 작성자끼리도 범위가 다르면 병렬로 실행된다', async () => {
    const dir = tmpProject(); const svc = mkService(dir);
    const p = svc.createProject(plan(dir));
    const w1 = bashAgent(svc, p.id, '빌드1'); const w2 = bashAgent(svc, p.id, '빌드2');
    const inp = n('input', '입력');
    const a = n('agent', 'A', { agentId: w1.id, writeScope: ['docs'], outputs: docOut('a.md') });
    const b = n('agent', 'B', { agentId: w2.id, writeScope: ['src'], outputs: [{ path: 'src/b.md', format: 'markdown', required: true }] });
    const saved = svc.saveGraph(p.id, { nodes: [inp, a, b], edges: [e(inp, a), e(inp, b)] }, '');
    expect(saved.issues.filter((i) => i.level === 'error')).toEqual([]);
    const run = await svc.startRun(p.id, saved.version!.id);
    expect((await waitRun(svc, run.id, ['failed', 'succeeded'])).status).toBe('succeeded');
    expect(existsSync(join(dir, 'docs/a.md')) && existsSync(join(dir, 'src/b.md'))).toBe(true);
    expect(svc.store.runAttempts(run.id).flatMap((x) => x.changedFiles).sort()).toEqual(['docs/a.md', 'src/b.md']);
    svc.close();
  });

  it('격리 실행 중 원본 파일이 바뀌면 덮어쓰지 않고 충돌로 실패 처리한다', async () => {
    const dir = tmpProject(); const svc = mkService(dir);
    const p = svc.createProject(plan(dir));
    mkdirSync(join(dir, 'docs'), { recursive: true }); writeFileSync(join(dir, 'docs/a.md'), '원본');
    const w = bashAgent(svc, p.id);
    const hold = join(dir, '..', 'HOLD-iso'); writeFileSync(hold, '1');
    const inp = n('input', '입력');
    const a = n('agent', 'A', { agentId: w.id, instructions: `[[mock:wait-while:${hold}]]`, writeScope: ['docs'], outputs: docOut('a.md'), maxRetries: 0, maxVisits: 1 });
    const v = svc.saveGraph(p.id, { nodes: [inp, a], edges: [e(inp, a)] }, '').version!;
    const run = await svc.startRun(p.id, v.id);
    while (!svc.store.runAttempts(run.id)[0]?.pid) await sleep(20);
    writeFileSync(join(dir, 'docs/a.md'), '사용자가 실행 중에 고친 내용');
    require('node:fs').rmSync(hold);
    await waitRun(svc, run.id, ['failed', 'succeeded']);
    expect(require('node:fs').readFileSync(join(dir, 'docs/a.md'), 'utf8')).toBe('사용자가 실행 중에 고친 내용');
    expect(svc.store.runAttempts(run.id)[0].acceptance!.checks.some((c) => c.name === '격리 실행 반영' && !c.ok)).toBe(true);
    svc.close();
  });
});

describe('격리 반영 규칙(Codex 4차)', () => {
  const inDocs = (f: string) => f === 'docs' || f.startsWith('docs/');

  it('프로젝트 밖을 가리키는 링크는 복사하지 않고, 링크 경로로는 반영하지 않는다', () => {
    const proj = tmpProject(); const outside = join(proj, '..', 'outside-target'); fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(join(proj, 'docs'), { recursive: true }); fs.symlinkSync(outside, join(proj, 'docs/alias'));
    const dir = isolatedDir(`t1:${proj}`); const st = prepareIsolated(proj, dir, inDocs, false);
    expect(fs.existsSync(join(dir, 'docs/alias'))).toBe(false);
    fs.mkdirSync(join(dir, 'docs/alias'), { recursive: true }); fs.writeFileSync(join(dir, 'docs/alias/new.md'), 'x');
    const r = applyIsolated(proj, dir, diffSnapshots(new Map(st.before), snapshot(dir)), st.base);
    expect(r.applied).toEqual([]); expect(r.blocked.length).toBeGreaterThan(0);
    expect(fs.existsSync(join(outside, 'new.md'))).toBe(false);
    cleanupIsolated(dir);
  });

  it('복사 시점 이후 원본이 바뀌면 충돌로 보고 아무것도 반영하지 않는다(전부 또는 전무)', () => {
    const proj = tmpProject(); fs.mkdirSync(join(proj, 'docs'), { recursive: true });
    fs.writeFileSync(join(proj, 'docs/a.md'), '원본'); fs.writeFileSync(join(proj, 'docs/b.md'), '원본b');
    const dir = isolatedDir(`t2:${proj}`); const st = prepareIsolated(proj, dir, inDocs, false);
    fs.writeFileSync(join(dir, 'docs/a.md'), '에이전트'); fs.writeFileSync(join(dir, 'docs/b.md'), '에이전트b');
    fs.writeFileSync(join(proj, 'docs/a.md'), '사용자 수정');
    const r = applyIsolated(proj, dir, diffSnapshots(new Map(st.before), snapshot(dir)), st.base);
    expect(r.conflicts).toEqual(['docs/a.md']); expect(r.applied).toEqual([]);
    expect(fs.readFileSync(join(proj, 'docs/b.md'), 'utf8')).toBe('원본b');
    cleanupIsolated(dir);
  });

  it('복사본에 새로 생긴 링크는 빼고 나머지를 반영하고, 이미 같은 내용으로 바뀐 원본은 충돌로 치지 않는다', () => {
    const proj = tmpProject(); fs.mkdirSync(join(proj, 'docs'), { recursive: true });
    fs.writeFileSync(join(proj, 'docs/a.md'), '원본');
    const dir = isolatedDir(`t2b:${proj}`); const st = prepareIsolated(proj, dir, inDocs, false);
    fs.writeFileSync(join(dir, 'docs/a.md'), '에이전트'); fs.writeFileSync(join(dir, 'docs/new.md'), '새 파일');
    fs.mkdirSync(join(dir, 'docs/tmp'), { recursive: true }); fs.symlinkSync(join(dir, 'docs/new.md'), join(dir, 'docs/tmp/current'));
    fs.writeFileSync(join(proj, 'docs/a.md'), '에이전트'); // 실행 중 원본이 같은 내용으로 바뀜
    const r = applyIsolated(proj, dir, diffSnapshots(new Map(st.before), snapshot(dir)), st.base);
    expect(r.conflicts).toEqual([]); expect(r.blocked).toEqual([]);
    expect(r.skipped).toEqual(['docs/tmp/current']);
    expect(r.applied).toEqual(['docs/new.md']); expect(r.same).toEqual(['docs/a.md']); // 같은 내용으로 바뀐 파일은 앱이 쓴 것이 아니므로 반영 목록에 넣지 않는다
    expect(fs.readFileSync(join(proj, 'docs/new.md'), 'utf8')).toBe('새 파일');
    expect(fs.existsSync(join(proj, 'docs/tmp/current'))).toBe(false);
    cleanupIsolated(dir);
  });

  it('있던 폴더를 링크로 바꾸면 아무것도 반영하지 않는다(링크를 따라가 원본을 덮어쓰거나 지우지 않음)', () => {
    const proj = tmpProject(); const outside = join(proj, '..', 'outside-src'); fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(join(outside, 'a.md'), '밖의 내용');
    fs.mkdirSync(join(proj, 'docs/sub'), { recursive: true });
    fs.writeFileSync(join(proj, 'docs/sub/a.md'), '원본'); fs.writeFileSync(join(proj, 'docs/sub/b.md'), '원본b'); fs.writeFileSync(join(proj, 'docs/c.md'), '원본c');
    const dir = isolatedDir(`t2c:${proj}`); const st = prepareIsolated(proj, dir, inDocs, false);
    fs.rmSync(join(dir, 'docs/sub'), { recursive: true }); fs.symlinkSync(outside, join(dir, 'docs/sub'));
    fs.writeFileSync(join(dir, 'docs/c.md'), '에이전트');
    const r = applyIsolated(proj, dir, diffSnapshots(new Map(st.before), snapshot(dir)), st.base);
    expect(r.applied).toEqual([]); expect(r.blocked.length).toBeGreaterThan(0); expect(r.skipped).toEqual([]);
    expect(fs.readFileSync(join(proj, 'docs/sub/a.md'), 'utf8')).toBe('원본');
    expect(fs.existsSync(join(proj, 'docs/sub/b.md'))).toBe(true);
    expect(fs.readFileSync(join(proj, 'docs/c.md'), 'utf8')).toBe('원본c');
    cleanupIsolated(dir);
  });

  it('결과물이 아닌 파일의 충돌은 그 파일만 원본 그대로 두고 나머지를 반영한다(결과물이 충돌하면 전부 반영하지 않음)', () => {
    const proj = tmpProject(); fs.mkdirSync(join(proj, 'docs/out'), { recursive: true });
    fs.writeFileSync(join(proj, 'docs/config.md'), '원본 설정');
    const must = (rel: string) => rel.startsWith('docs/out/');
    const dir = isolatedDir(`t2d:${proj}`); const st = prepareIsolated(proj, dir, inDocs, false);
    fs.writeFileSync(join(dir, 'docs/config.md'), '복사본에서 바뀐 설정'); fs.writeFileSync(join(dir, 'docs/out/result.md'), '측정 결과');
    fs.writeFileSync(join(proj, 'docs/config.md'), '서버가 고쳐 쓴 설정'); // 실행 중 원본이 다르게 바뀜
    const changed = diffSnapshots(new Map(st.before), snapshot(dir));
    const r = applyIsolated(proj, dir, changed, st.base, must);
    expect(r.conflicts).toEqual([]); expect(r.left).toEqual(['docs/config.md']); expect(r.applied).toEqual(['docs/out/result.md']);
    expect(fs.readFileSync(join(proj, 'docs/config.md'), 'utf8')).toBe('서버가 고쳐 쓴 설정');
    expect(fs.readFileSync(join(proj, 'docs/out/result.md'), 'utf8')).toBe('측정 결과');
    // 결과물 자체가 충돌하면 예전처럼 아무것도 반영하지 않는다
    fs.writeFileSync(join(dir, 'docs/out/result.md'), '새 측정'); fs.writeFileSync(join(dir, 'docs/out/more.md'), '추가');
    fs.writeFileSync(join(proj, 'docs/out/result.md'), '사용자가 고침');
    const r2 = applyIsolated(proj, dir, ['docs/out/result.md', 'docs/out/more.md'], { ...st.base, 'docs/out/result.md': 'old' }, must);
    expect(r2.conflicts).toEqual(['docs/out/result.md']); expect(r2.applied).toEqual([]);
    expect(fs.existsSync(join(proj, 'docs/out/more.md'))).toBe(false);
    // 결과물이 아닌 다른 파일을 함께 반영해야 하면 일부 제외를 하지 않는다(맞물린 변경이 반쪽만 들어가지 않게)
    fs.writeFileSync(join(dir, 'docs/caller.md'), '설정에 맞춘 호출부');
    const r4 = applyIsolated(proj, dir, ['docs/config.md', 'docs/caller.md', 'docs/out/more.md'], st.base, must);
    expect(r4.conflicts).toEqual(['docs/config.md']); expect(r4.left).toEqual([]); expect(r4.applied).toEqual([]);
    expect(fs.existsSync(join(proj, 'docs/caller.md'))).toBe(false);
    // 복사 시점의 내용을 모르는 파일(기준 없음)과 폴더가 얽힌 충돌은 일부 제외 대상이 아니다
    const r5 = applyIsolated(proj, dir, ['docs/config.md', 'docs/out/more.md'], {}, must);
    expect(r5.conflicts).toEqual(['docs/config.md']); expect(r5.applied).toEqual([]);
    // mustApply를 주지 않으면 어떤 충돌이든 전부 반영하지 않는다
    const r3 = applyIsolated(proj, dir, ['docs/config.md', 'docs/out/more.md'], st.base);
    expect(r3.conflicts).toEqual(['docs/config.md']); expect(r3.applied).toEqual([]);
    cleanupIsolated(dir);
  });

  it('파일→폴더 전환과 폴더 삭제를 반영한다', () => {
    const proj = tmpProject(); fs.mkdirSync(join(proj, 'docs/old'), { recursive: true });
    fs.writeFileSync(join(proj, 'docs/a.md'), '파일'); fs.writeFileSync(join(proj, 'docs/old/x.md'), 'x');
    const dir = isolatedDir(`t3:${proj}`); const st = prepareIsolated(proj, dir, inDocs, false);
    fs.rmSync(join(dir, 'docs/a.md')); fs.mkdirSync(join(dir, 'docs/a.md')); fs.writeFileSync(join(dir, 'docs/a.md/inner.md'), '안쪽');
    fs.rmSync(join(dir, 'docs/old'), { recursive: true });
    const r = applyIsolated(proj, dir, diffSnapshots(new Map(st.before), snapshot(dir)), st.base);
    expect(r.conflicts).toEqual([]); expect(r.blocked).toEqual([]);
    expect(fs.readFileSync(join(proj, 'docs/a.md/inner.md'), 'utf8')).toBe('안쪽');
    expect(fs.existsSync(join(proj, 'docs/old'))).toBe(false);
    cleanupIsolated(dir);
  });

  it('세션 이어서 작업이면 중단 전 복사본의 작업을 보존한다', () => {
    const proj = tmpProject(); fs.mkdirSync(join(proj, 'docs'), { recursive: true });
    const dir = isolatedDir(`t4:${proj}`); const st = prepareIsolated(proj, dir, inDocs, false);
    fs.writeFileSync(join(dir, 'docs/half.md'), '중단 전 작업');
    const st2 = prepareIsolated(proj, dir, inDocs, true);
    expect(fs.readFileSync(join(dir, 'docs/half.md'), 'utf8')).toBe('중단 전 작업');
    expect(diffSnapshots(new Map(st2.before), snapshot(dir))).toContain('docs/half.md');
    void st; cleanupIsolated(dir);
  });
});

describe('실제 문서 시범에서 찾은 결함', () => {
  it('여러 담당의 결과를 함께 검토할 때 수정 요청은 지적된 파일의 담당에게 간다', async () => {
    const dir = tmpProject(); const svc = mkService(dir);
    const p = svc.createProject(plan(dir));
    const wa = svc.saveAgent(p.id, null, agentFields('01', 'A'));
    const wb = svc.saveAgent(p.id, null, agentFields('02', 'B'));
    const r = svc.saveAgent(p.id, null, agentFields('03', '검수', { tools: ['Read', 'Grep', 'Glob'] }));
    const inp = n('input', '입력');
    const a = n('agent', 'A작성', { agentId: wa.id, writeScope: ['docs/a'], outputs: [{ path: 'docs/a/table.md', format: 'markdown', required: true }] });
    const b = n('agent', 'B작성', { agentId: wb.id, instructions: '[[mock:todo-first]]', writeScope: ['docs/b'], outputs: [{ path: 'docs/b/status.md', format: 'markdown', required: true }] });
    const rv = n('review', '공동 검수', { agentId: r.id, inputs: ['docs/a/table.md', 'docs/b/status.md'] });
    // 실패 연결은 A로만 있다 — 지적이 B 파일을 가리키면 B가 재작업해야 한다
    const v = svc.saveGraph(p.id, { nodes: [inp, a, b, rv], edges: [e(inp, a), e(inp, b), e(a, rv), e(b, rv), e(rv, a, 'fail')] }, '').version!;
    const run = await svc.startRun(p.id, v.id);
    expect((await waitRun(svc, run.id, ['succeeded', 'failed'])).status).toBe('succeeded');
    const atts = svc.store.runAttempts(run.id).filter((x) => x.role === 'author');
    expect(atts.filter((x) => x.nodeId === b.id).length).toBe(2); // B 재작업
    expect(atts.filter((x) => x.nodeId === a.id).length).toBe(1); // A는 다시 하지 않음
    svc.close();
  });
});

describe('Codex 5차 반영(엔진)', () => {
  it('재작업 대상은 경계가 있는 전체 경로로 판단하고, 동점·모호하면 단정하지 않는다', () => {
    const dir = tmpProject(); const svc = mkService(dir);
    const a = n('agent', 'A', { outputs: [{ path: 'docs/report.md', format: 'markdown', required: true }] });
    const b = n('agent', 'B', { outputs: [{ path: 'docs/report.md.bak', format: 'markdown', required: true }] });
    const rv = n('review', 'R');
    const g = { nodes: [a, b, rv], edges: [e(a, rv), e(b, rv)] };
    const rt = (t: string) => (svc.engine as unknown as { reworkTarget: (g: unknown, n: unknown, t: string) => string | null }).reworkTarget(g, rv, t);
    expect(rt('docs/report.md.bak 줄 3이 틀렸다')).toBe(b.id);
    expect(rt('docs/report.md 줄 3이 틀렸다')).toBe(a.id);
    expect(rt('report.md를 고쳐라')).toBe(a.id); // 파일 이름이 정확히 한 담당과만 일치
    expect(rt('일반적인 지적')).toBeNull();
    svc.close();
  });

  it('Codex 보고서 쓰기를 동시에 실행 중인 다른 실행의 범위 밖 변경으로 오인하지 않는다', async () => {
    const dir = tmpProject(); const svc = mkService(dir);
    const p = svc.createProject(plan(dir));
    const w = svc.saveAgent(p.id, null, agentFields('01', '작성자'));
    const hold = join(dir, '..', 'HOLD-codex'); writeFileSync(hold, '1');
    const i1 = n('input', '입력1');
    const a = n('agent', '느린 A', { agentId: w.id, instructions: `[[mock:wait-while:${hold}]]`, writeScope: ['docs/a'], outputs: [{ path: 'docs/a/x.md', format: 'markdown', required: true }] });
    const v1 = svc.store.saveGraph(p.id, { nodes: [i1, a], edges: [e(i1, a)] }, '실행 1');
    const i2 = n('input', '입력2');
    const b = n('agent', 'B', { agentId: w.id, writeScope: ['docs/b'], outputs: [{ path: 'docs/b/y.md', format: 'markdown', required: true }] });
    const cx = n('codexReview', 'Codex', { inputs: ['docs/b/y.md'] });
    const v2 = svc.store.saveGraph(p.id, { nodes: [i2, b, cx], edges: [e(i2, b), e(b, cx)] }, '실행 2');
    const r1 = svc.engine.startRun(p.id, v1.id);
    while (!svc.store.runAttempts(r1.id).some((x) => x.pid)) await sleep(20);
    const r2 = svc.engine.startRun(p.id, v2.id);
    expect((await waitRun(svc, r2.id, ['succeeded', 'failed'])).status).toBe('succeeded'); // Codex 보고서 작성 완료
    require('node:fs').rmSync(hold);
    const f1 = await waitRun(svc, r1.id, ['succeeded', 'failed']);
    expect(svc.store.runAttempts(r1.id).flatMap((x) => x.outOfScopeChanges)).toEqual([]);
    expect(f1.status).toBe('succeeded');
    svc.close();
  });
});

describe('흐름 자동 정렬', () => {
  it('모든 카드가 같은 위치에 있어도 실행 순서대로 겹치지 않게 배치하고, 저장 시 정렬된 위치로 남긴다', async () => {
    const { autoLayout, needsLayout } = await import('../src/shared/layout');
    const dir = tmpProject(); const svc = mkService(dir);
    const p = svc.createProject(plan(dir));
    svc.loadAgentTemplates(p.id);
    const g0 = svc.defaultGraph(p.id);
    const stacked = { ...g0, nodes: g0.nodes.map((n) => ({ ...n, position: { x: 0, y: 0 } })) };
    expect(needsLayout(stacked)).toBe(true);
    const laid = autoLayout(stacked);
    expect(needsLayout(laid)).toBe(false);
    const y = (label: string) => laid.nodes.find((n) => n.label === label)!.position.y;
    expect(y('기획·입력')).toBeLessThan(y('담당 작업 A'));
    expect(y('통합 검사')).toBeGreaterThan(y('독립 검토'));
    expect(y('팀장 검토')).toBeGreaterThan(y('결과물 취합'));
    const saved = svc.saveGraph(p.id, stacked, '겹친 흐름').version!;
    expect(needsLayout(saved.graph)).toBe(false);
    svc.close();
  });
});
