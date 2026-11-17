// 사무실 그림(배경·가구·인물)과 자리 배치. 그림은 이 앱에서 직접 그린 도트 그림(../art.ts)이다.
// 원칙: 한 사람은 지도에 한 번만. 자리·자세는 실제 상태에서만 정한다(업무 자리는 실제로 일할 때만 앉는다).
// 출력: 그림 한 칸(1 단위)은 화면에서 정수 개의 실제 화소가 되도록 배율을 고르고(OfficeTab), 장면의 가로·세로 칸 수는
// 화면 크기에서 계산해 구역(업무 공간·라운지·리뷰룸)을 다시 배치한다. 고정 그림 한 장을 늘리거나 줄이지 않는다.
// 시간대 분위기는 벽·바닥·창밖에만 입히고, 가구·인물·글자는 고유 색 그대로 둔다(밤에도 선명하게).
import { memo } from 'react';
import type { Agent, MissionDenial } from '../../shared/types';
import { type CharDef } from '../characters';
import {
  BOARD_SLOT, bookshelf2, chairBack, char2, CHAR2_H, CHAR2_W, charHead, coffeeBar, coffeeTable, corkBoard, deskFront, floorLamp, plant2,
  charSide, emptySide, flipX, pairTable, SEAT_X, SEAT_Y, SIDE_H, SIDE_W, SOFA_SEAT, sofaBack, sofaFront, STATION_H, STATION_W, wallClock, whiteboard, windowFrame, type ArtPose, type DeskProp, type Screen,
} from '../art';
import { toPaths, type Rect } from '../pixel';
import type { Mood } from './officeTime';

export type State = 'work' | 'review' | 'wait' | 'rest' | 'off';
export type Pose = 'code' | 'doc' | 'plan' | 'review' | 'reviewed' | 'wait' | 'rest' | 'off';
export type Prop = DeskProp;
export type Person = {
  key: string; agent: Agent | null; code: string; name: string; role: string; char: CharDef; prop: Prop;
  state: State; pose: Pose; task: string; since: string | null; external: boolean; blocked: MissionDenial[]; blockedSteps: string[]; asks: boolean;
};

export function propOf(a: { name: string; role: string }): Prop {
  const rules: [RegExp, Prop][] = [
    [/총괄|오퍼레이터|팀장/, 'clipboard'], [/보안|권한/, 'lock'], [/코드 리뷰|독립 검토|리뷰|검수/, 'redpen'], [/시험|품질|검증|QA/i, 'flask'],
    [/통합|결과물/, 'boxes'], [/프런트|프론트|화면|UI/i, 'tablet'], [/백엔드|서버|구현|개발/, 'server'], [/데이터|DB/i, 'server'],
    [/문서|작성/, 'books'], [/설계/, 'blueprint'], [/기획|요구|조사|분석|연구/, 'notes'], [/인프라|운영|배포/, 'cables'],
  ];
  return (rules.find(([re]) => re.test(a.name)) ?? rules.find(([re]) => re.test(a.role)))?.[1] ?? 'plant';
}

// ───── 배치(그림 1칸 = 1) ─────
export const WALL = 52; // 윗벽(창·책장·화이트보드)
const COL = 100; const ROW = 66; // 책상 간격(이름표가 다음 줄 머리를 가리지 않게 배율이 작으면 줄 간격을 늘린다)
const TAG_PX = 22; // 이름표 높이(화면 px, 배율과 무관)
const BAND_MIN = 122; // 라운지·리뷰룸 띠의 최소 높이
export const MIN_W = 440;
export type Box = { x: number; y: number; w: number; h: number };
export type Seat = { x: number; y: number; pose: ArtPose; kind: 'sofa' | 'arm' | 'stand' };
export type Layout = {
  W: number; H: number; fits: boolean; cols: number; rows: number; desks: { x: number; y: number }[];
  band: number; tableY: number; lounge: Box; review: Box; loungeSeats: Seat[]; reviewSeats: { left: { x: number; y: number }[]; right: { x: number; y: number }[] }; reviewRows: { y: number; tableX: number; tableY: number; left: { x: number; y: number }; right: { x: number; y: number } }[]; tableW: number;
  sofas: { x: number; y: number; seats: number }[]; arms: { x: number; y: number }[]; bar: { x: number; y: number } | null; wall: WallItem[];
};
export type WallItem = { kind: 'window' | 'shelf' | 'board' | 'clock' | 'cork' | 'plant'; x: number; w: number };

