// 사무실 그림(A안: 예전 픽셀 감성). 배경·가구·인물·상태 표시를 따로 그린다.
// 원칙: 한 사람은 지도에 한 번만. 자리·자세는 실제 상태에서만 정한다(업무 자리는 실제로 일할 때만 앉는다).
// 휴식 공간의 자리·자세(컵·책·기지개)와 깜빡임·손 흔들기는 장식이며 실제 상태·실행 기록을 바꾸지 않는다.
// 출력: 그림 한 칸이 실제 화면 화소 정수 개가 되는 배율만 쓰고(pickScale), 장면 칸 수는 무대 크기에서 계산한다.
// 시간대 분위기는 벽·바닥·창밖에만 입히고, 가구·인물·글자는 고유 색 그대로 둔다(밤에도 선명하게).
import { memo, type JSX } from 'react';
import type { Agent, MissionDenial } from '../../shared/types';
import { type ArtMod, type ArtPose, type DeskProp } from '../art';
import { retroBoard, retroChar, retroClock, retroCork, retroHead, retroPlant, retroShelf, retroWindow, RETRO_H, RETRO_SIT_H, RETRO_W } from '../artRetro';
import { type CharDef } from '../characters';
import { KITS, isStanding, type Piece } from '../officeKit';
import { habitsFor, loungePlan, reviewPlan, type Habit, type LoungePlan, type ReviewGroupIn, type ReviewPlan } from '../officePlan';
import { toPaths, type Rect } from '../pixel';
import type { Mood } from './officeTime';

export type State = 'work' | 'review' | 'wait' | 'rest' | 'off';
export type Pose = 'code' | 'doc' | 'plan' | 'review' | 'reviewed' | 'wait' | 'rest' | 'off';
export type Prop = DeskProp;
export type Person = {
  key: string; agent: Agent | null; code: string; name: string; role: string; char: CharDef; prop: Prop;
  state: State; pose: Pose; task: string; since: string | null; external: boolean; blocked: MissionDenial[]; blockedSteps: string[]; asks: boolean;
  /** 검토 중이면 리뷰 받는 직원의 key(같은 작업 그룹으로 묶기 위해) */
  reviewOf?: string | null;
};

export function propOf(a: { name: string; role: string }): Prop {
  const rules: [RegExp, Prop][] = [
    [/총괄|오퍼레이터|팀장/, 'clipboard'], [/보안|권한/, 'lock'], [/코드 리뷰|독립 검토|리뷰|검수/, 'redpen'], [/시험|품질|검증|QA/i, 'flask'],
    [/통합|결과물/, 'boxes'], [/프런트|프론트|화면|UI/i, 'tablet'], [/백엔드|서버|구현|개발/, 'server'], [/데이터|DB/i, 'server'],
    [/문서|작성/, 'books'], [/설계/, 'blueprint'], [/기획|요구|조사|분석|연구/, 'notes'], [/인프라|운영|배포/, 'cables'],
  ];
  return (rules.find(([re]) => re.test(a.name)) ?? rules.find(([re]) => re.test(a.role)))?.[1] ?? 'plant';
}

const K = KITS.A;
// ───── 배치(그림 1칸 = 1, A안 단위) ─────
export const WALL = 30;
const COL = 54; const DESK_W = K.desk.w; const DESK_H = K.desk.h;
const BAND_MIN = 92;
export const MIN_W = 300;
const TAG_PX = 22;
export type Box = { x: number; y: number; w: number; h: number };
export type WallItem = { kind: 'window' | 'shelf' | 'board' | 'clock' | 'cork' | 'plant'; x: number; w: number };
export type Layout = { scale: number; W: number; H: number; fits: boolean; cols: number; rows: number; desks: { x: number; y: number }[]; band: number; lounge: Box; review: Box; wall: WallItem[]; tableY: number };

