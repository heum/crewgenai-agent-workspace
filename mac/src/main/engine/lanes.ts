// 작업 줄(lane) — 서로 기다릴 필요 없는 작업 묶음을 찾는다.
// LangGraph는 같은 단계(superstep)에 시작한 작업이 모두 끝나야 다음 단계로 넘어간다. 그래서 먼저 끝난 직원도
// 다른 직원이 끝날 때까지 Codex 리뷰를 시작하지 못했다. 작성 → Codex 리뷰 → 재검토 → 검사(실패 시 작성으로)처럼
// 한 입구로만 들어오는 묶음을 한 실행 단위로 묶으면, 각 묶음은 다른 묶음을 기다리지 않고 끝까지 진행한다.
import type { WorkGraph } from '../../shared/types';

/** 묶음에 넣지 않는 단계: 입력(시작점), 사용자 검토(중간에 멈추고 기다림) */
const SOLO = new Set(['input', 'userReview']);

/**
 * 묶음 찾기. 반환: 묶음 키 → { head(유일한 입구), members }
 * - 순환(재작업 고리)은 한 묶음으로 본다(강하게 연결된 요소).
 * - 앞 묶음의 다음이 하나뿐이고 그 다음 묶음의 앞도 하나뿐이면 이어 붙인다(직선 흐름).
 * - 묶음 밖에서 들어오는 연결(시작점 포함)은 모두 같은 한 단계(head)로만 들어와야 한다. 아니면 묶지 않는다.
 * - 두 단계 이상인 묶음만 돌려준다.
 */
export function laneBlocks(g: WorkGraph, starts: string[]): Map<string, { head: string; members: string[] }> {
  const ids = g.nodes.map((n) => n.id);
  const kind = new Map(g.nodes.map((n) => [n.id, n.kind]));
  const out = new Map<string, string[]>(ids.map((i) => [i, []]));
  const inc = new Map<string, string[]>(ids.map((i) => [i, []]));
  for (const e of g.edges) if (out.has(e.source) && out.has(e.target)) { out.get(e.source)!.push(e.target); inc.get(e.target)!.push(e.source); }
  // 작성(agent) 단계는 언제든 입구가 될 수 있다: 사용자 검토·재검토의 수정 요청이 특정 작성 단계를 골라 되돌린다.
  // 그래서 한 묶음에는 작성 단계가 하나뿐이고 그것이 입구다(묶음 중간의 작성 단계로 되돌아가는 일이 없도록).
  const startSet = new Set([...starts, ...g.nodes.filter((n) => n.kind === 'agent').map((n) => n.id)]);

  // 강하게 연결된 요소(Tarjan, 반복형)
  let idx = 0; const index = new Map<string, number>(); const low = new Map<string, number>(); const onSt = new Set<string>(); const st: string[] = [];
  const comp = new Map<string, number>(); let nc = 0;
  for (const root of ids) {
    if (index.has(root)) continue;
    const work: { v: string; i: number }[] = [{ v: root, i: 0 }];
    index.set(root, idx); low.set(root, idx); idx++; st.push(root); onSt.add(root);
    while (work.length) {
      const top = work[work.length - 1];
      const nb = out.get(top.v)!;
      if (top.i < nb.length) {
        const w = nb[top.i++];
        if (!index.has(w)) { index.set(w, idx); low.set(w, idx); idx++; st.push(w); onSt.add(w); work.push({ v: w, i: 0 }); }
        else if (onSt.has(w)) low.set(top.v, Math.min(low.get(top.v)!, index.get(w)!));
      } else {
        work.pop();
        if (work.length) { const p = work[work.length - 1].v; low.set(p, Math.min(low.get(p)!, low.get(top.v)!)); }
        if (low.get(top.v) === index.get(top.v)) { let w: string; do { w = st.pop()!; onSt.delete(w); comp.set(w, nc); } while (w !== top.v); nc++; }
      }
    }
  }

  // 묶음(처음엔 요소 단위) 정보
  const blocks = new Map<number, Set<string>>();
  for (const [v, c] of comp) { if (!blocks.has(c)) blocks.set(c, new Set()); blocks.get(c)!.add(v); }
  const of = (v: string) => comp.get(v)!;
  const entries = (b: Set<string>) => [...b].filter((v) => startSet.has(v) || inc.get(v)!.some((p) => !b.has(p)));
  const succ = (b: Set<string>) => new Set([...b].flatMap((v) => out.get(v)!.filter((w) => !b.has(w)).map(of)));
  const pred = (b: Set<string>) => new Set([...b].flatMap((v) => inc.get(v)!.filter((w) => !b.has(w)).map(of)));
  const eligible = (b: Set<string>) => [...b].every((v) => !SOLO.has(kind.get(v) ?? ''));

  // 직선으로 이어지는 묶음 합치기
  for (let changed = true; changed;) {
    changed = false;
    for (const [bi, b] of blocks) {
      if (!eligible(b)) continue;
      const s = succ(b);
      if (s.size !== 1) continue;
      const ci = [...s][0]; const c = blocks.get(ci)!;
      if (!eligible(c) || pred(c).size !== 1 || entries(c).some((v) => startSet.has(v))) continue;
      const merged = new Set([...b, ...c]);
      if (entries(merged).length !== 1) continue;
      for (const v of c) comp.set(v, bi);
      blocks.set(bi, merged); blocks.delete(ci);
      changed = true; break;
    }
  }

  const res = new Map<string, { head: string; members: string[] }>();
  for (const b of blocks.values()) {
    if (b.size < 2 || !eligible(b)) continue;
    const en = entries(b);
    if (en.length !== 1) continue;
    res.set(`lane_${en[0]}`, { head: en[0], members: ids.filter((v) => b.has(v)) });
  }
  return res;
}