/** 화면 크기(그림 칸 단위)와 직원 수로 배치를 정한다. 필요한 높이가 화면보다 크면 fits=false(스크롤). */
export function layoutFor(staff: number, Wavail: number, Havail: number, offCount = 0, scale = 2): Layout {
  const row = Math.max(ROW, 43 + Math.ceil(TAG_PX / scale) + 8);
  const W = Math.max(MIN_W, Math.floor(Wavail));
  const n = Math.max(1, staff);
  const cols = Math.max(1, Math.min(n, Math.floor((W - 4) / COL)));
  const rows = Math.ceil(n / cols);
  const gridW = cols * COL - (COL - STATION_W);
  const x0 = Math.floor((W - gridW) / 2);
  const need = WALL + 12 + (rows - 1) * row + STATION_H + 6 + BAND_MIN;
  const H = Math.max(Math.floor(Havail), need);
  // 남는 높이는 빈 바닥으로 두지 않고 줄 간격·띠 안 배치에 고르게 나눈다
  const extra = H - need;
  const pitch = row + (rows > 1 ? Math.min(20, Math.floor((extra * 0.35) / (rows - 1))) : 0);
  const deskTop = WALL + 12 + Math.min(14, Math.floor(extra * 0.1));
  const desks = Array.from({ length: staff }, (_, i) => ({ x: x0 + (i % cols) * COL, y: deskTop + Math.floor(i / cols) * pitch }));
  const band = deskTop + (rows - 1) * pitch + STATION_H + 6;
  const bandExtra = Math.max(0, H - band - BAND_MIN);
  // 띠: 왼쪽 라운지, 오른쪽 리뷰룸(유리 벽)
  const RW = Math.max(196, Math.min(290, Math.round(W * 0.36)));
  const review: Box = { x: W - RW, y: band, w: RW, h: H - band };
  const lounge: Box = { x: 0, y: band, w: W - RW - 4, h: H - band };
  // 라운지 가구: 뒷줄 소파(3인), 앞줄 안락의자, 오른쪽 커피 바(두 사람이 서서 쉬는 자리)
  // 가구 수는 직원 수에 맞춘다(쉬는 사람이 모두 앉을 만큼, 넓다고 끝없이 늘리지 않음). 묶음을 라운지 가운데에 둔다.
  const barW = 74; const hasBar = lounge.w >= 300;
  const usable = lounge.w - 16 - (hasBar ? barW + 12 : 0);
  const SOFA_PITCH = 14 + 3 * SOFA_SEAT + 8;
  const sofaN = Math.max(1, Math.min(Math.floor(usable / SOFA_PITCH), Math.ceil(n / 3), 3));
  const left0 = Math.max(0, Math.floor((usable - sofaN * SOFA_PITCH + 8) / 2));
  const sofas: Layout['sofas'] = []; const seats: Seat[] = [];
  const sy = lounge.y + 26 + Math.min(40, Math.floor(bandExtra * 0.25));
  for (let i = 0; i < sofaN; i++) { const x = lounge.x + 8 + left0 + i * SOFA_PITCH; sofas.push({ x, y: sy, seats: 3 }); for (let k = 0; k < 3; k++) seats.push({ x: x + 6 + k * SOFA_SEAT + Math.floor(SOFA_SEAT / 2) - 17, y: sy - 14, pose: 'rest', kind: 'sofa' }); }
  const arms: Layout['arms'] = [];
  const ay = sy + 46 + Math.min(30, Math.floor(bandExtra * 0.15));
  const standN = hasBar ? 2 : 0;
  const armWant = Math.max(0, n - sofaN * 3 - standN);
  if (lounge.y + lounge.h - ay >= 40 && (armWant > 0 || bandExtra >= 40)) {
    const armN = Math.min(Math.floor(usable / 44), Math.max(armWant, Math.min(4, Math.ceil(n / 3))));
    const a0 = Math.max(0, Math.floor((usable - armN * 44 + 4) / 2));
    for (let i = 0; i < armN; i++) { const x = lounge.x + 8 + a0 + i * 44; arms.push({ x, y: ay }); seats.push({ x: x + 3, y: ay - 14, pose: 'rest', kind: 'arm' }); }
  }
  const bar = hasBar ? { x: lounge.x + lounge.w - barW - 6, y: sy - 20 } : null;
  if (bar) for (const dx of [6, 36]) seats.push({ x: bar.x + dx, y: bar.y + 42, pose: 'stand', kind: 'stand' });
  // 리뷰룸: 리뷰 받는 직원(왼쪽)과 검토하는 쪽(오른쪽)이 작은 탁자를 사이에 두고 마주 앉는다. 한 줄에 한 쌍, 최대 3줄.
  const tableW = Math.max(28, Math.min(60, review.w - 2 * SIDE_W - 70));
  const per = Math.max(1, Math.min(3, Math.floor((review.h - 22 - SIDE_H) / 34) + 1));
  const PITCH = per > 1 ? Math.min(52, Math.floor((review.h - 22 - SIDE_H) / (per - 1))) : 34; // 자리가 넉넉하면 줄 사이를 띄운다
  const blockH = (per - 1) * PITCH + SIDE_H;
  const y0 = review.y + 18 + Math.max(0, Math.floor((review.h - 22 - blockH) / 2));
  const rx0 = review.x + Math.floor((review.w - (24 + tableW - 12 + SIDE_W)) / 2);
  const reviewRows = Array.from({ length: per }, (_, i) => { const y = y0 + i * PITCH; const tableX = rx0 + 24; return { y, tableX, tableY: y + 26, left: { x: rx0, y }, right: { x: tableX + tableW - 12, y } }; });
  const left = reviewRows.map((r) => r.left); const right = reviewRows.map((r) => r.right);
  const ty = reviewRows[0].tableY;
  return { W, H, fits: need <= Math.floor(Havail), cols, rows, desks, band, tableY: ty, lounge, review, loungeSeats: seats, reviewSeats: { left, right }, reviewRows, tableW, sofas, arms, bar, wall: wallItems(W, offCount) };
}