export function layoutFor(staff: number, Wavail: number, Havail: number, offCount = 0, scale = 3, reviewGroups: number[] = [1]): Layout {
  const W = Math.max(MIN_W, Math.floor(Wavail));
  const n = Math.max(1, staff);
  const row = Math.max(44, 24 + Math.ceil(TAG_PX / scale) + 4); // 이름표가 다음 줄 머리를 가리지 않게
  const maxCols = Math.max(1, Math.min(n, Math.floor((W - 4) / COL)));
  const rows = Math.ceil(n / maxCols);
  const cols = Math.ceil(n / rows); // 줄마다 고르게(15+1처럼 한 줄에 몰리지 않게)
  const gridW = cols * COL - (COL - DESK_W);
  const x0 = Math.floor((W - gridW) / 2);
  const need = WALL + 4 + (rows - 1) * row + DESK_H + 4 + BAND_MIN;
  const H = Math.max(Math.floor(Havail), need);
  const extra = H - need;
  // 라운지는 장면 높이의 38%까지만 쓰고, 남는 높이는 업무 공간(책상 줄 사이·앞 통로)에 준다
  const loungeCap = Math.max(BAND_MIN, Math.round(H * 0.38));
  const workExtra = Math.max(0, extra - Math.max(0, loungeCap - BAND_MIN));
  const deskTop = WALL + 4 + Math.min(14, Math.floor(workExtra * 0.15));
  const pitch = row + (rows > 1 ? Math.min(22, Math.floor((workExtra * 0.5) / (rows - 1))) : 0);
  const used = (deskTop - WALL - 4) + (rows > 1 ? (pitch - row) * (rows - 1) : 0);
  const aisle = Math.min(18, Math.max(0, workExtra - used));
  const desks = Array.from({ length: staff }, (_, i) => ({ x: x0 + (i % cols) * COL, y: deskTop + Math.floor(i / cols) * pitch }));
  const band = deskTop + (rows - 1) * pitch + DESK_H + 4 + aisle;
  // 리뷰룸 폭: 동시에 열린 그룹 수에 맞춰(최대 장면 폭의 절반)
  // 리뷰룸 폭: 실제 그룹·참여자 수로 필요한 탁자 폭을 더해 정한다(최대 장면 폭의 55%, 넘치면 줄을 바꿔 앉음)
  const podsW = (reviewGroups.length ? reviewGroups : [1]).reduce((t, n) => t + K.pod(Math.max(1, n), []).w + 5, 6);
  const RW = Math.max(150, Math.min(Math.floor(W * 0.5), podsW + 30)); // 탁자 둘레에 여백을 둬 이름표가 방 밖으로 나가지 않게
  const review: Box = { x: W - RW, y: band, w: RW, h: H - band };
  const lounge: Box = { x: 0, y: band, w: W - RW - 2, h: H - band };
  return { scale, W, H, fits: need <= Math.floor(Havail), cols, rows, desks, band, lounge, review, wall: wallItems(W, offCount), tableY: band };
}

export function pickScale(stageW: number, stageH: number, dpr: number, staff: number, off: number, groups: number[] = [1], maxScale = 4): { scale: number; layout: Layout } {
  const d = dpr > 0 ? dpr : 1;
  // 가장 작은 배율: 보통 화면은 2배, 고해상도(레티나)는 1.5배까지(기기 픽셀 3배라 선명). 사무실 전체가 한 화면에 들어가게
  const minK = d >= 2 ? Math.ceil(1.5 * d) : Math.ceil(2 * d);
  for (let k = Math.floor(Math.min(4, maxScale) * d); k >= minK; k--) {
    const s = k / d; const L = layoutFor(staff, stageW / s, stageH / s, off, s, groups);
    if (stageW / s >= MIN_W && L.fits) return { scale: s, layout: L };
  }
  const s = minK / d;
  return { scale: s, layout: layoutFor(staff, stageW / s, stageH / s, off, s, groups) };
}

function wallItems(W: number, off: number): WallItem[] {
  const corkW = 6 + Math.max(1, Math.min(off, 6)) * 18;
  const right = off > 0 ? corkW + 6 : 0;
  const pattern: WallItem['kind'][] = ['shelf', 'window', 'plant', 'window', 'board', 'window', 'clock', 'shelf', 'window', 'window'];
  const widthOf = (k: WallItem['kind']) => (k === 'window' ? 36 : k === 'shelf' ? 24 : k === 'board' ? 32 : 12);
  const items: WallItem[] = []; let used = 0;
  for (const k of [...pattern, ...pattern]) { const w = widthOf(k); if (used + w + 8 > W - 8 - right) break; items.push({ kind: k, x: 0, w }); used += w + 8; }
  const gap = items.length > 1 ? Math.floor((W - 8 - right - used + 8 * items.length) / (items.length + (right ? 1 : 0))) : 8;
  let x = 4; for (const it of items) { it.x = x; x += it.w + gap; }
  if (off > 0) items.push({ kind: 'cork', x: W - corkW - 4, w: corkW });
  return items;
}

