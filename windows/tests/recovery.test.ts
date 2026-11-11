// 복구·일시정지·CLI 준비 상태·인자 안전성·LangSmith 전송 시험 (모의 CLI·가짜 서버 사용)
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, checkCli, redact } from '../src/main/cli/claudeCli';
import { createTracer } from '../src/main/langsmith';
import { Service } from '../src/main/service';
import { MOCK, agentFields, alive, e, mkService, n, plan, sleep, tmpProject, waitRun } from './helpers';

describe('5-2. 앱 비정상 종료 후 복원·재개', () => {
  it('실행 중 앱이 강제 종료돼도 기록을 복원하고, 완료 단계는 다시 실행하지 않으며, 앱이 시작한 고아 프로세스만 정리한 뒤 세션을 이어서 재개한다', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'harness ')), 'crash-run.cjs');
    await build({ entryPoints: [resolve(__dirname, 'harness/crash-run.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error', external: ['electron'] });
    const folder = tmpProject();
    writeFileSync(join(folder, 'HOLD'), '1');
    const dbFile = join(folder, '..', 'crash.sqlite');
    const child = spawn(process.execPath, [out, dbFile, folder, MOCK], { stdio: ['ignore', 'pipe', 'inherit'] });
    const line = await new Promise<string>((res, rej) => {
      let buf = ''; const t = setTimeout(() => rej(new Error(`READY 없음: ${buf}`)), 30000);
      child.stdout!.on('data', (d) => { buf += d; const m = buf.match(/READY .+/); if (m) { clearTimeout(t); res(m[0]); } });
    });
    const { runId, pid: orphan, aId, bId } = JSON.parse(line.slice(6)) as { runId: string; pid: number; aId: string; bId: string };
    child.kill('SIGKILL'); // 앱 비정상 종료
    await new Promise((r) => child.on('exit', r));
    expect(alive(orphan)).toBe(true); // 하위 Claude 프로세스는 남아 있다(고아)

    const svc = new Service({ dbFile, mockScript: MOCK, emit: () => {} });
    svc.saveSettings({ executor: 'mock' });
    await svc.engine.recoverOnStartup();
    await sleep(500);
    expect(alive(orphan)).toBe(false); // 세션 ID로 앱이 시작한 프로세스임을 확인한 뒤 종료
    expect(svc.store.getRun(runId).status).toBe('needs_resume');
    expect(svc.store.getRunNode(runId, bId).status).toBe('needs_resume');
    expect(svc.store.getRunNode(runId, aId).status).toBe('succeeded');
    await expect(svc.engine.resume(runId)).rejects.toThrow('재개 방법');
    const old = svc.store.runAttempts(runId).find((x) => x.nodeId === bId)!;
    expect(old.status).toBe('interrupted');

    rmSync(join(folder, 'HOLD'));
    svc.engine.resolveInterrupted(runId, bId, 'continue_session');
    await svc.engine.resume(runId);
    await waitRun(svc, runId, ['review_wait', 'failed']);
    expect(svc.store.getRun(runId).status).toBe('review_wait');
    const atts = svc.store.runAttempts(runId);
    expect(atts.filter((x) => x.nodeId === aId).length).toBe(1); // 완료 단계 재실행 없음
    const resumed = atts.filter((x) => x.nodeId === bId).pop()!;
    expect(resumed.resumedFrom).toBe(old.sessionId);
    expect(resumed.argvRedacted).toContain('--resume');
    expect(existsSync(join(folder, 'src/second.md'))).toBe(true);
    svc.close();
  });
});

describe('5-3. 새 배정 일시정지와 취소 구분', () => {
  it('일시정지 중에는 진행 중 작업만 끝내고 다음 작업을 배정하지 않는다', async () => {
    const dir = tmpProject();
    const svc = mkService(dir);
    const p = svc.createProject(plan(dir));
    const w = svc.saveAgent(p.id, null, agentFields('01', '작성자'));
    const hold = join(dir, '..', 'HOLD-pause'); // 프로젝트 밖(범위 밖 변경으로 잡히지 않게)
    writeFileSync(hold, '1');
    const inp = n('input', '입력');
    const a = n('agent', 'A', { agentId: w.id, instructions: `[[mock:wait-while:${hold}]]`, writeScope: ['docs'], outputs: [{ path: 'docs/a.md', format: 'markdown', required: true }] });
    const b = n('agent', 'B', { agentId: w.id, writeScope: ['src'], outputs: [{ path: 'src/b.md', format: 'markdown', required: true }] });
    const v = svc.saveGraph(p.id, { nodes: [inp, a, b], edges: [e(inp, a), e(a, b)] }, '').version!;
    const run = await svc.startRun(p.id, v.id);
    while (!svc.store.runAttempts(run.id).some((x) => x.pid)) await sleep(30);
    svc.engine.pause(run.id);
    expect(svc.store.getRun(run.id).status).toBe('paused');
    rmSync(hold);
    await sleep(1500);
    expect(svc.store.getRunNode(run.id, a.id).status).toBe('succeeded'); // 진행 중 작업은 계속
    expect(svc.store.runAttempts(run.id).filter((x) => x.nodeId === b.id && x.pid).length).toBe(0); // 새 배정 없음
    await svc.engine.resume(run.id);
    const fin = await waitRun(svc, run.id, ['succeeded', 'failed']);
    expect(fin.status).toBe('succeeded');
    svc.close();
  });
});

