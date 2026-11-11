// 흐름 자동 정렬 — 위→아래 단계형 배치. main(미션 흐름 생성)과 renderer(겹친 흐름 표시·자동 정렬 버튼)가 함께 쓴다.
import type { WorkGraph } from './types';

export const NODE_W = 230; // 카드 폭(간격 계산용)
export const NODE_H = 96;  // 카드 높이(간격 계산용)
const GAP_X = 50;
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
 * 단계(층) 배치: 진행 연결(다음·참·거짓)만으로 각 단계의 깊이를 정하고, 같은 깊이는 가로로 나란히 둔다.
 * 실패 연결(재작업)은 배치에 쓰지 않는다. 순환이 있어도 끝나도록 깊이를 노드 수로 제한한다.
 */
export function autoLayout(g: WorkGraph): WorkGraph {
  const ids = g.nodes.map((n) => n.id);
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of g.edges) if (FORWARD.has(e.kind) && preds.has(e.target) && preds.has(e.source)) preds.get(e.target)!.push(e.source);
  const depth = new Map<string, number>();
  const limit = ids.length;
  const visit = (id: string, guard: number): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (guard > limit) return 0;
    const ps = preds.get(id) ?? [];
    const d = ps.length ? Math.max(...ps.map((p) => visit(p, guard + 1))) + 1 : 0;
    depth.set(id, d);
    return d;
  };
  for (const id of ids) visit(id, 0);
  const levels = new Map<number, string[]>();
  for (const id of ids) { const d = depth.get(id) ?? 0; levels.set(d, [...(levels.get(d) ?? []), id]); }
  const pos = new Map<string, { x: number; y: number }>();
  const maxWidth = Math.max(...[...levels.values()].map((l) => l.length)) * (NODE_W + GAP_X);
  for (const [d, list] of [...levels.entries()].sort((a, b) => a[0] - b[0])) {
    // 같은 층은 선행 단계의 가로 위치 평균 순으로 정렬해 선 교차를 줄인다
    const key = (id: string) => { const ps = preds.get(id) ?? []; const xs = ps.map((p) => pos.get(p)?.x).filter((x): x is number => x !== undefined); return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : ids.indexOf(id) * 1e-3; };
    const sorted = [...list].sort((a, b) => key(a) - key(b));
    const width = sorted.length * (NODE_W + GAP_X) - GAP_X;
    sorted.forEach((id, i) => pos.set(id, { x: Math.round((maxWidth - width) / 2 + i * (NODE_W + GAP_X)), y: d * (NODE_H + GAP_Y) }));
  }
  return { ...g, nodes: g.nodes.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })) };
}
