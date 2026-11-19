// 휴식 공간·리뷰룸 배치(키트 공통). 그림 칸 단위로 계산하고, 넘친 인원은 숨기지 않고 따로 돌려준다(화면에서 '+N명'과 목록으로 보임).
import type { ArtMod, ArtPose } from './art';
import type { Kit, Piece, Pod, Station } from './officeKit';

export type Habit = { mod: ArtMod; period: number; delay: number };
export type Seat = { key: string; x: number; y: number; pose: ArtPose; spot: string; habits: Habit[] };

/** 문자열 → 0 이상 정수(같은 직원은 늘 같은 버릇·자세) */
export function seedOf(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

/** 직원마다 다른 작은 버릇: 눈 깜빡임은 모두(주기·시작이 다름), 두 번째 버릇은 컵이 있으면 한 모금, 아니면 곁눈질 */
export function habitsFor(key: string, pose: ArtPose): Habit[] {
  const s = seedOf(key);
  const out: Habit[] = [];
  if (pose !== 'rest' && pose !== 'stretch') out.push({ mod: 'blink', period: 4 + (s % 5), delay: (s >> 3) % 7 });
  const second: ArtMod = pose === 'cup' || pose === 'standcup' ? 'sip' : pose === 'rest' || pose === 'stretch' ? '' : (s >> 5) % 2 ? 'glanceL' : 'glanceR';
  if (second) out.push({ mod: second, period: 9 + ((s >> 7) % 7), delay: 2 + ((s >> 11) % 9) });
  return out;
}

// ───── 휴식 공간 ─────
const STATIONS: Parameters<Kit['station']>[0][] = ['nook', 'sofa', 'bar', 'window', 'arm', 'arm', 'bean', 'bean'];
/** 앉는 순서: 적은 인원일 때도 한 소파에 몰리지 않고 공간 전체에 흩어지게 */
const FILL: [number, number][] = [[0, 0], [2, 0], [1, 0], [4, 0], [3, 0], [6, 0], [1, 1], [2, 1], [5, 0], [7, 0], [3, 1], [1, 2]];

export type Placed = { st: Station; x: number; y: number };
export type LoungePlan = { stations: Placed[]; seats: Seat[]; overflow: string[]; capacity: number };

export function loungePlan(kit: Kit, box: { x: number; y: number; w: number; h: number }, keys: string[], rowGap?: number): LoungePlan {
  const gap = kit.id === 'B' ? 8 : 4;
  const vgap = Math.max(gap, rowGap ?? gap); // 줄 사이: 이름표가 다음 줄 머리를 가리지 않을 만큼
  // 인원이 기본 자리보다 많으면 공간이 남는 만큼 의자·빈백·소파를 더 놓는다(못 놓은 만큼만 '자리 밖'으로)
  const kinds = [...STATIONS]; const extra: Parameters<Kit['station']>[0][] = ['arm', 'bean', 'sofa', 'arm', 'bean', 'arm'];
  const cap = (ks: typeof kinds) => ks.reduce((n, k) => n + kit.station(k).slots.length, 0);
  for (let i = 0; cap(kinds) < keys.length && i < 24; i++) kinds.push(extra[i % extra.length]);
  // 라운지가 넓으면(세로로 여러 줄이 들어가면) 빈 바닥만 남지 않게 소파·의자·빈백·독서 자리를 더 놓는다(줄마다 폭의 약 70%까지, 최대 3줄)
  { const probeH = Math.max(...kinds.map((k) => kit.station(k).h));
    const rowsRoom = Math.min(3, Math.max(1, Math.floor((box.h + vgap) / (probeH + vgap * 2))));
    const want = rowsRoom * box.w * 0.7; const fill: Parameters<Kit['station']>[0][] = ['sofa', 'arm', 'bean', 'nook', 'arm', 'bean'];
    const widthOf = (ks: typeof kinds) => ks.reduce((t, k) => t + kit.station(k).w + gap, 0);
    for (let i = 0; rowsRoom > 1 && widthOf(kinds) < want && i < 18; i++) kinds.push(fill[i % fill.length]); }
  const sts = kinds.map((k) => kit.station(k));
  // 줄 수: 폭으로 정해지는 최소 줄 수와, 세로 여유로 들어가는 줄 수(최대 3) 중 큰 쪽. 공간이 넓으면 가구를 여러 줄로 나눠 라운지 전체에 펼친다
  const maxH = Math.max(...sts.map((x) => x.h));
  let minRows = 1; { let w = -gap; for (const st of sts) { if (w + gap + st.w > box.w) { minRows++; w = -gap; } w += gap + st.w; } }
  const fitRows = Math.max(1, Math.floor((box.h + vgap) / (maxH + vgap * 2)));
  const nRows = Math.max(minRows, Math.min(3, fitRows, Math.ceil(sts.length / 2)));
  // 스테이션을 순서대로 줄마다 고르게 나누되, 한 줄이 폭을 넘으면 다음 줄로
  const rows: { items: { st: Station; idx: number }[]; w: number; h: number }[] = [];
  const per = Math.ceil(sts.length / nRows);
  for (let i = 0; i < sts.length; i++) {
    const st = sts[i]; let row = rows[rows.length - 1];
    if (!row || row.items.length >= per || row.w + gap + st.w > box.w) { row = { items: [], w: -gap, h: 0 }; rows.push(row); }
    row.items.push({ st, idx: i }); row.w += gap + st.w; row.h = Math.max(row.h, st.h);
  }
  const placed: (Placed | null)[] = sts.map(() => null);
  // 들어가는 줄만 쓰고, 줄 사이·위아래 여백을 고르게 나눈다(한가운데 한 줄로 몰리고 위아래가 비지 않게)
  const fit: typeof rows = []; let used = 0;
  for (const row of rows) { if (used + (fit.length ? vgap : 0) + row.h > box.h) break; used += (fit.length ? vgap : 0) + row.h; fit.push(row); }
  const spareY = Math.max(0, box.h - used); const gapY = Math.floor(Math.max(0, spareY - (fit.length === 1 ? (rowGap ?? 0) : 0)) / (fit.length + 1));
  let y = box.y + gapY;
  fit.forEach((row, ri) => {
    // 가구를 2~3개씩 묶음(소파 곁 의자, 빈백 둘 등)으로 모으고, 묶음 사이를 넓게 띄워 한 줄로 늘어서 보이지 않게 한다.
    // 묶음마다 앞뒤로 엇갈리게(세로 여유가 있으면) 놓아 실제 휴게실처럼 보이게 한다.
    const n = row.items.length; const size = n >= 7 ? 3 : 2; const groups = Math.max(1, Math.ceil(n / size));
    const spareX = Math.max(0, box.w - row.w); const gx = groups > 1 ? Math.min(Math.floor(spareX / (groups + 1)), 60) : 0;
    const tagRoom = rowGap ?? 0; // 아래쪽 이름표 자리
    const zz = fit.length === 1 ? Math.max(0, Math.floor((spareY - tagRoom) / 3)) : Math.min(Math.floor(gapY / 2), 8); // 엇갈림 폭
    let x = box.x + Math.floor((box.w - (row.w + gx * (groups - 1))) / 2);
    row.items.forEach((it, i) => {
      const g = Math.floor(i / size);
      const dy = zz ? (g % 2 ? zz : -Math.floor(zz / 2)) * (ri % 2 ? -1 : 1) : 0;
      placed[it.idx] = { st: it.st, x, y: Math.max(box.y, Math.min(box.y + box.h - it.st.h - tagRoom, y + (row.h - it.st.h) + dy)) };
      x += it.st.w + gap + ((i + 1) % size === 0 ? gx : 0);
    });
    y += row.h + vgap + gapY;
  });
  const order = FILL.filter(([si, k]) => placed[si] && placed[si]!.st.slots[k]);
  // FILL에 없는 남은 자리(넓은 키트)도 뒤에 붙인다
  placed.forEach((p, si) => p?.st.slots.forEach((_, k) => { if (!order.some(([a, b]) => a === si && b === k)) order.push([si, k]); }));
  const seats: Seat[] = [];
  keys.slice(0, order.length).forEach((key, i) => {
    const [si, k] = order[i]; const p = placed[si]!; const sl = p.st.slots[k];
    const pose = sl.poses[seedOf(key) % sl.poses.length];
    seats.push({ key, x: p.x + sl.x, y: p.y + sl.y, pose, spot: sl.spot, habits: habitsFor(key, pose) });
  });
  return { stations: placed.filter((p): p is Placed => !!p), seats, overflow: keys.slice(order.length), capacity: order.length };
}

// ───── 리뷰룸: 작업별 검토 그룹 ─────
export type ReviewGroupIn = { key: string; author: string | null; reviewers: { key: string; external: boolean }[] };
export type PodPlaced = { key: string; x: number; y: number; pod: Pod; author: string | null; shown: { key: string; x: number; y: number }[]; hidden: string[] };
export type ReviewPlan = { pods: PodPlaced[]; overflow: ReviewGroupIn[] };

/** 그룹마다 탁자 하나(리뷰받는 직원은 왼쪽 끝, 검토자는 탁자 뒤, 공유 화면은 오른쪽). 탁자 폭에 다 못 앉으면 '+N'으로 표시하고 목록에 남긴다. */
export function reviewPlan(kit: Kit, box: { x: number; y: number; w: number; h: number }, groups: ReviewGroupIn[], rowGap?: number): ReviewPlan {
  const gap = kit.id === 'B' ? 10 : 5;
  const vgap = Math.max(gap, rowGap ?? gap); // 그룹 줄 사이: 이름표가 다음 줄을 가리지 않게
  const pods: PodPlaced[] = []; const overflow: ReviewGroupIn[] = [];
  let x = box.x; let y = box.y; let rowH = 0;
  for (const g of groups) {
    // 이 줄에 들어갈 수 있는 최대 검토자 수
    let n = Math.max(1, g.reviewers.length);
    const fits = (k: number) => kit.pod(k, []).w <= box.w;
    while (n > 1 && !fits(n)) n--;
    const show = g.reviewers.slice(0, n);
    const pod = kit.pod(n, show.map((r, i) => (r.external ? i : -1)).filter((i) => i >= 0));
    if (x > box.x && x + pod.w > box.x + box.w) { x = box.x; y += rowH + vgap; rowH = 0; }
    if (y + pod.h > box.y + box.h) { overflow.push(g); continue; }
    pods.push({ key: g.key, x, y, pod, author: g.author, shown: show.map((r, i) => ({ key: r.key, x: x + pod.reviewers[i].x, y: y + pod.reviewers[i].y })), hidden: g.reviewers.slice(n).map((r) => r.key) });
    x += pod.w + gap; rowH = Math.max(rowH, pod.h);
  }
  // 줄마다 가운데로 모으고, 남는 세로 공간이 있으면 조금 내려 방 가운데쯤 앉힌다(이름표가 방 밖으로 나가지 않게)
  const rows = new Map<number, PodPlaced[]>(); for (const p of pods) rows.set(p.y, [...(rows.get(p.y) ?? []), p]);
  const bottom = pods.reduce((m, p) => Math.max(m, p.y + p.pod.h), box.y);
  const dy = Math.max(0, Math.min(14, Math.floor((box.y + box.h - bottom - (rowGap ?? 0)) / 3)));
  for (const row of rows.values()) {
    const right = row.reduce((m, p) => Math.max(m, p.x + p.pod.w), box.x);
    const dx = Math.max(0, Math.floor((box.x + box.w - right) / 2));
    for (const p of row) { p.x += dx; p.y += dy; for (const s of p.shown) { s.x += dx; s.y += dy; } }
  }
  return { pods, overflow };
}
export type { Piece };