describe('CLI 연결 계층', () => {
  it('설치·인증 상태를 확인하고 준비되지 않은 원인을 알려 준다', async () => {
    const d = mkdtempSync(join(tmpdir(), 'fake cli '));
    const fake = join(d, 'claude');
    writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi\nif [ "$1" = "auth" ]; then echo \'{"loggedIn": false, "authMethod": "none"}\'; exit 0; fi\nexit 1\n');
    chmodSync(fake, 0o755);
    const st = await checkCli(fake);
    expect(st.path).toBe(fake); expect(st.version).toBe('9.9.9'); expect(st.ready).toBe(false);
    expect(st.problem).toContain('로그인되지 않았습니다');
    writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi\necho \'{"loggedIn": true, "authMethod": "claude.ai"}\'\n');
    const ok = await checkCli(fake);
    expect(ok.ready).toBe(true);
  });

  it('권한 검사를 끄지 않고, 작업 범위를 CLI 권한 규칙으로 전달하며, 프롬프트를 셸 인자에 넣지 않는다', () => {
    const prompt = '"; rm -rf ~; echo "$(whoami)';
    const args = buildClaudeArgs({ prompt, appendSystemPrompt: '역할', cwd: '/x', tools: ['Read', 'Edit', 'Write', 'Bash'], editScopes: ['docs/한글 폴더'], allowedCommands: ['npm test'], readDirs: [], sessionId: 'id', resumeSessionId: null, jsonSchema: null, model: '', maxBudgetUsd: null });
    expect(args).not.toContain(prompt);
    expect(args.join(' ')).not.toMatch(/dangerously|bypassPermissions/);
    expect(args).toContain('--restricted');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
    expect(settings.permissions.allow).toContain('Edit(./docs/한글 폴더/**)');
    // Windows판: OS 격리(샌드박스)가 없으므로 Bash 도구·Bash 허용 규칙을 넣지 않는다
    expect(settings.permissions.allow.some((r: string) => r.startsWith('Bash'))).toBe(false);
    expect(args[args.indexOf('--tools') + 1].split(',')).not.toContain('Bash');
    expect(settings.permissions.deny).toContain('Edit(./.git/**)');
    expect(settings.sandbox).toBeUndefined();
    const rv = buildClaudeArgs({ prompt, appendSystemPrompt: '', cwd: '/x', tools: ['Read', 'Grep', 'Glob'], editScopes: [], allowedCommands: [], readDirs: [], sessionId: 'id', resumeSessionId: null, jsonSchema: {}, model: '', maxBudgetUsd: null });
    expect(JSON.parse(rv[rv.indexOf('--settings') + 1]).permissions.allow.some((r: string) => r.startsWith('Edit'))).toBe(false);
  });

  it('비밀값 마스킹', () => {
    expect(redact('key sk-ant-api03-abcdefghijklmn and Bearer abcdefghijklmnop password=hunter2hunter')).not.toMatch(/abcdefghijklmn|hunter2/);
  });
});

describe('LangSmith 추적(가짜 수신 서버)', () => {
  it('실행 ID로 추적을 보내고 프롬프트 원문·고객 원문·키를 본문에 넣지 않는다. 연결이 없어도 로컬 실행은 동작한다', async () => {
    const bodies: string[] = []; const headers: string[] = [];
    const server = createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { bodies.push(`${req.method} ${req.url} ${b}`); headers.push(JSON.stringify(req.headers)); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const dir = tmpProject();
    const KEY = 'lsv2_pt_FAKEKEYFAKEKEYFAKEKEY_123';
    const svc = mkService(dir, [], { tracer: () => createTracer(() => ({ enabled: true, apiKey: KEY, endpoint: `http://127.0.0.1:${port}`, project: 'test' }), () => {}) });
    const p = svc.createProject(plan(dir, { goal: '고객원문XYZ 비공개 목표' }));
    const w = svc.saveAgent(p.id, null, agentFields('01', '작성자'));
    const inp = n('input', '입력'); const a = n('agent', 'A', { agentId: w.id, writeScope: ['docs'], outputs: [{ path: 'docs/a.md', format: 'markdown', required: true }] });
    const v = svc.saveGraph(p.id, { nodes: [inp, a], edges: [e(inp, a)] }, '').version!;
    const run = await svc.startRun(p.id, v.id);
    await waitRun(svc, run.id, ['succeeded', 'failed']);
    await sleep(1500);
    server.close();
    const all = bodies.join('\n');
    expect(bodies.length).toBeGreaterThan(0);
    expect(all).toContain(run.id);
    expect(all).not.toContain('고객원문XYZ');
    expect(all).not.toContain(KEY);
    expect(all).not.toContain('CREWGENAI 업무 지시'); // 프롬프트 본문 미전송
    expect(svc.store.getRun(run.id).status).toBe('succeeded');
    svc.close();

    // 연결 실패(닫힌 포트)여도 로컬 실행은 성공
    const dir2 = tmpProject();
    const svc2 = mkService(dir2, [], { tracer: () => createTracer(() => ({ enabled: true, apiKey: KEY, endpoint: 'http://127.0.0.1:9', project: 'x' }), () => {}) });
    const p2 = svc2.createProject(plan(dir2));
    const w2 = svc2.saveAgent(p2.id, null, agentFields('01', '작성자'));
    const i2 = n('input', '입력'); const a2 = n('agent', 'A', { agentId: w2.id, writeScope: ['docs'], outputs: [{ path: 'docs/a.md', format: 'markdown', required: true }] });
    const v2 = svc2.saveGraph(p2.id, { nodes: [i2, a2], edges: [e(i2, a2)] }, '').version!;
    const r2 = await svc2.startRun(p2.id, v2.id);
    expect((await waitRun(svc2, r2.id, ['succeeded', 'failed'])).status).toBe('succeeded');
    svc2.close();
  });
});
