// 실제 Claude CLI 연결 검사(모의 아님). 별도 시험 프로젝트에서 제한된 작업 하나를 실행한다.
// 사용: npm run verify:real-cli -- <출력 폴더>
// 결과: <출력 폴더>/real-cli-result.json
// - CLI 준비(설치·버전·인증) 상태
// - 준비된 경우: 작성 → 독립 검토 → 취합 → 검토 대기까지 실제 실행, 이벤트·종료 상태·세션·산출물 기록
// - 준비되지 않은 경우: 앱의 실행 차단을 확인하고, 엔진으로 실제 CLI 프로세스를 한 번 실행해 실패가 완료로 처리되지 않는지 기록
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Service } from '../src/main/service';
import type { GraphNode, AgentFields } from '../src/shared/types';

const out = resolve(process.argv[2] ?? 'real-cli-out');
const proj = join(out, '실제 CLI 시험 프로젝트');
mkdirSync(join(proj, 'docs'), { recursive: true });
writeFileSync(join(proj, 'README.md'), '# 시험 프로젝트\n\n이 폴더는 CREWGENAI 개발팀 관리 앱의 실제 CLI 연결 시험용이다.\n');
const svc = new Service({ dbFile: join(out, 'real-cli.sqlite'), mockScript: '', emit: () => {} });
svc.saveSettings({ executor: 'claude', maxConcurrent: 2 });

const af = (code: string, name: string, x: Partial<AgentFields> = {}): AgentFields => ({ code, name, role: name, instructions: `${name}로서 지시된 파일만 작성한다.`, references: [], workPaths: [], tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'], allowedCommands: [], expectedOutput: '', doneCriteria: '지정 파일 작성', reviewerAgentId: null, model: '', maxBudgetUsd: 0.5, timeoutSec: 300, maxRetries: 0, active: true, ...x });
const n = (id: string, kind: GraphNode['kind'], label: string, x: Partial<GraphNode> = {}): GraphNode => ({ id, kind, label, position: { x: 0, y: 0 }, agentId: null, reviewerAgentId: null, instructions: '', inputs: [], useUpstreamOutputs: true, outputs: [], doneCriteria: '', command: [], writeScope: [], maxRetries: 0, maxVisits: 2, timeoutSec: 300, condition: null, entryCondition: 'all', ...x });

async function main() {
  const report: Record<string, unknown> = { at: new Date().toISOString(), executor: 'claude(실제 CLI)' };
  const st = await svc.cliStatus(true);
  report.cli = { path: st.path, source: st.source, version: st.version, loggedIn: st.loggedIn, authMethod: st.authMethod, ready: st.ready, problem: st.problem, candidates: st.candidates.length };
  const p = svc.createProject({ name: '실제 CLI 시험', goal: 'docs/hello.md에 한 줄 인사말 작성', folder: proj, referenceDocs: [], priorOutputs: [], deliverable: 'docs/hello.md', doneCriteria: '파일 존재', writablePaths: ['docs'], scope: 'docs만', outputDir: 'docs/out' });
  const w = svc.saveAgent(p.id, null, af('01', '작성자'));
  const r = svc.saveAgent(p.id, null, af('02', '검토자', { tools: ['Read', 'Grep', 'Glob'] }));
  const inp = n('in', 'input', '입력');
  const a = n('w', 'agent', '인사말 작성', { agentId: w.id, instructions: 'docs/hello.md 파일을 만들고 "안녕하세요, CREWGENAI 시험입니다." 한 줄만 쓴다. 다른 파일은 만들거나 고치지 않는다.', writeScope: ['docs'], outputs: [{ path: 'docs/hello.md', format: 'markdown', required: true }], doneCriteria: 'docs/hello.md에 인사말 한 줄' });
  const rv = n('rv', 'review', '독립 검토', { agentId: r.id, inputs: ['docs/hello.md'], doneCriteria: 'docs/hello.md에 한국어 인사말 한 줄이 있다' });
  const m = n('m', 'merge', '취합'); const ur = n('ur', 'userReview', '팀장 검토');
  const saved = svc.saveGraph(p.id, { nodes: [inp, a, rv, m, ur], edges: [
    { id: 'e1', source: 'in', target: 'w', kind: 'next' }, { id: 'e2', source: 'w', target: 'rv', kind: 'next' }, { id: 'e3', source: 'rv', target: 'm', kind: 'next' },
    { id: 'e4', source: 'm', target: 'ur', kind: 'next' }, { id: 'e5', source: 'rv', target: 'w', kind: 'fail' }, { id: 'e6', source: 'ur', target: 'w', kind: 'fail' }] }, '실제 CLI 시험');
  if (!saved.version) throw new Error(JSON.stringify(saved.issues));

  let runId: string;
  try {
    runId = (await svc.startRun(p.id, saved.version.id)).id;
    report.appGate = '준비됨 — 앱에서 실행 시작';
  } catch (e) {
    report.appGate = `앱이 실행을 차단함: ${(e as Error).message}`;
    // 엔진으로 실제 CLI 프로세스를 직접 한 번 실행(인증 실패 시 실패 판정 확인용)
    runId = svc.engine.startRun(p.id, saved.version.id).id;
  }
  const t0 = Date.now();
  for (;;) {
    const run = svc.store.getRun(runId);
    if (!svc.engine.isActive(runId) && ['review_wait', 'failed', 'succeeded', 'cancelled', 'needs_resume'].includes(run.status)) break;
    if (Date.now() - t0 > 15 * 60 * 1000) { await svc.engine.cancel(runId); break; }
    await new Promise((res) => setTimeout(res, 500));
  }
  const d = svc.engine.detail(runId);
  report.run = { id: runId, status: d.run.status, reason: d.run.reason, executor: d.run.executor };
  report.nodes = d.nodes.map((x) => ({ node: d.graph.nodes.find((g) => g.id === x.nodeId)?.label, status: x.status, visits: x.visits, failure: x.failureReason }));
  report.attempts = d.attempts.map((x) => ({ node: x.nodeId, role: x.role, status: x.status, exitCode: x.exitCode, resultSubtype: x.resultSubtype, isError: x.isError, sessionId: x.sessionId, costUsdReported: x.costUsd, permissionDenials: x.permissionDenials, outOfScope: x.outOfScopeChanges, changed: x.changedFiles, acceptance: x.acceptance, summary: x.summary.slice(0, 400), error: x.error,
    events: svc.store.events(x.id).map((e) => `${e.kind}: ${e.summary}`).slice(0, 30) }));
  report.helloFile = existsSync(join(proj, 'docs/hello.md')) ? readFileSync(join(proj, 'docs/hello.md'), 'utf8') : null;
  report.artifacts = d.artifacts.map((x) => ({ rel: x.relPath, kind: x.kind, sha: x.sha256.slice(0, 16) }));
  report.reviews = d.reviews.map((x) => ({ kind: x.kind, verdict: x.verdict, comments: x.comments.slice(0, 300) }));
  writeFileSync(join(out, 'real-cli-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ cli: report.cli, appGate: report.appGate, run: report.run }, null, 2));
  svc.close();
}
void main().catch((e) => { console.error(e); process.exit(1); });
