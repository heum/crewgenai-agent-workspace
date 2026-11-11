// 최종 결과물(한 개) 생성 — 목표와 실제 결과, 사용법, 변경, 검증 근거, 실패·미검증, 결정 필요 사항
import type { Agent, Artifact, Attempt, CheckResult, PlanFields, ReviewRecord, Run, RunNodeState, WorkGraph } from '../../shared/types';
import { NODE_STATUS_LABEL, billingLabel, type Billing } from '../../shared/types';

const KIND_LABEL: Record<string, string> = { code: '코드 변경', document: '문서', image: '이미지', report: '검사·결과 보고서', executable: '실행 가능한 결과', data: '데이터', other: '기타' };

export function buildReport(p: {
  billing: Billing; run: Run; plan: PlanFields; graph: WorkGraph; agents: Agent[]; nodes: RunNodeState[]; attempts: Attempt[];
  artifacts: Artifact[]; checks: CheckResult[]; reviews: ReviewRecord[];
}): string {
  const { run, plan, graph, agents, nodes, attempts, artifacts, checks, reviews } = p;
  const label = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? id;
  const agentName = (id: string | null) => (id ? agents.find((a) => a.id === id)?.name ?? '(삭제된 담당)' : '-');
  const st = new Map(nodes.map((n) => [n.nodeId, n]));
  const L: string[] = [];
  L.push(`# 결과물 — ${plan.name}`, '');
  L.push(`- 실행 ID: \`${run.id}\``, `- 흐름 버전: v${run.graphVersion} · 기획 버전: v${run.planVersion}`);
  L.push(`- 실행 방식: ${run.executor === 'mock' ? '**모의 실행(시험용, 실제 Claude 미사용)**' : '실제 Claude CLI'}`, `- 생성: ${new Date().toISOString()}`, '');
  L.push('## 요청한 목표', '', plan.goal || '(미입력)', '', '### 원하는 결과물', '', plan.deliverable || '(미입력)', '', '### 완료 조건', '', plan.doneCriteria || '(미입력)', '');

  L.push('## 실제 결과', '');
  L.push('| 단계 | 담당 | 상태 | 방문 | 요약 |', '| --- | --- | --- | --- | --- |');
  for (const n of graph.nodes) {
    const s = st.get(n.id);
    L.push(`| ${n.label} | ${agentName(n.agentId)} | ${s ? NODE_STATUS_LABEL[s.status] : '-'} | ${s?.visits ?? 0} | ${(s?.summary || s?.failureReason || '').replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 160)} |`);
  }
  L.push('');

  L.push('## 작동하는 기능과 사용법(담당 보고)', '');
  const finals = graph.nodes.filter((n) => n.kind === 'agent').map((n) => {
    const a = attempts.filter((x) => x.nodeId === n.id && x.role === 'author' && (x.status === 'succeeded' || (x.status === 'interrupted' && x.acceptance?.ok))).pop(); // 중단 후 '산출물만 확인'으로 진행한 시도 포함(CLI 성공 미확인 표시)
    return a ? `### ${n.label} (${agentName(n.agentId)})\n\n${a.summary.trim() || '(보고 없음)'}\n` : `### ${n.label}\n\n성공한 작성 시도가 없습니다.\n`;
  });
  L.push(...(finals.length ? finals : ['(Agent 작업 단계 없음)']), '');

  L.push('## 주요 변경', '');
  const changed = new Map<string, Set<string>>();
  for (const a of attempts) for (const f of a.changedFiles) { if (!changed.has(a.nodeId)) changed.set(a.nodeId, new Set()); changed.get(a.nodeId)!.add(f); }
  if (!changed.size) L.push('- 탐지된 파일 변경 없음');
  for (const [nid, files] of changed) L.push(`- ${label(nid)}: ${[...files].slice(0, 30).map((f) => `\`${f}\``).join(', ')}${files.size > 30 ? ` 외 ${files.size - 30}개` : ''}`);
  L.push('');

  L.push('## 산출물', '');
  const byKind = new Map<string, Artifact[]>();
  for (const a of artifacts) { if (!byKind.has(a.kind)) byKind.set(a.kind, []); byKind.get(a.kind)!.push(a); }
  if (!byKind.size) L.push('- 등록된 산출물 없음');
  for (const [k, list] of byKind) { L.push(`### ${KIND_LABEL[k] ?? k}`); for (const a of list) L.push(`- \`${a.relPath}\` (${a.size}B, sha256 ${a.sha256.slice(0, 12)}…) — ${label(a.nodeId)}`); }
  L.push('');

  L.push('## 검증 근거', '');
  if (!checks.length) L.push('- 실행된 명령 검사 없음');
  for (const c of checks) L.push(`- ${c.ok ? '통과' : '실패'} · ${label(c.nodeId)} · \`${c.argv.join(' ')}\` · 종료 코드 ${c.exitCode ?? '없음'} · ${c.durationMs}ms`);
  for (const r of reviews) L.push(`- ${r.kind === 'agent' ? '독립 검토' : '팀장 검토'} · ${label(r.nodeId)} · ${agentName(r.reviewerAgentId)} · ${r.verdict}${r.stale ? ' (무효: 대상 변경)' : ''} — ${r.comments.replace(/\n/g, ' ').slice(0, 200)}`);
  for (const a of attempts.filter((x) => x.acceptance)) L.push(`- 완료 판정 · ${label(a.nodeId)} #${a.visit}-${a.attemptNo}: ${a.acceptance!.ok ? '충족' : '미충족'} (${a.acceptance!.checks.filter((c) => !c.ok).map((c) => c.name).join(', ') || '모든 항목 충족'})`);
  L.push('');

  L.push('## 실패·미검증·남은 제한', '');
  const issues: string[] = [];
  for (const a of attempts) {
    if (['failed', 'timeout', 'cancelled', 'interrupted'].includes(a.status)) issues.push(`${label(a.nodeId)} 시도 #${a.visit}-${a.attemptNo} ${a.status}: ${a.error || a.resultSubtype || ''}`.trim());
    for (const d of a.permissionDenials) issues.push(`${label(a.nodeId)} 권한 거부: ${d}`);
    for (const f of a.outOfScopeChanges) issues.push(`${label(a.nodeId)} 범위 밖 변경 탐지: ${f}`);
    if (a.acceptance?.checks.some((c) => c.name.startsWith('CLI 종료 결과(확인 생략)'))) issues.push(`${label(a.nodeId)} 시도 #${a.visit}-${a.attemptNo}: CLI 성공을 확인하지 못했다(사용자가 산출물만 확인 선택).`);
  }
  if (run.executor === 'mock') issues.push('모의 실행 결과다. 실제 Claude 작업 품질은 검증되지 않았다.');
  const reported = attempts.filter((a) => a.costUsd !== null);
  issues.push(reported.length ? `${billingLabel(p.billing)}: CLI 보고 합계 $${reported.reduce((s, a) => s + (a.costUsd ?? 0), 0).toFixed(4)} (${reported.length}/${attempts.filter((a) => a.role !== 'check').length}개 시도 보고, 나머지 미보고)` : `${billingLabel(p.billing)}: CLI가 보고한 값이 없어 측정하지 못했다.`);
  L.push(...issues.map((i) => `- ${i}`), '');

  L.push('## 사용자 결정이 필요한 사항', '');
  const decisions = attempts.flatMap((a) => a.summary.split('\n').filter((l) => /^\s*[-*]?\s*결정 필요\s*[:：]/.test(l)).map((l) => `${label(a.nodeId)}: ${l.replace(/^\s*[-*]?\s*결정 필요\s*[:：]\s*/, '')}`));
  const uniq = [...new Set(decisions)].filter((d) => !/없음\s*$/.test(d));
  L.push(...(uniq.length ? uniq.map((d) => `- ${d}`) : ['- 담당 보고에 결정 필요 항목이 없다. 팀장 검토에서 수정 요청·보류·검토 완료를 선택한다.']), '');
  return L.join('\n');
}