// ───── 자리 정하기 ─────
export type Placed = { p: Person; zone: 'desk' | 'review' | 'lounge'; x: number; y: number; w: number; h: number; pose: ArtPose; mod?: ArtMod; habits: Habit[]; spot?: string; group?: string };
export type Group = { key: string; task: string; author: Person | null; authorRef: Person | null; reviewers: Person[] };
export type Plan = { placed: Placed[]; lounge: LoungePlan; review: ReviewPlan; groups: Group[]; overflow: { review: Person[]; lounge: Person[] } };

/** 리뷰 그룹: 리뷰 받는 직원 한 명과 그 직원을 검토하는 사람들(같은 작업). 대상을 모르는 검토는 작업 이름으로 묶는다. */
export function reviewGroups(people: Person[]): Group[] {
  const authors = people.filter((p) => p.pose === 'reviewed');
  const reviewers = people.filter((p) => p.pose === 'review');
  const groups: Group[] = [];
  // 같은 직원이 여러 작업을 동시에 검토받으면 작업마다 다른 그룹(그 직원은 지도에 한 번만: 작업 이름이 맞는 첫 그룹에 앉는다)
  for (const a of authors) {
    const mine = reviewers.filter((r) => r.reviewOf === a.key);
    const tasks = [...new Set(mine.map((r) => r.task))];
    if (!tasks.length) { groups.push({ key: `g:${a.key}`, task: a.task, author: a, authorRef: a, reviewers: [] }); continue; }
    const seat = tasks.find((t) => a.task.includes(t)) ?? tasks[0];
    for (const t of tasks) groups.push({ key: `g:${a.key}:${t}`, task: t, author: t === seat ? a : null, authorRef: a, reviewers: mine.filter((r) => r.task === t) });
  }
  for (const r of reviewers) {
    if (groups.some((g) => g.reviewers.includes(r))) continue;
    const k = `t:${r.task}`; let g = groups.find((x) => x.key === k);
    if (!g) { g = { key: k, task: r.task, author: null, authorRef: null, reviewers: [] }; groups.push(g); }
    g.reviewers.push(r);
  }
  return groups;
}