/** 그림 배율: 그림 한 칸이 화면의 실제 화소 정수 개(scale×dpr이 정수)가 되는 값 중 장면이 무대에 다 들어가는 가장 큰 값(최대 3배).
 *  어느 것도 안 들어가면 화면 화소 1:1 근처(최소 배율)로 그리고 세로 스크롤. */
export function pickScale(stageW: number, stageH: number, dpr: number, staff: number, off: number): { scale: number; layout: Layout } {
  const d = dpr > 0 ? dpr : 1;
  for (let k = Math.floor(3 * d); k >= Math.ceil(d); k--) {
    const s = k / d; const L = layoutFor(staff, stageW / s, stageH / s, off, s);
    if (stageW / s >= MIN_W && L.fits) return { scale: s, layout: L };
  }
  const s = Math.ceil(d) / d;
  return { scale: s, layout: layoutFor(staff, stageW / s, stageH / s, off, s) };
}

/** 윗벽 장식: 창·책장·화이트보드·시계를 폭에 맞춰 고르게, 오른쪽 끝에는 휴가 게시판 */
function wallItems(W: number, off: number): WallItem[] {
  const corkW = 10 + Math.max(1, Math.min(off, 6)) * BOARD_SLOT;
  const right = off > 0 ? corkW + 12 : 0;
  const pattern: WallItem['kind'][] = ['shelf', 'window', 'plant', 'window', 'board', 'window', 'clock', 'shelf', 'window', 'window'];
  const widthOf = (k: WallItem['kind']) => (k === 'window' ? 66 : k === 'shelf' ? 44 : k === 'board' ? 62 : k === 'plant' ? 20 : k === 'clock' ? 18 : 0);
  const items: WallItem[] = [];
  let used = 0;
  for (const k of [...pattern, ...pattern]) { const w = widthOf(k); if (used + w + 14 > W - 12 - right) break; items.push({ kind: k, x: 0, w }); used += w + 14; }
  // 남는 폭을 사이에 고르게 나눈다
  const gap = items.length > 1 ? Math.floor((W - 12 - right - used + 14 * items.length) / (items.length + (right ? 1 : 0))) : 14;
  let x = 8;
  for (const it of items) { it.x = x; x += it.w + gap; }
  if (off > 0) items.push({ kind: 'cork', x: W - corkW - 8, w: corkW });
  return items;
}

