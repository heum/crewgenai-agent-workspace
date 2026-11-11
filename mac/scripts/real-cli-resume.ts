// 실제 Claude: 앱 강제 종료 후 세션 이어서 재개 확인(모의 아님)
// 사용: node dist/verify/real-cli-resume.cjs <출력 폴더>
// 1) 하위 프로세스(앱 역할)가 실제 Claude 실행을 시작하고 첫 도구 사용 이벤트 뒤 READY를 알린다
// 2) 상위가 하위를 SIGKILL로 강제 종료(앱 비정상 종료)
// 3) 새 Service로 복구 → 고아 Claude 프로세스 정리 → '세션 이어서 작업' 선택 → 재개 → 완료 확인
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Service } from '../src/main/service';
import type { AgentFields, GraphNode } from '../src/shared/types';

const af = (code: string, name: string): AgentFields => ({ code, name, role: name, instructions: `${name}로서 지시된 파일만 작성한다.`, references: [], workPaths: [], tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'], allowedCommands: [], expectedOutput: '', doneCriteria: '지정 파일 작성', reviewerAgentId: null, model: '', maxBudgetUsd: 0.5, timeoutSec: 600, maxRetries: 0, active: true });
const n = (id: string, kind: GraphNode['kind'], label: string, x: Partial<GraphNode> = {}): GraphNode => ({ id, kind, label, position: { x: 0, y: 0 }, agentId: null, reviewerAgentId: null, instructions: '', inputs: [], useUpstreamOutputs: true, outputs: [], doneCriteria: '', command: [], writeScope: [], maxRetries: 0, maxVisits: 2, timeoutSec: 600, condition: null, entryCondition: 'all', ...x });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function child(out: string) {
  const proj = join(out, '재개 시험 프로젝트');
  mkdirSync(join(proj, 'docs'), { recursive: true });
  const svc = new Service({ dbFile: join(out, 'resume.sqlite'), mockScript: '', emit: () => {} });
  svc.saveSettings({ executor: 'claude' });
  const p = svc.createProject({ name: '실제 재개 시험', goal: '세션 재개', folder: proj, referenceDocs: [], priorOutputs: [], deliverable: 'docs/steps.md', doneCriteria: '파일 완성', writablePaths: ['docs'], scope: 'docs', outputDir: 'docs/out' });
  const w = svc.saveAgent(p.id, null, af('01', '작성자'));
  const g = svc.saveGraph(p.id, { nodes: [n('in', 'input', '입력'), n('w', 'agent', '단계 문서', { agentId: w.id, writeScope: ['docs'],
    instructions: 'docs/steps.md 파일을 만든다. 먼저 "# 단계" 제목만 쓴 뒤, 1단계부터 5단계까지 한 단계씩 Edit 도구로 한 줄씩 추가한다(총 다섯 번 수정). 마지막 줄에 "완료"를 쓴다.',
    outputs: [{ path: 'docs/steps.md', format: 'markdown', required: true }] })], edges: [{ id: 'e', source: 'in', target: 'w', kind: 'next' }] }, '재개 시험');
  const run = await svc.startRun(p.id, g.version!.id);
  for (;;) {
    const a = svc.store.runAttempts(run.id)[0];
    if (a?.pid && svc.store.events(a.id).some((e) => e.kind === 'tool')) { console.log(`READY ${JSON.stringify({ runId: run.id, pid: a.pid, sessionId: a.sessionId, nodeId: 'w', proj })}`); break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  setInterval(() => {}, 1000);
}

async function parent(out: string) {
  mkdirSync(out, { recursive: true });
  const c = spawn(process.execPath, [__filename, '--child', out], { stdio: ['ignore', 'pipe', 'inherit'] });
  const line = await new Promise<string>((res, rej) => { let b = ''; const t = setTimeout(() => rej(new Error('READY 없음')), 300000); c.stdout!.on('data', (d) => { b += d; const m = b.match(/READY .+/); if (m) { clearTimeout(t); res(m[0]); } }); });
  const info = JSON.parse(line.slice(6)) as { runId: string; pid: number; sessionId: string; nodeId: string; proj: string };
  c.kill('SIGKILL'); await new Promise((r) => c.on('exit', r));
  const orphanAliveAfterCrash = alive(info.pid);
  const fileAtCrash = existsSync(join(info.proj, 'docs/steps.md')) ? readFileSync(join(info.proj, 'docs/steps.md'), 'utf8') : null;
  const svc = new Service({ dbFile: join(out, 'resume.sqlite'), mockScript: '', emit: () => {} });
  await svc.engine.recoverOnStartup();
  await new Promise((r) => setTimeout(r, 1500));
  const orphanAliveAfterRecover = alive(info.pid);
  const runAfterRecover = svc.store.getRun(info.runId).status;
  svc.engine.resolveInterrupted(info.runId, info.nodeId, 'continue_session');
  await svc.cliStatus(true);
  await svc.engine.resume(info.runId);
  for (;;) { const r = svc.store.getRun(info.runId); if (!svc.engine.isActive(info.runId) && ['succeeded', 'failed', 'needs_resume', 'cancelled'].includes(r.status)) break; await new Promise((x) => setTimeout(x, 500)); }
  const atts = svc.store.runAttempts(info.runId);
  const result = {
    orphanAliveAfterCrash, orphanAliveAfterRecover, runAfterRecover, fileAtCrash,
    final: svc.store.getRun(info.runId).status, reason: svc.store.getRun(info.runId).reason,
    attempts: atts.map((a) => ({ status: a.status, sessionId: a.sessionId, resumedFrom: a.resumedFrom, resumeArg: a.argvRedacted.includes('--resume'), exit: a.exitCode, isError: a.isError, cost: a.costUsd, error: a.error.slice(0, 200) })),
    sameSession: atts.length > 1 && atts[1].resumedFrom === atts[0].sessionId,
    finalFile: existsSync(join(info.proj, 'docs/steps.md')) ? readFileSync(join(info.proj, 'docs/steps.md'), 'utf8') : null,
  };
  writeFileSync(join(out, 'real-resume-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 1));
  svc.close();
}

if (process.argv[2] === '--child') void child(resolve(process.argv[3]));
else void parent(resolve(process.argv[2] ?? 'real-resume-out')).catch((e) => { console.error(e); process.exit(1); });