export function placePeople(people: Person[], staff: Person[], L: Layout): Plan {
  const out: Placed[] = [];
  staff.forEach((p, i) => {
    if (p.pose === 'code' || p.pose === 'doc' || p.pose === 'plan') { // 대기 중인 직원은 책상을 비우고 라운지에서 쉰다
      const d = L.desks[i]; const pose: ArtPose = p.pose === 'code' ? 'type' : 'sit';
      out.push({ p, zone: 'desk', x: d.x + K.desk.seat.x, y: d.y + K.desk.seat.y, w: RETRO_W, h: RETRO_SIT_H, pose, habits: habitsFor(p.key, pose) });
    }
  });
  const groups = reviewGroups(people);
  const pad = 3;
  const rbox = { x: L.review.x + pad + 6, y: L.review.y + 12, w: L.review.w - 2 * pad - 12, h: L.review.h - 15 };
  const gin: ReviewGroupIn[] = groups.map((g) => ({ key: g.key, author: g.author?.key ?? null, reviewers: g.reviewers.map((r) => ({ key: r.key, external: r.external })) }));
  const review = reviewPlan(K, rbox, gin, Math.ceil(TAG_PX / L.scale) + 2);
  const byKey = new Map(people.map((p) => [p.key, p]));
  for (const pd of review.pods) {
    if (pd.author) { const a = byKey.get(pd.author)!; out.push({ p: a, zone: 'review', x: pd.x + pd.pod.author.x, y: pd.y + pd.pod.author.y, w: RETRO_W, h: RETRO_SIT_H, pose: 'sit', mod: 'glanceR', habits: [{ mod: 'blink', period: 6 + (a.key.length % 3), delay: 1 }], group: pd.key }); }
    for (const r of pd.shown) { const p = byKey.get(r.key)!; const pose: ArtPose = p.external ? 'sit' : 'review'; out.push({ p, zone: 'review', x: r.x, y: r.y, w: RETRO_W, h: RETRO_SIT_H, pose, mod: 'glanceL', habits: habitsFor(p.key, pose).filter((h) => h.mod === 'blink' || h.mod === 'sip'), group: pd.key }); }
  }
  const rest = people.filter((p) => p.pose === 'rest' || p.pose === 'wait');
  const lbox = { x: L.lounge.x + 3, y: L.lounge.y + 9, w: L.lounge.w - 6, h: L.lounge.h - 11 };
  const lounge = loungePlan(K, lbox, rest.map((p) => p.key), Math.ceil(TAG_PX / L.scale) + 2);
  for (const s of lounge.seats) { const p = byKey.get(s.key)!; out.push({ p, zone: 'lounge', x: s.x, y: s.y, w: RETRO_W, h: isStanding(s.pose) ? RETRO_H : RETRO_SIT_H, pose: s.pose, habits: s.habits, spot: s.spot }); }
  const hiddenReview = [...review.overflow.flatMap((g) => [g.author, ...g.reviewers.map((r) => r.key)]), ...review.pods.flatMap((p) => p.hidden)].filter((k): k is string => !!k).map((k) => byKey.get(k)!).filter(Boolean);
  return { placed: out, lounge, review, groups, overflow: { review: hiddenReview, lounge: lounge.overflow.map((k) => byKey.get(k)!) } };
}

// ───── 그리기 ─────
/** 도트 그림 조각: 같은 색끼리 한 경로. 움직임(CSS)은 바깥 g, 자리(translate)는 안쪽 g */
export const Pix = memo(function Pix({ r, x, y, className }: { r: Rect[]; x: number; y: number; className?: string }) {
  const body = <g transform={`translate(${x} ${y})`}>{toPaths(r).map((p) => <path key={p.fill} fill={p.fill} d={p.d} />)}</g>;
  return className ? <g className={className}>{body}</g> : body;
});

function Floor({ x, y, w, h, kind }: { x: number; y: number; w: number; h: number; kind: 'wood' | 'warm' | 'tile' | 'carpet' | 'lounge' }) {
  const r: JSX.Element[] = [];
  if (kind === 'lounge') {
    // 라운지: 밝은 헤링본 원목 바닥(업무 공간의 짙은 마루와 구분)
    r.push(<rect key="b" x={x} y={y} width={w} height={h} fill="#ecd3ad" />);
    for (let yy = y, i = 0; yy < y + h; yy += 4, i++) for (let xx = x + ((i % 2) * 6); xx < x + w; xx += 12) {
      r.push(<rect key={`a${yy}-${xx}`} x={xx} y={yy} width={6} height={4} fill="#e4c79d" />);
      r.push(<rect key={`l${yy}-${xx}`} x={xx} y={yy + 3} width={6} height={1} fill="#d8b98c" />);
    }
    return <g>{r}</g>;
  }
  if (kind === 'carpet') {
    // 리뷰룸: 짙은 청회색 카펫에 잔잔한 마름모 무늬
    r.push(<rect key="b" x={x} y={y} width={w} height={h} fill="#3f5068" />);
    for (let yy = y + 3, i = 0; yy < y + h; yy += 6, i++) for (let xx = x + 3 + (i % 2) * 3; xx < x + w - 1; xx += 6) r.push(<rect key={`d${yy}-${xx}`} x={xx} y={yy} width={1} height={1} fill="#566a85" />);
    return <g>{r}</g>;
  }
  if (kind === 'tile') {
    r.push(<rect key="b" x={x} y={y} width={w} height={h} fill="#dfe5dc" />);
    for (let yy = y + 8; yy < y + h; yy += 9) r.push(<rect key={`y${yy}`} x={x} y={yy} width={w} height={1} fill="#ccd4ca" />);
    for (let xx = x + 8; xx < x + w; xx += 9) r.push(<rect key={`x${xx}`} x={xx} y={y} width={1} height={h} fill="#ccd4ca" />);
    return <g>{r}</g>;
  }
  const base = kind === 'wood' ? '#cf9c6c' : '#d9ab7a'; const line = kind === 'wood' ? '#b98654' : '#c99a6a'; const alt = kind === 'wood' ? '#c99566' : '#d4a472';
  r.push(<rect key="b" x={x} y={y} width={w} height={h} fill={base} />);
  for (let yy = y, i = 0; yy < y + h; yy += 5, i++) {
    if (i % 2) r.push(<rect key={`a${i}`} x={x} y={yy} width={w} height={4} fill={alt} />);
    r.push(<rect key={`l${i}`} x={x} y={yy + 4} width={w} height={1} fill={line} />);
    for (let xx = x + ((i * 17) % 31); xx < x + w; xx += 31) r.push(<rect key={`j${i}-${xx}`} x={xx} y={yy} width={1} height={4} fill={line} />);
  }
  return <g>{r}</g>;
}