export type Placed = { p: Person; zone: 'desk' | 'review' | 'lounge'; x: number; y: number; w: number; h: number; pose: ArtPose; seat?: Seat };
/** 사람마다 한 자리(중복 없음). 휴가는 벽의 게시판 사진으로만 보인다. 자리가 모자라면 넘친 인원을 따로 돌려준다. */
export function placePeople(people: Person[], staff: Person[], L: Layout): { placed: Placed[]; overflow: { review: number; lounge: number } } {
  const out: Placed[] = [];
  staff.forEach((p, i) => {
    if (p.pose === 'code' || p.pose === 'doc' || p.pose === 'plan' || p.pose === 'wait') {
      const d = L.desks[i];
      out.push({ p, zone: 'desk', x: d.x + SEAT_X, y: d.y + SEAT_Y, w: CHAR2_W, h: 40, pose: p.pose === 'code' ? 'type' : 'sit' });
    }
  });
  const left = people.filter((p) => p.pose === 'reviewed');
  const right = people.filter((p) => p.pose === 'review');
  const per = L.reviewSeats.left.length;
  left.slice(0, per).forEach((p, i) => out.push({ p, zone: 'review', ...L.reviewSeats.left[i], w: SIDE_W, h: SIDE_H - 2, pose: 'sit' }));
  right.slice(0, per).forEach((p, i) => out.push({ p, zone: 'review', ...L.reviewSeats.right[i], w: SIDE_W, h: SIDE_H - 2, pose: 'review' }));
  const rest = people.filter((p) => p.pose === 'rest');
  const seats = L.loungeSeats;
  rest.slice(0, seats.length).forEach((p, i) => { const s = seats[i]; out.push({ p, zone: 'lounge', x: s.x, y: s.y, w: CHAR2_W, h: s.pose === 'stand' ? CHAR2_H : 40, pose: s.pose, seat: s }); });
  return { placed: out, overflow: { review: Math.max(0, left.length - per) + Math.max(0, right.length - per), lounge: Math.max(0, rest.length - seats.length) } };
}

// ───── 그리기 ─────
/** 도트 그림 조각: 같은 색끼리 한 경로. 움직임(CSS)은 바깥 g, 자리(translate)는 안쪽 g */
export const Pix = memo(function Pix({ r, x, y, className }: { r: Rect[]; x: number; y: number; className?: string }) {
  const body = <g transform={`translate(${x} ${y})`}>{toPaths(r).map((p) => <path key={p.fill} fill={p.fill} d={p.d} />)}</g>;
  return className ? <g className={className}>{body}</g> : body;
});

