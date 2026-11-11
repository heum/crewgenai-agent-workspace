import { posix } from 'node:path';
// 저장·실행 전 그래프 검사. 연결선이 실제 실행 순서를 결정하므로 여기서 구조 오류를 막는다.
import type { Agent, GraphEdge, GraphNode, PlanFields, ValidationIssue, WorkGraph } from '../../shared/types';

const FORWARD = new Set(['next', 'true', 'false']);

/** 프로젝트 기준 상대 경로 정규화('..'·'.' 해석). 프로젝트 밖을 가리키면 '..'으로 시작한다. */
export function normRel(p: string): string {
  const s = p.trim().replace(/\\/g, '/');
  if (!s) return '';
  const n = posix.normalize(s).replace(/^\.\/+/, '').replace(/\/+$/, '');
  return n === '.' ? '' : n;
}
export function escapes(p: string): boolean { const n = normRel(p); return n === '..' || n.startsWith('../') || p.trim().startsWith('/'); }
/** a가 b와 같거나 b의 하위 경로인지 */
export function within(a: string, b: string): boolean {
  const x = normRel(a); const y = normRel(b);
  if (y === '' || y === '.') return true;
  return x === y || x.startsWith(y + '/');
}
export function overlaps(a: string, b: string): boolean { return within(a, b) || within(b, a); }

export function effectiveScope(node: GraphNode, agent: Agent | undefined, plan: PlanFields): string[] {
  if (node.writeScope.length) return node.writeScope.map(normRel);
  if (agent && agent.workPaths.length) return agent.workPaths.map(normRel);
  return allowedRoots(plan);
}
/** 기획에서 자동 수정을 허용한 영역 = 허용 경로 + 산출물 위치 */
export function allowedRoots(plan: PlanFields): string[] {
  return [...plan.writablePaths, plan.outputDir].map(normRel).filter((x, i, a) => a.indexOf(x) === i);
}
/** 동시 실행 판단에 쓰는 수정 범위: Bash를 쓰는 작성자는 하위 프로그램이 어디든 쓸 수 있으므로 프로젝트 전체로 본다. */
export function lockScope(node: GraphNode, agent: Agent | undefined, plan: PlanFields): string[] {
  return effectiveScope(node, agent, plan); // Bash 작성자는 격리 복사본에서 실행되므로 수정 범위만 고려한다
}
export function isWriter(agent: Agent | undefined): boolean {
  return !!agent && (agent.tools.includes('Edit') || agent.tools.includes('Write') || agent.tools.includes('Bash'));
}

export function forwardAdj(g: WorkGraph): Map<string, string[]> {
  const m = new Map<string, string[]>(g.nodes.map((n) => [n.id, []]));
  for (const e of g.edges) if (FORWARD.has(e.kind) && m.has(e.source)) m.get(e.source)!.push(e.target);
  return m;
}
export function reach(adj: Map<string, string[]>, from: string): Set<string> {
  const seen = new Set<string>(); const st = [...(adj.get(from) ?? [])];
  while (st.length) { const x = st.pop()!; if (seen.has(x)) continue; seen.add(x); st.push(...(adj.get(x) ?? [])); }
  return seen;
}
export function entryNodes(g: WorkGraph): GraphNode[] {
  const hasIn = new Set(g.edges.filter((e) => FORWARD.has(e.kind)).map((e) => e.target));
  return g.nodes.filter((n) => !hasIn.has(n.id));
}

