// 실제 Claude CLI 시나리오 검사(모의 아님): 재작업·병렬 합류·취소
// 사용: npm run verify:real-scenarios -- <출력 폴더>   (로그인 필요, 소액 비용 발생, 직원별 비용 한도 $0.5)
// 결과: <출력 폴더>/real-scenarios-result.json
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Service } from '../src/main/service';
import type { AgentFields, GraphNode } from '../src/shared/types';

const out = resolve(process.argv[2] ?? 'real-scenarios-out');
const proj = join(out, '실제 시나리오 시험 프로젝트');
mkdirSync(join(proj, 'docs'), { recursive: true });
writeFileSync(join(proj, 'README.md'), '# 시험 프로젝트\n\nCREWGENAI 개발팀 관리 앱의 실제 CLI 시나리오 시험용 폴더.\n');
// 검사 코드(수정 허용 영역 밖): plan.md에 '버전2' 문구가 있어야 통과
writeFileSync(join(proj, 'check-plan.cjs'), "const fs=require('fs');const p='docs/a/plan.md';if(!fs.existsSync(p)){console.error('docs/a/plan.md 없음');process.exit(1)}const t=fs.readFileSync(p,'utf8');if(!t.includes('버전2')){console.error(\"필수 문구 '버전2'가 없습니다. 파일 첫 줄에 '버전2'를 넣으세요.\");process.exit(1)}console.log('통과')\n");