const floorCache = new Map<string, Rect[]>();
function planks(x0: number, y0: number, w: number, h: number, cols: string[], line: string, plank = 56, ph = 7): Rect[] {
  const k = `${x0}|${y0}|${w}|${h}|${cols.join()}`; const hit = floorCache.get(k); if (hit) return hit;
  const r: Rect[] = [];
  for (let y = y0, row = 0; y < y0 + h; y += ph, row++) {
    const hh = Math.min(ph, y0 + h - y);
    for (let x = x0 - ((row * 29) % plank); x < x0 + w; x += plank) {
      const a = Math.max(x, x0); const b = Math.min(x + plank - 1, x0 + w);
      if (b > a) r.push([a, y, b - a, Math.max(0, hh - 1), cols[(row * 3 + Math.abs(Math.floor(x / plank))) % cols.length]]);
      if (x + plank - 1 >= x0 && x + plank - 1 < x0 + w) r.push([x + plank - 1, y, 1, Math.max(0, hh - 1), line]);
    }
    if (hh === ph) r.push([x0, y + ph - 1, w, 1, line]);
  }
  floorCache.set(k, r); return r;
}
function tiles(x0: number, y0: number, w: number, h: number): Rect[] {
  const k = `t|${x0}|${y0}|${w}|${h}`; const hit = floorCache.get(k); if (hit) return hit;
  const r: Rect[] = [[x0, y0, w, h, '#dfe5dc']];
  for (let y = y0 + 15; y < y0 + h; y += 16) r.push([x0, y, w, 1, '#ccd4ca']);
  for (let x = x0 + 15; x < x0 + w; x += 16) r.push([x, y0, 1, h, '#ccd4ca']);
  floorCache.set(k, r); return r;
}

function screenOf(pose: Pose | null): Screen { return pose === 'code' ? 'code' : pose === 'doc' ? 'doc' : pose === 'plan' ? 'plan' : pose === 'wait' ? 'wait' : 'off'; }