export function validateGraph(g: WorkGraph, agents: Agent[], plan: PlanFields): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const err = (code: string, message: string, nodeId?: string, edgeId?: string) => out.push({ level: 'error', code, message, nodeId, edgeId });
  const warn = (code: string, message: string, nodeId?: string, edgeId?: string) => out.push({ level: 'warning', code, message, nodeId, edgeId });
  const byId = new Map<string, GraphNode>();
  for (const n of g.nodes) { if (byId.has(n.id)) err('dup_node', `노드 ID가 중복됩니다: ${n.label}`, n.id); byId.set(n.id, n); }
  const agentById = new Map(agents.map((a) => [a.id, a]));
  if (g.nodes.length === 0) { err('empty', '단계가 없습니다.'); return out; }

  for (const e of g.edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) err('dangling_edge', '존재하지 않는 단계에 연결된 선이 있습니다.', undefined, e.id);
    if (e.source === e.target) err('self_loop', '단계가 자기 자신으로 연결돼 있습니다. 반복은 실패 연결과 재작업 상한으로 표현하세요.', e.source, e.id);
  }
  const outE = (id: string) => g.edges.filter((e) => e.source === id);
  const inE = (id: string) => g.edges.filter((e) => e.target === id);

  // 시작 단계
  const entries = entryNodes(g);
  if (entries.length === 0) err('no_entry', '시작 단계(들어오는 연결이 없는 단계)가 없습니다. 순환만으로 이루어진 흐름입니다.');
  const inputEntries = entries.filter((n) => n.kind === 'input');
  if (g.nodes.some((n) => n.kind === 'input') && inputEntries.length === 0) err('no_input_entry', '기획·입력 단계로 들어오는 연결이 있어 시작할 수 없습니다.');
  if (!g.nodes.some((n) => n.kind === 'input')) for (const n of entries) warn('entry_kind', `"${n.label}"이(가) 시작 단계입니다. 보통 기획·입력 단계에서 시작합니다.`, n.id);

  // 도달 불가(끊긴 단계)
  const allAdj = new Map<string, string[]>(g.nodes.map((n) => [n.id, []]));
  for (const e of g.edges) allAdj.get(e.source)?.push(e.target);
  const reachable = new Set<string>();
  const starts = inputEntries.length ? inputEntries : entries; // 입력 단계가 있으면 입력에서 시작하는 경로만 실행된다
  for (const s of starts) { reachable.add(s.id); for (const x of reach(allAdj, s.id)) reachable.add(x); }
  for (const n of g.nodes) if (!reachable.has(n.id)) err('unreachable', `"${n.label}"은(는) 시작 단계에서 연결되지 않아 실행되지 않습니다.`, n.id);
  for (const n of g.nodes) {
    if (n.kind !== 'userReview' && n.kind !== 'merge' && outE(n.id).filter((e) => FORWARD.has(e.kind)).length === 0 && n.kind !== 'input')
      warn('dead_end', `"${n.label}" 다음 단계가 없습니다. 이 단계에서 흐름이 끝납니다.`, n.id);
    if (n.kind === 'input' && outE(n.id).filter((e) => FORWARD.has(e.kind)).length === 0) err('input_dead', `"${n.label}" 다음 단계가 없습니다.`, n.id);
  }

  // 노드별 계약
  for (const n of g.nodes) {
    const fails = outE(n.id).filter((e) => e.kind === 'fail');
    if (fails.length > 1) err('multi_fail', `"${n.label}"의 실패 연결은 하나만 둘 수 있습니다.`, n.id);
    const tf = outE(n.id).filter((e) => e.kind === 'true' || e.kind === 'false');
    if (n.kind !== 'branch' && tf.length) err('branch_edge', `조건 분기가 아닌 "${n.label}"에 참/거짓 연결이 있습니다.`, n.id);
    if (n.maxVisits < 1) err('max_visits', `"${n.label}"의 재작업 상한은 1 이상이어야 합니다.`, n.id);
    if (n.timeoutSec <= 0) err('timeout', `"${n.label}"의 시간 제한이 없습니다.`, n.id);
    const ins = inE(n.id).filter((e) => FORWARD.has(e.kind));
    for (const o of n.outputs) if (escapes(o.path)) err('path_escape', `"${n.label}"의 산출물 "${o.path}"가 프로젝트 밖을 가리킵니다.`, n.id);
    for (const w of n.writeScope) if (escapes(w)) err('path_escape', `"${n.label}"의 수정 범위 "${w}"가 프로젝트 밖을 가리킵니다.`, n.id);

    if (n.kind === 'agent' || n.kind === 'review') {
      const a = n.agentId ? agentById.get(n.agentId) : undefined;
      if (!n.agentId) err('no_agent', `"${n.label}"에 담당 직원이 지정되지 않았습니다.`, n.id);
      else if (!a) err('missing_agent', `"${n.label}"의 담당 직원이 존재하지 않습니다.`, n.id);
      else if (!a.active) err('inactive_agent', `"${n.label}"의 담당 "${a.name}"이(가) 비활성 상태입니다.`, n.id);
      if (!n.instructions.trim() && !(a?.instructions.trim())) err('no_instructions', `"${n.label}"의 작업 지시가 비어 있습니다.`, n.id);
      if (ins.length === 0 && !n.inputs.length) warn('no_input', `"${n.label}"의 입력이 없습니다.`, n.id);
    }
    if (n.kind === 'agent') {
      if (n.outputs.length === 0) err('no_output', `"${n.label}"의 출력 계약(산출물 위치·형식)이 없습니다.`, n.id);
      const a = n.agentId ? agentById.get(n.agentId) : undefined;
      const revId = n.skipInlineReview ? null : (n.reviewerAgentId ?? a?.reviewerAgentId ?? null); // 노드 지정이 없으면 직원의 기본 검토 담당
      if (revId) {
        const r = agentById.get(revId);
        if (!r) err('missing_reviewer', `"${n.label}"의 검토 담당이 존재하지 않습니다.`, n.id);
        else if (!r.active) err('inactive_reviewer', `"${n.label}"의 검토 담당 "${r.name}"이(가) 비활성 상태입니다.`, n.id);
        else if (r.id === n.agentId) err('self_review', `"${n.label}"의 작성자와 검토자가 같습니다. 독립 검토가 아닙니다.`, n.id);
      }
      if (!revId && !outE(n.id).some((e) => e.kind === 'next' && ['review', 'codexReview'].includes(byId.get(e.target)?.kind ?? '')))
        warn('no_independent_review', `"${n.label}"에 독립 검토가 없습니다. 노드·직원의 검토 담당을 지정하거나 다음 단계에 교차검토를 두세요.`, n.id);
      if (a?.tools.includes('Bash')) warn('bash_scope', `"${n.label}" 담당이 Bash를 쓰므로 프로젝트 복사본에서 격리 실행합니다. 수정 범위 안의 변경만 반영하고, .git은 복사하지 않습니다(git 명령은 복사본에서 동작하지 않음).`, n.id);
      const scope = effectiveScope(n, a, plan);
      for (const sc of scope) if (escapes(sc)) err('path_escape', `"${n.label}"의 수정 범위(담당 작업 폴더 상속 포함) "${sc}"가 프로젝트 밖을 가리킵니다.`, n.id);
      if (isWriter(a)) {
        if (scope.length === 0) err('no_scope', `"${n.label}"의 수정 허용 경로가 없습니다. 기획의 자동 수정 허용 경로나 담당 작업 폴더를 지정하세요.`, n.id);
        const roots = allowedRoots(plan);
        for (const s of scope) if (!roots.some((w) => within(s, w)))
          err('scope_outside_plan', `"${n.label}"의 수정 경로 "${s || '(프로젝트 전체)'}"가 기획의 자동 수정 허용 경로·산출물 위치 밖입니다.`, n.id);
        for (const o of n.outputs) if (!scope.some((s) => within(o.path, s)))
          err('output_outside_scope', `"${n.label}"의 산출물 "${o.path}"가 수정 허용 경로 밖입니다.`, n.id);
      }
    }
    if (n.kind === 'review') {
      const fail = fails[0];
      if (!fail) err('review_no_fail', `교차검토 "${n.label}"에 수정 요청 시 돌아갈 실패 연결이 없습니다.`, n.id);
      for (const p of ins) { const src = byId.get(p.source); if (src?.agentId && src.agentId === n.agentId) err('self_review', `"${n.label}"의 검토자가 앞 단계 작성자와 같습니다.`, n.id); }
    }
    if (n.kind === 'check') {
      const roots = allowedRoots(plan);
      for (const c of n.command.slice(1)) if (!c.startsWith('-') && !escapes(c) && roots.some((r) => within(c, r)) && /\.(c?js|mjs|ts|py|sh|rb)$/.test(c))
        warn('check_in_writable', `검사 "${n.label}"의 "${c}"가 Agent 수정 허용 영역 안에 있습니다. 실행 중 바뀌면 검사 실패로 처리되므로, 검사 코드는 허용 영역 밖에 두는 편이 안전합니다.`, n.id);
      if (!n.command.length || !n.command[0].trim()) err('no_command', `검사 "${n.label}"의 실행 명령이 없습니다.`, n.id);
      if (!fails.length) warn('check_no_fail', `검사 "${n.label}"이 실패하면 실행이 실패로 끝납니다. 재작업할 담당으로 실패 연결을 두세요.`, n.id);
    }
    if (n.kind === 'branch') {
      const t = outE(n.id).filter((e) => e.kind === 'true'); const f = outE(n.id).filter((e) => e.kind === 'false');
      if (!n.condition) err('no_condition', `조건 분기 "${n.label}"에 조건이 없습니다.`, n.id);
      else if (!byId.has(n.condition.sourceNodeId)) err('bad_condition', `조건 분기 "${n.label}"의 기준 단계가 존재하지 않습니다.`, n.id);
      else if (n.condition.field === 'json' && !n.condition.jsonPath) err('bad_condition', `조건 분기 "${n.label}"에 JSON 경로가 없습니다.`, n.id);
      if (t.length !== 1 || f.length !== 1) err('branch_arms', `조건 분기 "${n.label}"에는 참·거짓 연결이 각각 하나씩 필요합니다.`, n.id);
      if (outE(n.id).some((e) => e.kind === 'next')) err('branch_next', `조건 분기 "${n.label}"에는 일반 연결 대신 참/거짓 연결을 사용하세요.`, n.id);
    }
    if (n.kind === 'userReview' && !fails.length) warn('review_target', `사용자 검토 "${n.label}"에 실패 연결이 없으면 수정 요청은 지정한 담당 단계로만 돌아갑니다.`, n.id);
  }

  // 무한 순환: 조건 없는 연결(next)만으로 이루어진 순환
  const adjNext = new Map<string, string[]>(g.nodes.map((n) => [n.id, []]));
  for (const e of g.edges) if (e.kind === 'next') adjNext.get(e.source)?.push(e.target);
  const color = new Map<string, number>();
  const dfs = (u: string, stack: string[]): boolean => {
    color.set(u, 1); stack.push(u);
    for (const v of adjNext.get(u) ?? []) {
      if (color.get(v) === 1) { err('cycle', `조건 없는 순환이 있습니다: ${[...stack.slice(stack.indexOf(v)), v].map((x) => byId.get(x)?.label ?? x).join(' → ')}. 반복은 실패 연결과 재작업 상한으로 표현하세요.`, v); return true; }
      if (!color.get(v) && dfs(v, stack)) return true;
    }
    stack.pop(); color.set(u, 2); return false;
  };
  for (const n of g.nodes) if (!color.get(n.id)) dfs(n.id, []);

  // 같은 파일 동시 수정 가능성: 순서 관계가 없는 쓰기 단계의 수정 범위가 겹치는지
  const fwd = forwardAdj(g);
  const writers = g.nodes.filter((n) => n.kind === 'agent' && isWriter(n.agentId ? agentById.get(n.agentId) : undefined));
  const reachCache = new Map(writers.map((w) => [w.id, reach(fwd, w.id)]));
  for (let i = 0; i < writers.length; i++) for (let k = i + 1; k < writers.length; k++) {
    const a = writers[i], b = writers[k];
    if (reachCache.get(a.id)!.has(b.id) || reachCache.get(b.id)!.has(a.id)) continue;
    const sa = lockScope(a, agentById.get(a.agentId!), plan), sb = lockScope(b, agentById.get(b.agentId!), plan);
    const hit = sa.flatMap((x) => sb.filter((y) => overlaps(x, y)).map((y) => `${x || '(전체)'} ↔ ${y || '(전체)'}`));
    if (hit.length) err('write_conflict', `"${a.label}"와 "${b.label}"이 동시에 실행될 수 있고 수정 범위가 겹칩니다(${hit[0]}). 범위를 나누거나 순서를 정하세요.`, a.id);
  }
  return out;
}

export function edgesFrom(g: WorkGraph, id: string, kind?: GraphEdge['kind']) {
  return g.edges.filter((e) => e.source === id && (!kind || e.kind === kind));
}