const svc = new Service({ dbFile: join(out, 'scenarios.sqlite'), mockScript: '', emit: () => {} });
svc.saveSettings({ executor: 'claude', maxConcurrent: 3 });
const af = (code: string, name: string, x: Partial<AgentFields> = {}): AgentFields => ({ code, name, role: name, instructions: `${name}로서 지시된 파일만 작성한다.`, references: [], workPaths: [], tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'], allowedCommands: [], expectedOutput: '', doneCriteria: '지정 파일 작성', reviewerAgentId: null, model: '', maxBudgetUsd: 0.5, timeoutSec: 300, maxRetries: 0, active: true, ...x });
const n = (id: string, kind: GraphNode['kind'], label: string, x: Partial<GraphNode> = {}): GraphNode => ({ id, kind, label, position: { x: 0, y: 0 }, agentId: null, reviewerAgentId: null, instructions: '', inputs: [], useUpstreamOutputs: true, outputs: [], doneCriteria: '', command: [], writeScope: [], maxRetries: 0, maxVisits: 3, timeoutSec: 300, condition: null, entryCondition: 'all', ...x });
const ed = (s: string, t: string, kind: 'next' | 'fail' = 'next') => ({ id: `${s}-${t}-${kind}`, source: s, target: t, kind });

async function wait(runId: string, ms = 15 * 60 * 1000) {
  const t0 = Date.now();
  for (;;) {
    const r = svc.store.getRun(runId);
    if (!svc.engine.isActive(runId) && ['review_wait', 'failed', 'succeeded', 'cancelled', 'needs_resume'].includes(r.status)) return r;
    if (Date.now() - t0 > ms) { await svc.engine.cancel(runId); }
    await new Promise((res) => setTimeout(res, 500));
  }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function main() {
  const report: Record<string, unknown> = { at: new Date().toISOString(), executor: 'claude(실제 CLI)' };
  const st = await svc.cliStatus(true);
  report.cli = { version: st.version, loggedIn: st.loggedIn, ready: st.ready };
  if (!st.ready) { writeFileSync(join(out, 'real-scenarios-result.json'), JSON.stringify({ ...report, error: st.problem }, null, 2)); console.log('CLI 준비 안 됨:', st.problem); svc.close(); return; }
  const p = svc.createProject({ name: '실제 시나리오 시험', goal: '재작업·병렬·취소 확인', folder: proj, referenceDocs: [], priorOutputs: [], deliverable: 'docs/a, docs/b', doneCriteria: '검사 통과', writablePaths: ['docs'], scope: 'docs만', outputDir: 'docs/out' });
  const wa = svc.saveAgent(p.id, null, af('01', '작성자A'));
  const wb = svc.saveAgent(p.id, null, af('02', '작성자B'));

  // 시나리오 1: 병렬 작성(A·B) → A 검사 실패 → A 재작업 → 검사 통과 → 합류 → 취합
  const g1 = svc.saveGraph(p.id, {
    nodes: [
      n('in', 'input', '입력'),
      n('a', 'agent', '계획 작성', { agentId: wa.id, instructions: 'docs/a/plan.md 파일에 오늘 할 일 세 줄을 한국어 목록으로 쓴다. 다른 파일은 만들지 않는다.', writeScope: ['docs/a'], outputs: [{ path: 'docs/a/plan.md', format: 'markdown', required: true }] }),
      n('b', 'agent', '메모 작성', { agentId: wb.id, instructions: 'docs/b/notes.md 파일에 "병렬 작업 메모" 한 줄을 쓴다. 다른 파일은 만들지 않는다.', writeScope: ['docs/b'], outputs: [{ path: 'docs/b/notes.md', format: 'markdown', required: true }] }),
      n('c', 'check', '계획 검사', { command: [process.execPath, 'check-plan.cjs'], timeoutSec: 60 }),
      n('m', 'merge', '취합'),
    ],
    edges: [ed('in', 'a'), ed('in', 'b'), ed('a', 'c'), ed('c', 'a', 'fail'), ed('c', 'm'), ed('b', 'm')],
  }, '실제 시나리오 1');
  if (!g1.version) throw new Error(JSON.stringify(g1.issues));
  const r1 = await svc.startRun(p.id, g1.version.id);
  const f1 = await wait(r1.id);
  const d1 = svc.engine.detail(r1.id);
  const lab = (id: string) => d1.graph.nodes.find((x) => x.id === id)?.label ?? id;
  const ev = (aid: string) => svc.store.events(aid);
  const span = (nodeId: string) => d1.attempts.filter((a) => a.nodeId === nodeId && a.role === 'author').map((a) => { const e = ev(a.id); return { visit: a.visit, start: e[0]?.at, end: e.at(-1)?.at, status: a.status, cost: a.costUsd }; });
  report.scenario1 = {
    status: f1.status, reason: f1.reason,
    nodes: d1.nodes.map((x) => ({ node: lab(x.nodeId), status: x.status, visits: x.visits })),
    checks: d1.checks.map((c) => ({ ok: c.ok, exit: c.exitCode, output: c.output.trim().slice(0, 200) })),
    authorA: span('a'), authorB: span('b'),
    parallelOverlap: (() => { const a = span('a')[0], b = span('b')[0]; return !!(a && b && a.start! < b.end! && b.start! < a.end!); })(),
    planFile: existsSync(join(proj, 'docs/a/plan.md')) ? readFileSync(join(proj, 'docs/a/plan.md'), 'utf8') : null,
    outOfScope: d1.attempts.flatMap((a) => a.outOfScopeChanges), denials: d1.attempts.flatMap((a) => a.permissionDenials),
    costReportedUsd: d1.attempts.reduce((s, a) => s + (a.costUsd ?? 0), 0),
  };

  // 시나리오 2: 실제 Claude 실행 중 취소 → 프로세스 종료 확인
  const g2 = svc.saveGraph(p.id, { nodes: [n('in2', 'input', '입력'), n('long', 'agent', '긴 작업', { agentId: wa.id, instructions: 'docs/a/long.md에 1부터 200까지의 숫자마다 한 문장씩 설명을 쓴다. 한 번에 쓰지 말고 여러 번 나누어 추가한다.', writeScope: ['docs/a'], outputs: [{ path: 'docs/a/long.md', format: 'markdown', required: true }] })], edges: [ed('in2', 'long')] }, '실제 시나리오 2');
  if (!g2.version) throw new Error(JSON.stringify(g2.issues));
  const r2 = await svc.startRun(p.id, g2.version.id);
  let pid = 0;
  for (let i = 0; i < 600; i++) { const a = svc.store.runAttempts(r2.id)[0]; if (a?.pid && svc.store.events(a.id).length >= 1) { pid = a.pid; break; } await new Promise((r) => setTimeout(r, 200)); }
  const aliveBefore = pid ? alive(pid) : false;
  await svc.engine.cancel(r2.id);
  const f2 = await wait(r2.id, 60000);
  await new Promise((r) => setTimeout(r, 1500));
  const a2 = svc.store.runAttempts(r2.id)[0];
  report.scenario2 = { status: f2.status, pid, aliveBeforeCancel: aliveBefore, aliveAfterCancel: pid ? alive(pid) : null, attemptStatus: a2?.status, events: a2 ? svc.store.events(a2.id).map((e) => `${e.kind}: ${e.summary}`).slice(0, 8) : [] };

  // 시나리오 3: Bash 작성자 격리 실행 — 범위 안 산출물 + 범위 밖 파일 생성 시도(touch) → 실제 프로젝트에 범위 밖 파일이 생기면 안 된다
  const wc = svc.saveAgent(p.id, null, { ...af('03', 'Bash 작성자'), tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'], allowedCommands: ['touch', 'ls'] });
  const g3 = svc.saveGraph(p.id, { nodes: [n('in3', 'input', '입력'), n('bash', 'agent', 'Bash 작업', { agentId: wc.id, writeScope: ['docs/c'], maxVisits: 1,
    instructions: '1) Bash 도구로 정확히 `touch outside-probe.txt` 한 명령만 단독으로 실행한다(echo·;·&& 등 다른 명령과 결합 금지). 2) Bash 도구로 정확히 `touch docs/c/result.md` 한 명령만 단독으로 실행한 뒤, Write 도구로 docs/c/result.md에 "격리 시험" 한 줄을 쓴다. 각 결과를 보고한다.',
    outputs: [{ path: 'docs/c/result.md', format: 'markdown', required: true }] })], edges: [ed('in3', 'bash')] }, '실제 시나리오 3');
  if (!g3.version) throw new Error(JSON.stringify(g3.issues));
  const r3 = await svc.startRun(p.id, g3.version.id);
  const f3 = await wait(r3.id);
  const a3 = svc.store.runAttempts(r3.id)[0];
  report.scenario3 = { status: f3.status, outsideFileInProject: existsSync(join(proj, 'outside-probe.txt')), resultInProject: existsSync(join(proj, 'docs/c/result.md')),
    outOfScope: a3?.outOfScopeChanges, denials: a3?.permissionDenials, attemptStatus: a3?.status, error: a3?.error.slice(0, 300), events: a3 ? svc.store.events(a3.id).map((e) => `${e.kind}: ${e.summary}`).slice(0, 12) : [] };

  writeFileSync(join(out, 'real-scenarios-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ s1: { status: (report.scenario1 as { status: string }).status, parallel: (report.scenario1 as { parallelOverlap: boolean }).parallelOverlap }, s2: report.scenario2, s3: report.scenario3 }, null, 2));
  svc.close();
}
void main().catch((e) => { console.error(e); process.exit(1); });