function screenOf(pose: Pose | null): 'code' | 'doc' | 'plan' | 'wait' | 'off' { return pose === 'code' ? 'code' : pose === 'doc' ? 'doc' : pose === 'plan' ? 'plan' : pose === 'wait' ? 'wait' : 'off'; }

/** 사람 하나: 기본 그림 + 직원마다 다른 때에 잠깐 보이는 버릇(깜빡임·곁눈질·한 모금). 손 흔들기는 누른 직후 잠깐 */
function Actor({ pl, waving, still }: { pl: Placed; waving: boolean; still: boolean }) {
  const c = pl.p.char; const standing = isStanding(pl.pose);
  if (waving && !still) return <Pix r={retroChar(c, standing ? 'wave' : pl.pose, 0, standing ? '' : 'wave')} x={pl.x} y={pl.y} className="ofc-wave" />;
  const base = pl.pose === 'type'
    ? <><Pix r={retroChar(c, 'type', 0, pl.mod)} x={pl.x} y={pl.y} className="ofc-fa" /><Pix r={retroChar(c, 'type', 1, pl.mod)} x={pl.x} y={pl.y} className="ofc-fb" /></>
    : <Pix r={retroChar(c, pl.pose, 0, pl.mod)} x={pl.x} y={pl.y} />;
  return (
    <g>
      {base}
      {!still && pl.habits.map((h) => <g key={h.mod} className={`ofc-hab ofc-hab-${h.mod === 'blink' ? 'short' : 'long'}`} style={{ animationDuration: `${h.period}s`, animationDelay: `${h.delay}s` }}><Pix r={retroChar(c, pl.pose, 0, h.mod)} x={pl.x} y={pl.y} /></g>)}
    </g>
  );
}

const shiftP = (ps: Piece[], x: number, y: number) => ps.map((p) => ({ ...p, x: p.x + x, y: p.y + y }));
function Pieces({ ps, sky }: { ps: Piece[]; sky: string }) {
  return <>{ps.map((p, i) => <g key={i}>{p.sky && <rect x={p.x + 2} y={p.y + 2} width={p.sky.w - 2} height={p.sky.h - 2} fill={sky} />}<Pix r={p.r} x={p.x} y={p.y} /></g>)}</>;
}