/** 사무실 그림 */
export function Scene({ people, staff, layout: L, placed, mood, selected }: { people: Person[]; staff: Person[]; layout: Layout; placed: Placed[]; mood: Mood; selected: string | null }) {
  const { W, H, lounge, review } = L;
  const tr = { transition: 'fill 1.6s ease, opacity 1.6s ease, stop-color 1.6s ease' };
  const deskPlaced = new Map(placed.filter((x) => x.zone === 'desk').map((x) => [x.p.key, x]));
  const off = people.filter((p) => p.state === 'off');
  const wins = L.wall.filter((w) => w.kind === 'window');
  const loungeP = placed.filter((x) => x.zone === 'lounge');
  const reviewP = placed.filter((x) => x.zone === 'review');
  const tx = L.reviewRows[0].tableX; const ty = L.tableY;
  const personAt = (pl: Placed, i: number) => pl.pose === 'type'
    ? <g key={pl.p.key}><Pix r={char2(pl.p.char, 'type', 0)} x={pl.x} y={pl.y} className="ofc-fa" /><Pix r={char2(pl.p.char, 'type', 1)} x={pl.x} y={pl.y} className="ofc-fb" /></g>
    : <Pix key={pl.p.key + i} r={char2(pl.p.char, pl.pose)} x={pl.x} y={pl.y} className={pl.zone === 'desk' && pl.p.pose === 'wait' ? 'ofc-anim ofc-breathe' : undefined} />;
  return (
    <svg className="ofc-scene" viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" shapeRendering="crispEdges" role="img" aria-label="사무실: 직원들의 위치와 현재 상태">
      <defs>
        <linearGradient id="ofc-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" style={{ stopColor: mood.skyTop, ...tr }} /><stop offset="100%" style={{ stopColor: mood.skyBottom, ...tr }} /></linearGradient>
        <radialGradient id="glow-lamp"><stop offset="0%" stopColor="#ffd38a" stopOpacity={0.85} /><stop offset="100%" stopColor="#ffd38a" stopOpacity={0} /></radialGradient>
        <radialGradient id="glow-screen"><stop offset="0%" stopColor="#a6e8ff" stopOpacity={0.7} /><stop offset="100%" stopColor="#a6e8ff" stopOpacity={0} /></radialGradient>
      </defs>
      <style>{`.ofc-city{fill:${mood.city};transition:fill 1.6s ease}.ofc-citylights{opacity:${mood.cityLights};transition:opacity 1.6s ease}`}</style>
      {/* 바닥(업무 공간 나무, 라운지 따뜻한 나무, 리뷰룸 타일) */}
      <Pix r={planks(0, WALL, W, L.band - WALL, ['#c99a64', '#c4945f', '#cda06a'], '#ad8152')} x={0} y={0} />
      <Pix r={planks(lounge.x, lounge.y, lounge.w + 4, lounge.h, ['#d4a874', '#cfa26e', '#d8ae7b'], '#b98a58', 48, 6)} x={0} y={0} />
      <Pix r={tiles(review.x, review.y, review.w, review.h)} x={0} y={0} />
      {/* 벽 */}
      <rect x={0} y={0} width={W} height={WALL} fill="#efe4cd" />
      <rect x={0} y={0} width={W} height={3} fill="#e0d2b4" />
      <rect x={0} y={WALL - 5} width={W} height={5} fill="#b07a49" /><rect x={0} y={WALL - 5} width={W} height={1} fill="#d39b62" /><rect x={0} y={WALL} width={W} height={1} fill="#7d5532" />
      {/* 창밖(하늘·건물) — 시간대 */}
      {wins.map((w, i) => (
        <g key={i}>
          <rect x={w.x + 1} y={7} width={w.w - 2} height={36} fill="url(#ofc-sky)" />
          {[[3, 16], [12, 22], [22, 12], [31, 26], [42, 18], [51, 14]].filter(([bx]) => bx + 8 < w.w).map(([bx, bh], k) => <rect key={k} x={w.x + bx} y={43 - bh} width={8} height={bh} className="ofc-city" />)}
          <g className="ofc-citylights">{[[3, 16], [12, 22], [22, 12], [31, 26], [42, 18], [51, 14]].filter(([bx]) => bx + 8 < w.w).map(([bx, bh], k) => <g key={k}><rect x={w.x + bx + 2} y={46 - bh} width={1} height={1} fill="#ffd77a" /><rect x={w.x + bx + 5} y={50 - bh} width={1} height={1} fill="#ffd77a" /></g>)}</g>
        </g>
      ))}
      {/* 햇빛(창 아래 바닥) */}
      <g style={{ opacity: mood.sunOpacity * 0.7, ...tr }} pointerEvents="none">
        {wins.map((w, i) => <polygon key={i} points={`${w.x + 4 + mood.sunShift * 0.2},${WALL} ${w.x + w.w - 4 + mood.sunShift * 0.2},${WALL} ${w.x + w.w - 4 + mood.sunShift},${WALL + 46} ${w.x + 4 + mood.sunShift},${WALL + 46}`} style={{ fill: mood.sunLight, ...tr }} />)}
      </g>
      <rect x={0} y={0} width={W} height={H} style={{ fill: mood.ambient, opacity: mood.ambientOpacity * 0.45, ...tr }} pointerEvents="none" />
      {/* 벽 장식 */}
      {L.wall.map((w, i) => w.kind === 'window' ? <Pix key={i} r={windowFrame(w.w, 38)} x={w.x - 1} y={5} />
        : w.kind === 'shelf' ? <Pix key={i} r={bookshelf2(w.w - 2)} x={w.x} y={3} />
        : w.kind === 'board' ? <Pix key={i} r={whiteboard(w.w - 2)} x={w.x} y={7} />
        : w.kind === 'clock' ? <Pix key={i} r={wallClock()} x={w.x} y={12} />
        : w.kind === 'plant' ? <g key={i}><rect x={w.x + 9} y={0} width={1} height={8} fill="#5e3a20" /><Pix r={plant2(false)} x={w.x} y={8} /></g>
        : <g key={i}><Pix r={corkBoard(Math.min(off.length, 6))} x={w.x} y={6} />{off.slice(0, 6).map((p, k) => <Pix key={p.key} r={charHead(p.char)} x={w.x + 6 + k * BOARD_SLOT - 2} y={13} />)}</g>)}
      {/* 책상(직원 한 명당 하나, 휴가 직원 제외): 의자 → 사람 → 책상 앞 순서로 그려 앉은 모습이 책상 뒤에 있게 */}
      {staff.map((p, i) => { const d = L.desks[i]; const at = deskPlaced.get(p.key); return (
        <g key={p.key}>
          <Pix r={chairBack(!at)} x={d.x} y={d.y} />
          {at && personAt(at, i)}
          <Pix r={deskFront(screenOf(at ? p.pose : null), p.prop, i % 3 !== 1)} x={d.x} y={d.y} />
          {at && p.pose === 'code' && <rect className="ofc-anim ofc-blink" x={d.x + 24} y={d.y + 21} width={2} height={1} fill="#e8fff0" />}
        </g>
      ); })}
      {/* 업무 공간과 아래 띠 사이 낮은 칸막이·화분 */}
      <rect x={0} y={L.band - 3} width={lounge.w + 4} height={3} fill="#9a6a3e" /><rect x={0} y={L.band - 3} width={lounge.w + 4} height={1} fill="#c99560" />
      {/* 라운지: 러그·소파·안락의자·커피 탁자·커피 바·스탠드·화분 */}
      {L.sofas.length > 0 && (() => { const x0 = L.sofas[0].x - 6; const x1 = Math.max(...L.sofas.map((s) => s.x + 14 + 3 * SOFA_SEAT), ...L.arms.map((a) => a.x + 46)) + 6; const y0 = L.sofas[0].y + 30; const y1 = Math.min(lounge.y + lounge.h - 6, (L.arms.length ? L.arms[0].y + 40 : y0 + 30)); return <g><rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill="#7f9e99" /><rect x={x0 + 3} y={y0 + 3} width={x1 - x0 - 6} height={y1 - y0 - 6} fill="none" stroke="#a8c2bd" strokeWidth={1} /></g>; })()}
      {L.sofas.map((s, i) => <Pix key={`sb${i}`} r={sofaBack(s.seats)} x={s.x} y={s.y} />)}
      {loungeP.filter((x) => x.seat?.kind === 'sofa').map((pl, i) => personAt(pl, i))}
      {L.sofas.map((s, i) => <Pix key={`sf${i}`} r={sofaFront(s.seats)} x={s.x} y={s.y} />)}
      {L.arms.map((a, i) => <Pix key={`ab${i}`} r={sofaBack(1, '#c8643c')} x={a.x} y={a.y} />)}
      {loungeP.filter((x) => x.seat?.kind === 'arm').map((pl, i) => personAt(pl, i))}
      {L.arms.map((a, i) => <Pix key={`af${i}`} r={sofaFront(1, '#c8643c')} x={a.x} y={a.y} />)}
      {L.sofas.length > 0 && L.arms.length === 0 && <Pix r={coffeeTable()} x={L.sofas[0].x + 30} y={L.sofas[0].y + 40} />}
      {L.arms.length > 0 && lounge.x + lounge.w - (L.bar ? 90 : 10) - (L.arms[L.arms.length - 1].x + 48) >= 50 && <Pix r={coffeeTable()} x={L.arms[L.arms.length - 1].x + 52} y={L.arms[0].y + 16} />}
      {lounge.h >= 150 && <Pix r={plant2(true)} x={lounge.x + 6} y={lounge.y + lounge.h - 40} />}
      {L.arms.length > 0 && lounge.y + lounge.h - (L.arms[0].y + 44) >= 56 && <g><Pix r={bookshelf2(42)} x={lounge.x + lounge.w - (L.bar ? 150 : 60)} y={lounge.y + lounge.h - 52} /><Pix r={plant2(true)} x={lounge.x + lounge.w - (L.bar ? 100 : 100)} y={lounge.y + lounge.h - 40} /></g>}
      {L.bar && <Pix r={coffeeBar()} x={L.bar.x} y={L.bar.y} />}
      {loungeP.filter((x) => x.seat?.kind === 'stand').map((pl, i) => personAt(pl, i))}
      <Pix r={floorLamp()} x={lounge.x + 1} y={L.sofas.length ? L.sofas[0].y - 22 : lounge.y + 4} />
      {/* 리뷰룸: 유리 벽, 의자, 앉은 사람, 탁자(앞), 검토 자료 */}
      <rect x={review.x - 4} y={review.y - 3} width={4} height={review.h + 3} fill="#bcd9e4" /><rect x={review.x - 3} y={review.y - 3} width={1} height={review.h + 3} fill="#ffffff" opacity={0.8} />
      <rect x={review.x - 4} y={review.y - 4} width={review.w + 4} height={4} fill="#bcd9e4" /><rect x={review.x - 4} y={review.y - 3} width={review.w + 4} height={1} fill="#ffffff" opacity={0.8} />
      {/* 줄마다: 빈 의자(앉은 사람이 없으면) → 탁자 → 사람(팔이 탁자 위에 오게) → 자료·노트북 */}
      {L.reviewRows.map((row, i) => {
        const lp = reviewP.find((x) => x.x === row.left.x && x.y === row.left.y); const rp = reviewP.find((x) => x.x === row.right.x && x.y === row.right.y);
        return (
          <g key={`rr${i}`}>
            <Pix r={pairTable(L.tableW)} x={row.tableX} y={row.tableY} />
            <Pix r={lp ? charSide(lp.p.char, 'sit') : emptySide()} x={row.left.x} y={row.left.y} />
            <Pix r={rp ? flipX(charSide(rp.p.char, 'review'), SIDE_W) : flipX(emptySide(), SIDE_W)} x={row.right.x} y={row.right.y} />
            {lp && <g><rect x={row.tableX + 8} y={row.tableY + 2} width={12} height={3} fill="#fbf8f0" /><rect className="ofc-anim ofc-mark" x={row.tableX + 10} y={row.tableY + 3} width={6} height={1} fill="#c2413b" /></g>}
            {rp?.p.external && <g><rect x={row.tableX + L.tableW - 20} y={row.tableY - 6} width={12} height={7} fill="#2b3350" /><rect x={row.tableX + L.tableW - 19} y={row.tableY - 5} width={10} height={5} fill="#7fd0c8" /></g>}
          </g>
        );
      })}
      <Pix r={plant2(true)} x={review.x + 4} y={review.y + review.h - 40} />
      {/* 선택 표시 */}
      {placed.filter((x) => x.p.key === selected).map(({ x, y, w, h }) => <rect key="sel" className="ofc-sel" x={x - 1} y={y - 1} width={w + 2} height={h + 2} fill="none" stroke="#14b8a6" strokeWidth={1} />)}
      {/* 조명: 책상 스탠드·모니터·플로어 램프(저녁·밤에 은은하게) */}
      <g style={{ opacity: mood.lamp, ...tr }} pointerEvents="none">
        {staff.map((p, i) => { const d = L.desks[i]; return <g key={p.key}><circle cx={d.x + 87} cy={d.y + 14} r={20} fill="url(#glow-lamp)" opacity={0.5} />{deskPlaced.has(p.key) && <circle cx={d.x + 18} cy={d.y + 16} r={18} fill="url(#glow-screen)" opacity={0.3} />}</g>; })}
        <circle cx={lounge.x + 10} cy={(L.sofas.length ? L.sofas[0].y - 22 : lounge.y + 4) + 6} r={28} fill="url(#glow-lamp)" opacity={0.55} />
        <circle cx={tx + L.tableW / 2} cy={ty} r={40} fill="url(#glow-lamp)" opacity={0.3} />
      </g>
    </svg>
  );
}
