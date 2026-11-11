// 실제 오퍼레이터 루프 시범(모의 아님): 실제 Claude(오퍼레이터·담당·재검토) + 실제 Codex(리뷰)
// 사용: node dist/verify/real-mission.cjs <앱 DB> <프로젝트 폴더> <결과 JSON> "<지시>"
// 앱 데이터에 기록하므로 앱의 '운영' 탭에서 진행·결과를 볼 수 있다. 사용자 확인 대기·완료 보고에서 멈춘다.
import { writeFileSync } from 'node:fs';
import { Service } from '../src/main/service';

const [dbFile, folder, outJson, prompt] = process.argv.slice(2);
const svc = new Service({ dbFile, mockScript: '', emit: () => {} });

async function main() {
  svc.saveSettings({ executor: 'claude', maxConcurrent: 3, missionMaxCycles: 2, codexModel: 'gpt-6.1-sol', codexEffort: 'high' });
  const NAME = '조달크루 문서 시범(2026-11-10)';
  const p = svc.store.listProjects().find((x) => x.plan.name === NAME && x.plan.folder === folder)
    ?? svc.createProject({ name: NAME, goal: '조달크루 첫 흐름 문서를 근거와 함께 정리한다.', folder, referenceDocs: [], priorOutputs: [], deliverable: '근거가 달린 정리 문서', doneCriteria: '모든 내용에 원문 파일·줄 근거가 있고 원본 docs는 수정하지 않는다.', writablePaths: ['crewgenai-output'], scope: '읽기·정리만', outputDir: 'crewgenai-output' });
  for (const a of svc.loadAgentTemplates(p.id)) { const { id, projectId, version: _v, updatedAt: _u, ...f } = a; svc.saveAgent(projectId, id, { ...f, maxBudgetUsd: 2, timeoutSec: 1800 }); }
  const cx = await svc.codexStatus(true);
  const m0 = await svc.startMission(p.id, prompt);
  const t0 = Date.now();
  for (;;) {
    const m = svc.missions.get(m0.id);
    if (['waiting_user', 'done', 'stopped', 'failed'].includes(m.status)) break;
    if (Date.now() - t0 > 60 * 60 * 1000) { await svc.missions.stop(m0.id); break; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  const d = svc.missions.detail(m0.id);
  const runs = d.cycles.map((c) => svc.engine.detail(c.runId));
  const result = {
    missionId: m0.id, projectId: p.id, codex: { version: cx.version, ready: cx.ready }, minutes: ((Date.now() - t0) / 60000).toFixed(1),
    mission: { status: d.mission.status, stage: d.mission.stage, cycle: d.mission.cycle, question: d.mission.question, summary: d.mission.summary },
    events: d.events.map((e) => ({ kind: e.kind, cycle: e.cycle, text: e.text.slice(0, 500) })),
    cycles: runs.map((r, i) => ({
      cycle: d.cycles[i].cycle, status: r.run.status, reason: r.run.reason,
      nodes: r.nodes.map((n) => ({ node: r.graph.nodes.find((g) => g.id === n.nodeId)?.label, kind: r.graph.nodes.find((g) => g.id === n.nodeId)?.kind, status: n.status, visits: n.visits })),
      attempts: r.attempts.map((a) => ({ node: r.graph.nodes.find((g) => g.id === a.nodeId)?.label, role: a.role, visit: a.visit, status: a.status, costUsd: a.costUsd, error: a.error.slice(0, 160) })),
      reviews: r.reviews.map((x) => ({ kind: x.kind, verdict: x.verdict, comments: x.comments.slice(0, 500) })),
      billing: r.billing, report: r.deliverable?.reportPath ?? null,
    })),
  };
  writeFileSync(outJson, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status: result.mission.status, cycle: result.mission.cycle, question: result.mission.question?.slice(0, 300), minutes: result.minutes, cycles: result.cycles.map((c) => c.status) }, null, 1));
  svc.close();
}
void main().catch((e) => { console.error(e); svc.close(); process.exit(1); });