/** 사무실 그림 */
export function Scene({ people, staff, layout: L, plan, mood, selected, waving, still, selectedGroup, onGroup }: {
  people: Person[]; staff: Person[]; layout: Layout; plan: Plan; mood: Mood; selected: string | null; waving: string | null; still: boolean; selectedGroup: string | null; onGroup: (key: string) => void;
}) {
  const { W, H, lounge, review } = L;
  const tr = { transition: 'fill 1.6s ease, opacity 1.6s ease, stop-color 1.6s ease' };
  const placed = plan.placed;
  const deskPlaced = new Map(placed.filter((x) => x.zone === 'desk').map((x) => [x.p.key, x]));
  const off = people.filter((p) => p.state === 'off');
  const wins = L.wall.filter((w) => w.kind === 'window');
  const sky = 'url(#ofc-sky)';
  return (
    <svg className="ofc-scene" viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" shapeRendering="crispEdges" role="img" aria-label="사무실: 직원들의 위치와 현재 상태">
      <defs>
        <linearGradient id="ofc-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" style={{ stopColor: mood.skyTop, ...tr }} /><stop offset="100%" style={{ stopColor: mood.skyBottom, ...tr }} /></linearGradient>
        <radialGradient id="glow-lamp"><stop offset="0%" stopColor="#ffd38a" stopOpacity={0.85} /><stop offset="100%" stopColor="#ffd38a" stopOpacity={0} /></radialGradient>
        <radialGradient id="glow-screen"><stop offset="0%" stopColor="#a6e8ff" stopOpacity={0.7} /><stop offset="100%" stopColor="#a6e8ff" stopOpacity={0} /></radialGradient>
      </defs>
      <style>{`.ofc-city{fill:${mood.city};transition:fill 1.6s ease}.ofc-citylights{opacity:${mood.cityLights};transition:opacity 1.6s ease}`}</style>
      {/* 바닥·벽 */}
      <Floor x={0} y={WALL} w={W} h={L.band - WALL} kind="wood" />
      <Floor x={lounge.x} y={lounge.y} w={lounge.w + 2} h={lounge.h} kind="lounge" />
      <Floor x={review.x} y={review.y} w={review.w} h={review.h} kind="carpet" />
      <rect x={0} y={0} width={W} height={WALL} fill="#f1e8d3" /><rect x={0} y={0} width={W} height={1} fill="#dccfb1" />
      <rect x={0} y={WALL - 3} width={W} height={3} fill="#9a6538" /><rect x={0} y={WALL - 3} width={W} height={1} fill="#e2b07a" />
      {wins.map((w, i) => (
        <g key={i}>
          <rect x={w.x + 2} y={3} width={w.w - 4} height={20} fill={sky} />
          {[[3, 8], [9, 12], [15, 6], [20, 13], [26, 9]].filter(([bx]) => bx + 5 < w.w - 2).map(([bx, bh], k) => <rect key={k} x={w.x + bx} y={23 - bh} width={4} height={bh} className="ofc-city" />)}
          <g className="ofc-citylights">{[[3, 8], [9, 12], [15, 6], [20, 13], [26, 9]].filter(([bx]) => bx + 5 < w.w - 2).map(([bx, bh], k) => <rect key={k} x={w.x + bx + 1} y={25 - bh} width={1} height={1} fill="#ffd77a" />)}</g>
        </g>
      ))}
      <g style={{ opacity: mood.sunOpacity * 0.7, ...tr }} pointerEvents="none">
        {wins.map((w, i) => <polygon key={i} points={`${w.x + 2 + mood.sunShift * 0.1},${WALL} ${w.x + w.w - 2 + mood.sunShift * 0.1},${WALL} ${w.x + w.w - 2 + mood.sunShift * 0.5},${WALL + 26} ${w.x + 2 + mood.sunShift * 0.5},${WALL + 26}`} style={{ fill: mood.sunLight, ...tr }} />)}
      </g>
      <rect x={0} y={0} width={W} height={H} style={{ fill: mood.ambient, opacity: mood.ambientOpacity * 0.45, ...tr }} pointerEvents="none" />
      {L.wall.map((w, i) => w.kind === 'window' ? <Pix key={i} r={retroWindow()} x={w.x} y={1} />
        : w.kind === 'shelf' ? <Pix key={i} r={retroShelf()} x={w.x} y={1} />
        : w.kind === 'board' ? <Pix key={i} r={retroBoard()} x={w.x} y={4} />
        : w.kind === 'clock' ? <Pix key={i} r={retroClock()} x={w.x} y={7} />
        : w.kind === 'plant' ? <g key={i}><rect x={w.x + 6} y={0} width={1} height={5} fill="#5e3a20" /><Pix r={retroPlant()} x={w.x - 2} y={4} /></g>
        : <g key={i}><Pix r={retroCork(Math.min(off.length, 6))} x={w.x} y={4} />{off.slice(0, 6).map((p, k) => <Pix key={p.key} r={retroHead(p.char)} x={w.x + 3 + k * 18} y={6} />)}</g>)}
      {/* 책상: 의자 → 사람 → 책상 앞 */}
      {staff.map((p, i) => { const d = L.desks[i]; const at = deskPlaced.get(p.key); return (
        <g key={p.key}>
          <Pix r={K.deskBack(!at)} x={d.x} y={d.y} />
          {at && <Actor pl={at} waving={waving === p.key} still={still} />}
          <Pix r={K.deskFront(screenOf(at ? p.pose : null), p.prop, i)} x={d.x} y={d.y} />
          {at && p.pose === 'code' && <rect className="ofc-anim ofc-blink" x={d.x + 12} y={d.y + 11} width={1} height={1} fill="#e8fff0" />}
        </g>
      ); })}
      {/* 라운지 경계: 낮은 화분 칸막이 */}
      <rect x={0} y={L.band - 3} width={lounge.w + 2} height={4} fill="#7a5233" /><rect x={0} y={L.band - 3} width={lounge.w + 2} height={1} fill="#a87a4f" />
      {Array.from({ length: Math.floor((lounge.w - 4) / 10) }, (_, i) => <g key={`hd${i}`}><rect x={2 + i * 10} y={L.band - 6} width={8} height={4} fill={i % 3 === 1 ? '#5f9a4c' : '#6fae57'} /><rect x={3 + i * 10} y={L.band - 7} width={3} height={2} fill="#87c46c" /></g>)}
      {/* 라운지 러그: 가구 묶음마다 그 아래에 작은 러그(테라코타·세이지·머스터드 번갈아) */}
      {(() => {
        const sts = [...plan.lounge.stations].sort((a, b) => a.x - b.x);
        const groups: { x0: number; y0: number; x1: number; y1: number }[] = [];
        for (const st of sts) {
          const g = groups[groups.length - 1];
          const b = { x0: st.x, y0: st.y, x1: st.x + st.st.w, y1: st.y + st.st.h };
          if (g && b.x0 - g.x1 <= 10 && Math.abs(b.y0 - g.y0) <= 16) { g.x1 = Math.max(g.x1, b.x1); g.y0 = Math.min(g.y0, b.y0); g.y1 = Math.max(g.y1, b.y1); } else groups.push(b);
        }
        const pal = [['#d08a68', '#b56f4f', '#e6a787'], ['#9fb59a', '#879f82', '#c3d3be'], ['#d9b25e', '#bf9643', '#ecd08e']];
        return groups.map((g, k) => { const c = pal[k % pal.length]; const rx = g.x0 - 4; const ry = g.y0 + Math.floor((g.y1 - g.y0) * 0.45); const rw = g.x1 - g.x0 + 8; const rh = Math.max(10, g.y1 - ry + 4);
          return <g key={`rug${k}`}><rect x={rx} y={ry} width={rw} height={rh} fill={c[1]} /><rect x={rx + 1} y={ry + 1} width={rw - 2} height={rh - 2} fill={c[0]} /><rect x={rx + 3} y={ry + 3} width={rw - 6} height={rh - 6} fill="none" stroke={c[2]} strokeWidth={1} /></g>; });
      })()}
      {/* 리뷰룸 꾸밈: 벽 판넬·나무 몰딩, 유리 칸막이, 가장자리 띠, 화분 */}
      <rect x={review.x} y={review.y} width={review.w} height={8} fill="#e8dfca" /><rect x={review.x} y={review.y + 8} width={review.w} height={1} fill="#7a5233" /><rect x={review.x} y={review.y + 7} width={review.w} height={1} fill="#b98654" />
      {Array.from({ length: Math.floor((review.w - 4) / 14) }, (_, i) => <rect key={`wp${i}`} x={review.x + 4 + i * 14} y={review.y + 2} width={10} height={4} fill="#ddd2b8" />)}
      <rect x={review.x + 1} y={review.y + 9} width={review.w - 2} height={review.h - 10} fill="none" stroke="#2f3d50" strokeWidth={1} />
      <rect x={review.x - 2} y={review.y} width={3} height={review.h} fill="#b7d7e6" opacity={0.85} /><rect x={review.x - 2} y={review.y} width={1} height={review.h} fill="#6b7f90" /><rect x={review.x} y={review.y} width={1} height={review.h} fill="#e8f5fb" />
      {Array.from({ length: Math.floor(review.h / 24) }, (_, i) => <rect key={`gp${i}`} x={review.x - 2} y={review.y + 12 + i * 24} width={3} height={1} fill="#6b7f90" />)}
      <Pix r={retroPlant()} x={review.x + review.w - 16} y={review.y + review.h - 22} />
      {/* 휴식 공간: 자리 묶음마다 가구 뒤 → 사람 → 가구 앞 */}
      {plan.lounge.stations.map((st, i) => {
        const inside = placed.filter((x) => x.zone === 'lounge' && x.x >= st.x - 2 && x.x < st.x + st.st.w && x.y >= st.y - 4 && x.y < st.y + st.st.h);
        return <g key={`st${i}`}><Pieces ps={shiftP(st.st.back, st.x, st.y)} sky={sky} />{inside.map((pl) => <Actor key={pl.p.key} pl={pl} waving={waving === pl.p.key} still={still} />)}<Pieces ps={shiftP(st.st.front, st.x, st.y)} sky={sky} /></g>;
      })}
      {/* 리뷰룸: 유리 벽, 작업별 그룹(탁자·공유 화면·참여자) */}
      <rect x={review.x - 2} y={review.y - 2} width={2} height={review.h + 2} fill="#c6e0ea" /><rect x={review.x - 2} y={review.y - 2} width={review.w + 2} height={2} fill="#c6e0ea" />
      {plan.review.pods.length === 0 && (() => { const pod = K.pod(2, []); const x = review.x + Math.floor((review.w - pod.w) / 2); const y = review.y + Math.floor((review.h - pod.h) / 2); return <g opacity={0.9}><Pieces ps={shiftP(pod.back, x, y)} sky={sky} />{pod.reviewers.map((r, i) => <Pix key={i} r={K.deskBack(true)} x={x + r.x - 17} y={y + r.y + 2} />)}<Pieces ps={shiftP(pod.front, x, y)} sky={sky} /></g>; })()}
      {plan.review.pods.map((pd) => {
        const members = placed.filter((x) => x.group === pd.key);
        const author = members.find((m) => m.p.key === pd.author);
        return (
          <g key={pd.key}>
            <rect x={pd.x - 1} y={pd.y - 1} width={pd.pod.w + 2} height={pd.pod.h + 2} fill={selectedGroup === pd.key ? '#14b8a622' : '#00000008'} stroke={selectedGroup === pd.key ? '#14b8a6' : '#0000001a'} strokeWidth={1} style={{ cursor: 'pointer' }} onClick={() => onGroup(pd.key)}><title>리뷰 그룹 — 눌러서 작업·참여자·상태·결과물 보기</title></rect>
            <Pieces ps={shiftP(pd.pod.back, pd.x, pd.y)} sky={sky} />
            {members.filter((m) => m !== author).map((m) => <Actor key={m.p.key} pl={m} waving={waving === m.p.key} still={still} />)}
            <Pieces ps={shiftP(pd.pod.front, pd.x, pd.y)} sky={sky} />
            {pd.pod.laptops.map((l, i) => <Pix key={i} r={K.laptop()} x={pd.x + l.x} y={pd.y + l.y} />)}
            {author && <Actor pl={author} waving={waving === author.p.key} still={still} />}
            {author && <rect className="ofc-anim ofc-mark" x={pd.x + pd.pod.author.x + 22} y={pd.y + 21} width={4} height={1} fill="#c2413b" />}
          </g>
        );
      })}
      {/* 선택 표시 */}
      {placed.filter((x) => x.p.key === selected).map(({ x, y, w, h }) => <rect key="sel" className="ofc-sel" x={x - 1} y={y - 1} width={w + 2} height={h + 2} fill="none" stroke="#14b8a6" strokeWidth={1} />)}
      {/* 조명(저녁·밤에 은은하게) */}
      <g style={{ opacity: mood.lamp, ...tr }} pointerEvents="none">
        {staff.map((p, i) => { const d = L.desks[i]; return <g key={p.key}><circle cx={d.x + 42} cy={d.y + 6} r={10} fill="url(#glow-lamp)" opacity={0.5} />{deskPlaced.has(p.key) && <circle cx={d.x + 10} cy={d.y + 8} r={9} fill="url(#glow-screen)" opacity={0.3} />}</g>; })}
      </g>
    </svg>
  );
}
