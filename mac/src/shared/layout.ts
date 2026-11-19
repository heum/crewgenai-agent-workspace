// 흐름 자동 정렬 — 위→아래 단계형 배치. main(미션 흐름 생성)과 renderer(겹친 흐름 표시·자동 정렬 버튼)가 함께 쓴다.
import type { WorkGraph } from './types';

export const NODE_W = 230; // 카드 폭(간격 계산용)
export const NODE_H = 132; // 카드 높이(간격 계산용, 제목은 3줄까지 보이게 잘라 높이를 고정)
const GAP_X = 70; // 옆 칸 사이: 실패 시 되돌아가는 선이 카드 오른쪽으로 지나갈 자리
const GAP_Y = 44;
const FORWARD = new Set(['next', 'true', 'false']);

/** 카드끼리 겹치거나 지나치게 붙어 있으면 true */
export function needsLayout(g: WorkGraph): boolean {
  const ns = g.nodes;
  for (let i = 0; i < ns.length; i++) for (let k = i + 1; k < ns.length; k++) {
    const a = ns[i].position, b = ns[k].position;
    if (Math.abs(a.x - b.x) < NODE_W * 0.8 && Math.abs(a.y - b.y) < NODE_H * 0.8) return true;
  }
  return false;
}

/**
 * 단계(층) 배치: 진행 연결(다음·참·거짓)만으로 각 단계의 깊이를 정한다. 실패 연결(재작업)은 배치에 쓰지 않는다.
 * 각 카드는 앞 단계 카드들의 가운데 아래에 두어(작업 → 리뷰 → 재검토 → 검사가 한 줄로 내려가게) 선이 얽히지 않게 하고,
 * 같은 층에서 겹치면 옆으로 밀어 낸 뒤 그 층 전체를 원하는 위치의 가운데로 맞춘다. 순환이 있어도 끝나도록 깊이를 노드 수로 제한한다.
 */
export function autoLayout(g: WorkGraph): WorkGraph {
  const ids = g.nodes.map((n) => n.id);
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of g.edges) if (FORWARD.has(e.kind) && preds.has(e.target) && preds.has(e.source) && e.source !== e.target) preds.get(e.target)!.push(e.source);
  const depth = new Map<string, number>();
  const limit = ids.length;
  const visit = (id: string, guard: number): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (guard > limit) return 0;
    depth.set(id, 0); // 순환 방지용 임시값
    const ps = preds.get(id) ?? [];
    const d = ps.length ? Math.max(...ps.map((p) => visit(p, guard + 1))) + 1 : 0;
    depth.set(id, d);
    return d;
  };
  for (const id of ids) { depth.delete(id); }
  for (const id of ids) visit(id, 0);
  const levels = new Map<number, string[]>();
  for (const id of ids) { const d = depth.get(id) ?? 0; levels.set(d, [...(levels.get(d) ?? []), id]); }
  const pos = new Map<string, { x: number; y: number }>();
  const STEP = NODE_W + GAP_X;
  const order = new Map(ids.map((id, i) => [id, i]));
  for (const [d, list] of [...levels.entries()].sort((a, b) => a[0] - b[0])) {
    // 원하는 가로 위치: 앞 단계 카드들의 평균(없으면 순서대로)
    const want = (id: string, i: number) => { const xs = (preds.get(id) ?? []).map((p) => pos.get(p)?.x).filter((x): x is number => x !== undefined); return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : i * STEP; };
    const items = list.map((id, i) => ({ id, w: want(id, i), o: order.get(id)! })).sort((a, b) => a.w - b.w || a.o - b.o);
    const xs: number[] = [];
    items.forEach((it, i) => { xs.push(i === 0 ? it.w : Math.max(it.w, xs[i - 1] + STEP)); });
    const shift = items.reduce((s, it, i) => s + (it.w - xs[i]), 0) / items.length; // 밀린 만큼 층 전체를 되돌려 가운데를 맞춘다
    items.forEach((it, i) => pos.set(it.id, { x: Math.round(xs[i] + shift), y: d * (NODE_H + GAP_Y) }));
  }
  const minX = Math.min(...[...pos.values()].map((p) => p.x));
  return { ...g, nodes: g.nodes.map((n) => { const p = pos.get(n.id); return { ...n, position: p ? { x: p.x - minX, y: p.y } : n.position }; }) };
}
