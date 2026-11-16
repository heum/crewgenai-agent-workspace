// 사무실 그림(배경·가구·인물)과 자리 배치. 그림은 이 앱에서 직접 그린 도트 그림이다.
// 원칙: 한 사람은 지도에 한 번만. 자리·자세는 실제 상태에서만 정한다(업무 자리는 실제로 일할 때만 앉는다).
// 시간대 분위기는 벽·바닥·창밖에만 입히고, 가구·인물·글자는 고유 색 그대로 둔다(밤에도 선명하게).
import { type JSX } from 'react';
import type { Agent, MissionDenial } from '../../shared/types';
import { type CharDef } from '../characters';
import { CharG } from './CharacterArt';
import type { Mood } from './officeTime';

export type State = 'work' | 'review' | 'wait' | 'rest' | 'off';
export type Pose = 'code' | 'doc' | 'plan' | 'review' | 'reviewed' | 'wait' | 'rest' | 'off';
export type Prop = 'clipboard' | 'notes' | 'blueprint' | 'server' | 'tablet' | 'books' | 'lock' | 'redpen' | 'flask' | 'boxes' | 'plant' | 'cables';
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

// ───── 배치(도트 1칸 = 1) ─────
export const W = 320;
export const WALL = 34; // 윗벽(창·책장)
export const COLS = 4; export const CELL_W = 50; export const CELL_H = 46;
export const DIV_X = 206; export const ROOM_X = 210;
const LOUNGE_H = 62;
export type Layout = { H: number; rows: number; workBottom: number; loungeY: number };
export function layoutFor(staff: number): Layout {
  const rows = Math.max(2, Math.ceil(staff / COLS));
  const workBottom = WALL + 4 + rows * CELL_H;
  const loungeY = Math.max(workBottom, WALL + 4 + 2 * CELL_H) + 4;
  return { rows, workBottom, loungeY, H: loungeY + LOUNGE_H };
}
export const deskAt = (i: number) => ({ x: 4 + (i % COLS) * CELL_W, y: WALL + 4 + Math.floor(i / COLS) * CELL_H });
// 리뷰룸 좌석(탁자 왼쪽: 리뷰 받는 직원, 오른쪽: 검토하는 쪽)
const LEFT_SEATS = [[214, 44], [214, 68], [214, 92]] as const;
const RIGHT_SEATS = [[288, 44], [288, 68], [288, 92]] as const;
/** 라운지 자리(쉬는 직원 수만큼 앞에서부터): 소파 두 개·안락의자·바 의자·서 있는 자리 */
function loungeSeats(L: number): { x: number; y: number; pose: 'rest' | 'sit' | 'stand' }[] {
  return [
    ...[24, 42, 60].map((x) => ({ x, y: L + 10, pose: 'rest' as const })),
    ...[104, 122, 140].map((x) => ({ x, y: L + 10, pose: 'rest' as const })),
    { x: 172, y: L + 16, pose: 'sit' as const }, { x: 192, y: L + 16, pose: 'sit' as const },
    ...[226, 244, 262].map((x) => ({ x, y: L + 8, pose: 'sit' as const })),
    { x: 84, y: L + 30, pose: 'stand' as const }, { x: 206, y: L + 30, pose: 'stand' as const },
  ];
}

export type Placed = { p: Person; zone: 'desk' | 'review' | 'lounge'; x: number; y: number; w: number; h: number; pose: 'type' | 'sit' | 'review' | 'rest' | 'stand' };
/** 사람마다 한 자리(중복 없음). 휴가는 라운지 게시판의 사진으로만 보인다. 자리가 모자라면 넘친 인원을 따로 돌려준다. */
export function placePeople(people: Person[], staff: Person[], layout: Layout): { placed: Placed[]; overflow: { review: number; lounge: number } } {
  const out: Placed[] = [];
  staff.forEach((p, i) => {
    if (p.pose === 'code' || p.pose === 'doc' || p.pose === 'plan' || p.pose === 'wait') {
      const d = deskAt(i);
      out.push({ p, zone: 'desk', x: d.x + 16, y: d.y + 1, w: 18, h: 18, pose: p.pose === 'code' ? 'type' : 'sit' });
    }
  });
  const left = people.filter((p) => p.pose === 'reviewed');
  const right = people.filter((p) => p.pose === 'review');
  left.slice(0, 3).forEach((p, i) => out.push({ p, zone: 'review', x: LEFT_SEATS[i][0], y: LEFT_SEATS[i][1], w: 18, h: 18, pose: 'sit' }));
  right.slice(0, 3).forEach((p, i) => out.push({ p, zone: 'review', x: RIGHT_SEATS[i][0], y: RIGHT_SEATS[i][1], w: 18, h: 18, pose: 'review' }));
  const rest = people.filter((p) => p.pose === 'rest');
  const seats = loungeSeats(layout.loungeY);
  rest.slice(0, seats.length).forEach((p, i) => { const s = seats[i]; out.push({ p, zone: 'lounge', x: s.x, y: s.y, w: 18, h: s.pose === 'stand' ? 26 : 18, pose: s.pose }); });
  return { placed: out, overflow: { review: Math.max(0, left.length - 3) + Math.max(0, right.length - 3), lounge: Math.max(0, rest.length - seats.length) } };
}

// ───── 그림 조각 ─────
const OUTL = '#3a2a22';
const WOOD = { hi: '#e2b07a', top: '#cf9a62', mid: '#b8814c', front: '#9a6538', dark: '#7a4c2a', leg: '#5e3a20' };

function Floor({ H }: { H: number }) {
  const r: JSX.Element[] = [];
  for (let y = WALL, i = 0; y < H; y += 6, i++) {
    r.push(<rect key={`p${i}`} x={0} y={y} width={W} height={6} fill={i % 2 ? '#c99566' : '#cf9c6c'} />);
    r.push(<rect key={`l${i}`} x={0} y={y + 5} width={W} height={1} fill="#b98654" />);
    for (let x = (i * 29) % 53; x < W; x += 53) r.push(<rect key={`j${i}-${x}`} x={x} y={y} width={1} height={5} fill="#b98654" />);
  }
  return <g>{r}</g>;
}
function Books({ x, y, w }: { x: number; y: number; w: number }) {
  const cols = ['#b5523b', '#3d6fb0', '#2f8a63', '#d9a03a', '#7a58b8', '#e2d6bd', '#c2547d', '#3a4b6e'];
  const r: JSX.Element[] = [];
  let cx = x; let i = 0;
  while (cx < x + w - 2) { const bw = 2 + (i % 3 === 0 ? 1 : 0); const bh = 6 - (i % 4 === 1 ? 1 : 0); r.push(<rect key={i} x={cx} y={y + (6 - bh)} width={bw} height={bh} fill={cols[i % cols.length]} />); r.push(<rect key={`s${i}`} x={cx} y={y + (6 - bh)} width={bw} height={1} fill="#ffffff" opacity={0.25} />); cx += bw; i++; if (i % 7 === 6) cx += 2; }
  return <g>{r}</g>;
}
function Bookshelf({ x, y, w }: { x: number; y: number; w: number }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={26} fill={WOOD.front} /><rect x={x} y={y} width={w} height={2} fill={WOOD.hi} />
      <rect x={x + 2} y={y + 3} width={w - 4} height={9} fill="#5e3a20" /><rect x={x + 2} y={y + 14} width={w - 4} height={9} fill="#5e3a20" />
      <Books x={x + 3} y={y + 5} w={w - 6} /><Books x={x + 3} y={y + 16} w={w - 8} />
      <rect x={x} y={y + 26} width={w} height={2} fill="#000" opacity={0.15} />
    </g>
  );
}
function Window({ x, w, id }: { x: number; w: number; id: string }) {
  const blds = [[1, 7], [6, 10], [12, 6], [16, 12], [23, 8], [28, 11], [34, 6], [38, 9], [44, 7], [49, 10]].filter(([bx]) => bx + 4 < w - 1);
  return (
    <g>
      <rect x={x - 2} y={3} width={w + 4} height={22} fill="#e9dfca" /><rect x={x - 1} y={4} width={w + 2} height={20} fill="#3b4566" />
      <rect x={x} y={5} width={w} height={17} fill={`url(#sky-${id})`} />
      {blds.map(([bx, bh], i) => <rect key={i} x={x + bx} y={22 - bh} width={5} height={bh} className="ofc-city" />)}
      <g className="ofc-citylights">{blds.map(([bx, bh], i) => <g key={i}><rect x={x + bx + 1} y={24 - bh} width={1} height={1} fill="#ffd77a" /><rect x={x + bx + 3} y={26 - bh} width={1} height={1} fill="#ffd77a" /></g>)}</g>
      {Array.from({ length: Math.floor(w / 14) }, (_, i) => <rect key={i} x={x + (i + 1) * (w / (Math.floor(w / 14) + 1))} y={5} width={1} height={17} fill="#3b4566" />)}
      <rect x={x} y={5} width={w} height={3} fill="#efe6d2" opacity={0.85} /><rect x={x} y={8} width={w} height={1} fill="#c9bb9c" opacity={0.6} />
      <rect x={x - 3} y={24} width={w + 6} height={2} fill="#efe6d2" /><rect x={x - 3} y={26} width={w + 6} height={1} fill="#b59f7a" />
    </g>
  );
}
function Plant({ x, y, big }: { x: number; y: number; big?: boolean }) {
  return big ? (
    <g><rect x={x + 3} y={y + 14} width={9} height={8} fill="#b4673d" /><rect x={x + 3} y={y + 14} width={9} height={2} fill="#cf8250" /><rect x={x + 4} y={y + 22} width={7} height={1} fill="#000" opacity={0.15} />
      <rect x={x + 1} y={y + 5} width={13} height={10} fill="#2f7d55" /><rect x={x + 3} y={y + 1} width={9} height={6} fill="#3e9a68" /><rect x={x + 6} y={y - 2} width={4} height={4} fill="#4fb07a" />
      <rect x={x} y={y + 8} width={3} height={3} fill="#4fb07a" /><rect x={x + 12} y={y + 9} width={3} height={3} fill="#3e9a68" /><rect x={x + 5} y={y + 6} width={2} height={2} fill="#62c48a" /></g>
  ) : (
    <g><rect x={x + 1} y={y + 6} width={6} height={5} fill="#b4673d" /><rect x={x + 1} y={y + 6} width={6} height={1} fill="#cf8250" /><rect x={x} y={y + 1} width={8} height={5} fill="#2f7d55" /><rect x={x + 2} y={y - 1} width={4} height={3} fill="#4fb07a" /></g>
  );
}
function Hanging({ x }: { x: number }) {
  return <g><rect x={x + 5} y={0} width={1} height={6} fill="#5e3a20" /><rect x={x + 2} y={6} width={7} height={4} fill="#b4673d" /><rect x={x} y={9} width={11} height={4} fill="#2f7d55" /><rect x={x + 1} y={13} width={2} height={7} fill="#3e9a68" /><rect x={x + 8} y={13} width={2} height={5} fill="#3e9a68" /><rect x={x + 4} y={13} width={2} height={4} fill="#4fb07a" /></g>;
}
function DeskProp({ prop, x, y }: { prop: Prop; x: number; y: number }) {
  switch (prop) {
    case 'clipboard': return <g><rect x={x} y={y + 1} width={6} height={7} fill="#b88a55" /><rect x={x + 1} y={y + 2} width={4} height={5} fill="#fbf6ea" /><rect x={x + 2} y={y} width={2} height={2} fill="#8a8f99" /><rect x={x + 1} y={y + 3} width={3} height={1} fill="#9aa1ad" /></g>;
    case 'notes': return <g><rect x={x} y={y + 3} width={4} height={4} fill="#f7d774" /><rect x={x + 3} y={y + 5} width={4} height={3} fill="#9ad3a8" /><rect x={x + 1} y={y + 1} width={3} height={3} fill="#f3a6b8" /></g>;
    case 'blueprint': return <g><rect x={x} y={y + 4} width={8} height={4} fill="#3d6fb0" /><rect x={x + 1} y={y + 5} width={6} height={1} fill="#cfe2ff" /><rect x={x + 6} y={y + 2} width={2} height={6} fill="#f2c94c" /></g>;
    case 'server': return <g><rect x={x} y={y} width={6} height={8} fill="#2e3442" /><rect x={x} y={y} width={6} height={1} fill="#4a5266" /><rect x={x + 1} y={y + 2} width={4} height={1} fill="#3ad29f" className="ofc-led" /><rect x={x + 1} y={y + 4} width={4} height={1} fill="#5a6478" /><rect x={x + 1} y={y + 6} width={2} height={1} fill="#e0a43c" /></g>;
    case 'tablet': return <g><rect x={x} y={y + 3} width={7} height={5} fill="#1f2638" /><rect x={x + 1} y={y + 4} width={5} height={3} fill="#f3a6b8" /><rect x={x + 2} y={y + 5} width={2} height={1} fill="#fff" /></g>;
    case 'books': return <g><rect x={x} y={y + 5} width={8} height={1} fill="#7d2333" /><rect x={x + 1} y={y + 6} width={7} height={1} fill="#2f8a63" /><rect x={x} y={y + 7} width={8} height={1} fill="#d9953a" /><rect x={x + 1} y={y} width={2} height={5} fill="#3d6fb0" /><rect x={x + 3} y={y + 1} width={2} height={4} fill="#c2547d" /></g>;
    case 'lock': return <g><rect x={x} y={y + 4} width={6} height={4} fill="#e0a43c" /><rect x={x + 1} y={y + 1} width={1} height={3} fill="#8a8f99" /><rect x={x + 4} y={y + 1} width={1} height={3} fill="#8a8f99" /><rect x={x + 1} y={y} width={4} height={1} fill="#8a8f99" /><rect x={x + 2} y={y + 5} width={2} height={2} fill="#7a4c2a" /></g>;
    case 'redpen': return <g><rect x={x} y={y + 2} width={7} height={6} fill="#fbf6ea" /><rect x={x + 1} y={y + 3} width={4} height={1} fill="#9aa1ad" /><rect x={x + 1} y={y + 5} width={3} height={1} fill="#c2413b" /><rect x={x + 6} y={y} width={1} height={5} fill="#c2413b" /></g>;
    case 'flask': return <g><rect x={x + 2} y={y} width={2} height={3} fill="#d6eef2" /><rect x={x} y={y + 3} width={6} height={5} fill="#5bc0be" /><rect x={x + 1} y={y + 5} width={4} height={2} fill="#2f8f8f" /><rect x={x + 1} y={y + 3} width={1} height={1} fill="#ffffff" opacity={0.6} /></g>;
    case 'boxes': return <g><rect x={x} y={y + 3} width={7} height={5} fill="#c49a62" /><rect x={x + 1} y={y} width={5} height={3} fill="#d9b27a" /><rect x={x + 3} y={y + 3} width={1} height={5} fill="#9e7848" /></g>;
    case 'cables': return <g><rect x={x} y={y + 2} width={6} height={6} fill="#3b3f48" /><rect x={x + 1} y={y + 3} width={1} height={1} fill="#3ad29f" className="ofc-led" /><rect x={x + 3} y={y + 3} width={1} height={1} fill="#3ad29f" /><rect x={x + 6} y={y + 5} width={2} height={1} fill="#e0a43c" /><rect x={x + 7} y={y + 6} width={1} height={2} fill="#e0a43c" /></g>;
    default: return <Plant x={x} y={y - 1} />;
  }
}

/** 책상 한 칸: 의자 등받이·상판(윗면·앞면·그늘)·다리·모니터·키보드·마우스·스탠드·직군 소품. 사람이 앉아 있으면 화면 내용이 상태를 따른다. */
function Desk({ x, y, p, occupied, pose }: { x: number; y: number; p: Person; occupied: boolean; pose: Pose | null }) {
  const screen = pose === 'code' ? '#12333d' : pose === 'doc' ? '#f1ece0' : pose === 'plan' ? '#e9eef7' : pose === 'wait' ? '#26304a' : '#1b2130';
  return (
    <g>
      {/* 의자: 앉아 있으면 등받이만 뒤로, 비어 있으면 책상에서 빼 둔 의자 */}
      {occupied ? <g><rect x={x + 18} y={y + 2} width={14} height={13} fill="#34406a" /><rect x={x + 18} y={y + 2} width={14} height={2} fill="#4a5a92" /></g>
        : <g><rect x={x + 20} y={y + 6} width={11} height={9} fill="#34406a" /><rect x={x + 20} y={y + 6} width={11} height={2} fill="#4a5a92" /><rect x={x + 22} y={y + 15} width={7} height={2} fill="#2a3150" /></g>}
      {/* 상판 */}
      <rect x={x + 1} y={y + 15} width={46} height={2} fill={WOOD.hi} />
      <rect x={x + 1} y={y + 17} width={46} height={5} fill={WOOD.top} />
      <rect x={x + 1} y={y + 22} width={46} height={1} fill={WOOD.mid} />
      <rect x={x + 1} y={y + 23} width={46} height={6} fill={WOOD.front} />
      <rect x={x + 3} y={y + 24} width={18} height={4} fill={WOOD.dark} /><rect x={x + 10} y={y + 25} width={4} height={1} fill={WOOD.hi} />
      <rect x={x + 2} y={y + 29} width={2} height={5} fill={WOOD.leg} /><rect x={x + 44} y={y + 29} width={2} height={5} fill={WOOD.leg} />
      <rect x={x + 3} y={y + 34} width={45} height={2} fill="#000" opacity={0.13} />
      {/* 모니터 */}
      <rect x={x + 3} y={y + 3} width={14} height={11} fill="#1f2638" /><rect x={x + 3} y={y + 3} width={14} height={1} fill="#39445f" />
      <rect x={x + 4} y={y + 4} width={12} height={8} fill={screen} />
      {pose === 'code' && <g>{[[5, 5, '#7ee0a8'], [6, 6, '#79b8ff'], [5, 4, '#ffb070'], [7, 5, '#c8a6ff'], [5, 3, '#7ee0a8']].map(([dx, w, c], i) => <rect key={i} x={x + (dx as number)} y={y + 5 + i * 1.4} width={w as number} height={0.8} fill={c as string} />)}<rect className="ofc-anim ofc-blink" x={x + 12} y={y + 10.6} width={1.4} height={0.9} fill="#e8fff0" /></g>}
      {pose === 'doc' && <g>{[0, 1, 2, 3, 4].map((i) => <rect key={i} x={x + 5} y={y + 5 + i * 1.4} width={i % 2 ? 7 : 9} height={0.7} fill="#8a8f99" />)}</g>}
      {pose === 'plan' && <g>{[0, 1, 2].map((i) => <rect key={i} x={x + 5 + i * 3.6} y={y + 5} width={3} height={6} fill={['#f7d774', '#9ad3a8', '#9cc3f0'][i]} />)}</g>}
      {pose === 'wait' && <rect x={x + 9} y={y + 7} width={2} height={2} fill="#4a5a82" />}
      <rect x={x + 9} y={y + 14} width={2} height={1} fill="#1f2638" /><rect x={x + 7} y={y + 15} width={6} height={1} fill="#1f2638" />
      {/* 키보드·마우스 */}
      <rect x={x + 19} y={y + 18} width={13} height={3} fill="#dfe3ea" /><rect x={x + 20} y={y + 19} width={11} height={1} fill="#b9c0cc" /><rect x={x + 19} y={y + 21} width={13} height={1} fill="#9aa1ad" />
      <rect x={x + 34} y={y + 19} width={2} height={2} fill="#dfe3ea" />
      {/* 소품·스탠드·머그 */}
      <DeskProp prop={p.prop} x={x + 30} y={y + 8} />
      {pose === 'wait' && <g><rect x={x + 26} y={y + 15} width={3} height={3} fill="#f1efe8" /><rect x={x + 29} y={y + 16} width={1} height={1} fill="#f1efe8" /></g>}
      {pose === 'doc' && <g><rect x={x + 22} y={y + 16} width={8} height={5} fill="#fbf6ea" /><rect x={x + 23} y={y + 17} width={5} height={1} fill="#9aa1ad" /><rect className="ofc-anim ofc-pen" x={x + 27} y={y + 14} width={1} height={4} fill="#3d6fb0" /></g>}
      <rect x={x + 42} y={y + 6} width={1} height={10} fill="#5a4a3a" /><rect x={x + 38} y={y + 4} width={8} height={3} fill="#e0a43c" /><rect x={x + 38} y={y + 4} width={8} height={1} fill="#f2c26b" /><rect x={x + 40} y={y + 15} width={5} height={1} fill="#5a4a3a" />
    </g>
  );
}

/** 사무실 그림. occupied: 책상에 앉아 있는 직원 key */
export function Scene({ people, staff, layout, placed, mood, selected }: { people: Person[]; staff: Person[]; layout: Layout; placed: Placed[]; mood: Mood; selected: string | null }) {
  const { H, loungeY: L } = layout;
  const tr = { transition: 'fill 1.6s ease, opacity 1.6s ease, stop-color 1.6s ease' };
  const deskPlaced = new Map(placed.filter((x) => x.zone === 'desk').map((x) => [x.p.key, x]));
  const off = people.filter((p) => p.state === 'off');
  const roomBottom = L - 4;
  const sunWins = [[44, 40], [150, 40]] as const;
  return (
    <svg className="ofc-scene" viewBox={`0 0 ${W} ${H}`} shapeRendering="crispEdges" role="img" aria-label="사무실: 직원들의 위치와 현재 상태">
      <defs>
        {['a', 'b', 'c'].map((id) => (
          <linearGradient key={id} id={`sky-${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" style={{ stopColor: mood.skyTop, ...tr }} /><stop offset="100%" style={{ stopColor: mood.skyBottom, ...tr }} /></linearGradient>
        ))}
        <radialGradient id="glow-lamp"><stop offset="0%" stopColor="#ffd38a" stopOpacity={0.85} /><stop offset="100%" stopColor="#ffd38a" stopOpacity={0} /></radialGradient>
        <radialGradient id="glow-screen"><stop offset="0%" stopColor="#a6e8ff" stopOpacity={0.7} /><stop offset="100%" stopColor="#a6e8ff" stopOpacity={0} /></radialGradient>
      </defs>
      <style>{`.ofc-city{fill:${mood.city};transition:fill 1.6s ease}.ofc-citylights{opacity:${mood.cityLights};transition:opacity 1.6s ease}`}</style>
      {/* 바닥·벽(시간대 분위기는 여기에만) */}
      <Floor H={H} />
      <rect x={DIV_X} y={WALL} width={W - DIV_X} height={roomBottom - WALL} fill="#d7ddd6" />
      {Array.from({ length: Math.ceil((roomBottom - WALL) / 8) }, (_, i) => <rect key={i} x={DIV_X} y={WALL + i * 8} width={W - DIV_X} height={1} fill="#c9d0c8" />)}
      <rect x={0} y={L} width={W} height={H - L} fill="#d9ab7a" />
      {Array.from({ length: Math.ceil((H - L) / 6) }, (_, i) => <rect key={i} x={0} y={L + i * 6 + 5} width={W} height={1} fill="#c99a6a" />)}
      <rect x={0} y={0} width={W} height={WALL} fill="#f1e8d3" />
      <rect x={0} y={0} width={W} height={2} fill="#dccfb1" />
      <rect x={0} y={WALL - 4} width={W} height={4} fill={WOOD.front} /><rect x={0} y={WALL - 4} width={W} height={1} fill={WOOD.hi} />
      <rect x={0} y={WALL} width={W} height={2} fill="#000" opacity={0.08} />
      {/* 햇빛: 창에서 바닥으로(기울기·세기는 시간대) */}
      <g style={{ opacity: mood.sunOpacity * 0.8, ...tr }} pointerEvents="none">
        {sunWins.map(([wx, ww], i) => <polygon key={i} points={`${wx + mood.sunShift * 0.2},${WALL} ${wx + ww + mood.sunShift * 0.2},${WALL} ${wx + ww + mood.sunShift},${WALL + 40} ${wx + mood.sunShift},${WALL + 40}`} style={{ fill: mood.sunLight, ...tr }} />)}
        <polygon points={`${262 + mood.sunShift * 0.2},${WALL} ${306 + mood.sunShift * 0.2},${WALL} ${306 + mood.sunShift * 0.6},${WALL + 24} ${262 + mood.sunShift * 0.6},${WALL + 24}`} style={{ fill: mood.sunLight, ...tr }} />
      </g>
      <rect x={0} y={0} width={W} height={H} style={{ fill: mood.ambient, opacity: mood.ambientOpacity * 0.55, ...tr }} pointerEvents="none" />
      {/* 윗벽: 책장·창·화이트보드·액자·걸이 화분 */}
      <Bookshelf x={4} y={4} w={36} />
      <Window x={46} w={40} id="a" />
      <Hanging x={91} />
      <Bookshelf x={106} y={4} w={38} />
      <Window x={150} w={40} id="b" />
      <rect x={193} y={8} width={9} height={11} fill="#c9a26b" /><rect x={194} y={9} width={7} height={9} fill="#9fd3c2" /><rect x={195} y={14} width={5} height={3} fill="#2f8a63" />
      <rect x={214} y={5} width={42} height={21} fill="#9aa1ad" /><rect x={215} y={6} width={40} height={19} fill="#fbfbf8" />
      {[[217, 8, '#f7d774'], [223, 8, '#9ad3a8'], [229, 9, '#f3a6b8'], [217, 15, '#9cc3f0'], [247, 8, '#f7d774']].map(([sx, sy, c], i) => <rect key={i} x={sx as number} y={sy as number} width={5} height={5} fill={c as string} />)}
      <rect x={236} y={10} width={9} height={1} fill="#3d6fb0" /><rect x={236} y={13} width={13} height={1} fill="#3d6fb0" /><rect x={236} y={16} width={7} height={1} fill="#c2413b" /><rect x={236} y={19} width={10} height={1} fill="#3d6fb0" />
      <rect x={214} y={26} width={42} height={2} fill="#7a8190" />
      <Window x={262} w={46} id="c" />
      {/* 업무 공간 왼쪽·오른쪽 끝 화분 */}
      <Plant x={186} y={WALL + 6} big />
      {/* 책상(직원 한 명당 하나, 휴가 직원 제외) */}
      {staff.map((p, i) => { const d = deskAt(i); const at = deskPlaced.get(p.key); return <Desk key={p.key} x={d.x} y={d.y} p={p} occupied={!!at} pose={at ? p.pose : null} />; })}
      {/* 리뷰룸: 유리 벽·탁자·의자·검토 자료 */}
      <rect x={DIV_X} y={WALL} width={3} height={roomBottom - WALL} fill="#c6e0ea" opacity={0.85} /><rect x={DIV_X + 1} y={WALL} width={1} height={roomBottom - WALL} fill="#ffffff" opacity={0.75} />
      {[0, 1, 2].map((i) => <g key={i}><rect x={ROOM_X + 2} y={46 + i * 24} width={10} height={14} fill="#34406a" /><rect x={ROOM_X + 70} y={46 + i * 24} width={10} height={14} fill="#34406a" /></g>)}
      <rect x={232} y={54} width={50} height={2} fill={WOOD.hi} /><rect x={232} y={56} width={50} height={48} fill={WOOD.top} /><rect x={232} y={104} width={50} height={4} fill={WOOD.front} /><rect x={234} y={108} width={47} height={2} fill="#000" opacity={0.13} />
      {[[238, 62], [258, 74], [240, 88]].map(([px, py], i) => <g key={i}><rect x={px} y={py} width={12} height={9} fill="#fbf6ea" /><rect x={px + 1} y={py + 2} width={8} height={1} fill="#9aa1ad" /><rect x={px + 1} y={py + 4} width={6} height={1} fill="#9aa1ad" /><rect x={px + 1} y={py + 6} width={7} height={1} fill="#9aa1ad" /></g>)}
      {placed.some((x) => x.zone === 'review' && x.p.pose === 'reviewed') && <rect className="ofc-anim ofc-mark" x={240} y={66} width={6} height={1} fill="#c2413b" />}
      {placed.some((x) => x.zone === 'review' && x.p.external) && <g><rect x={266} y={60} width={12} height={8} fill="#2b3350" /><rect x={267} y={61} width={10} height={6} fill="#7fd0c8" /><rect x={265} y={68} width={14} height={1} fill="#8a8f99" /></g>}
      <rect x={270} y={92} width={4} height={4} fill="#f1efe8" /><rect x={274} y={93} width={1} height={1} fill="#f1efe8" />
      <Plant x={300} y={roomBottom - 24} big />
      <rect x={DIV_X} y={roomBottom} width={W - DIV_X} height={3} fill="#c6e0ea" opacity={0.85} />
      {/* 라운지: 칸막이 화분·러그·소파 두 개·안락의자·커피 바·스탠드·휴가 게시판 */}
      <rect x={0} y={L - 2} width={DIV_X} height={2} fill="#b98654" />
      <rect x={14} y={L + 30} width={150} height={24} fill="#7f9e99" /><rect x={16} y={L + 32} width={146} height={20} fill="none" stroke="#a8c2bd" strokeWidth={1} />
      {[[18, 'a'], [98, 'b']].map(([sx]) => (
        <g key={sx as number}>
          <rect x={(sx as number) + 2} y={L + 6} width={64} height={10} fill="#2e6b6e" /><rect x={(sx as number) + 2} y={L + 6} width={64} height={2} fill="#3f8a8d" />
          <rect x={(sx as number) + 2} y={L + 22} width={64} height={7} fill="#3b8285" /><rect x={sx as number} y={L + 10} width={4} height={19} fill="#2e6b6e" /><rect x={(sx as number) + 64} y={L + 10} width={4} height={19} fill="#2e6b6e" />
          <rect x={(sx as number) + 3} y={L + 29} width={62} height={2} fill="#000" opacity={0.15} />
        </g>
      ))}
      <rect x={60} y={L + 38} width={30} height={7} fill={WOOD.top} /><rect x={60} y={L + 38} width={30} height={1} fill={WOOD.hi} /><rect x={62} y={L + 45} width={26} height={2} fill={WOOD.front} />
      <rect x={66} y={L + 36} width={6} height={3} fill="#fbf6ea" /><rect x={78} y={L + 36} width={3} height={3} fill="#f1efe8" />
      {[168, 188].map((ax) => <g key={ax}><rect x={ax} y={L + 14} width={22} height={6} fill="#c8643c" /><rect x={ax} y={L + 20} width={22} height={10} fill="#d97a50" /><rect x={ax - 1} y={L + 18} width={3} height={12} fill="#b4552f" /><rect x={ax + 20} y={L + 18} width={3} height={12} fill="#b4552f" /></g>)}
      <rect x={222} y={L + 4} width={68} height={6} fill={WOOD.top} /><rect x={222} y={L + 4} width={68} height={1} fill={WOOD.hi} /><rect x={222} y={L + 10} width={68} height={16} fill={WOOD.front} />
      {[228, 246, 264].map((bx) => <rect key={bx} x={bx + 6} y={L + 26} width={4} height={8} fill="#5a4a3a" />)}
      <rect x={292} y={L} width={24} height={24} fill="#3b3f4a" /><rect x={295} y={L + 3} width={8} height={6} fill="#22262e" /><rect x={296} y={L + 4} width={3} height={2} fill="#e05b4b" /><rect x={306} y={L + 4} width={7} height={10} fill="#d6dbe3" /><rect x={296} y={L + 14} width={5} height={4} fill="#f1efe8" />
      <rect x={292} y={L + 24} width={24} height={4} fill={WOOD.front} />
      <rect x={6} y={L + 4} width={1} height={26} fill="#5a4a3a" /><rect x={2} y={L} width={9} height={5} fill="#f2d39a" /><rect x={3} y={L + 30} width={7} height={2} fill="#5a4a3a" />
      <Plant x={300} y={L + 34} big />
      <rect x={224} y={L + 34} width={64} height={24} fill="#b98654" /><rect x={226} y={L + 36} width={60} height={20} fill="#e2c08e" />
      {off.slice(0, 6).map((p, i) => (
        <g key={p.key} transform={`translate(${228 + (i % 3) * 19} ${L + 37 + Math.floor(i / 3) * 10})`}><rect x={0} y={0} width={15} height={9} fill="#fbf6ea" /><g transform="translate(1.5 0.5) scale(0.48)"><CharG def={p.char} pose="rest" x={0} y={0} /></g></g>
      ))}
      {/* 인물(책상·리뷰룸·라운지) */}
      {placed.map(({ p, x, y, pose, zone }) => (
        <g key={p.key}>
          {pose === 'type'
            ? <g><CharG def={p.char} pose="type" frame={0} x={x} y={y} className="ofc-fa" /><CharG def={p.char} pose="type" frame={1} x={x} y={y} className="ofc-fb" /></g>
            : <CharG def={p.char} pose={pose} x={x} y={y} className={zone === 'desk' && p.pose === 'wait' ? 'ofc-anim ofc-breathe' : undefined} />}
        </g>
      ))}
      {/* 책상 앞 상판을 사람 위에 다시 그려 앉은 모습이 책상 뒤에 있게 */}
      {staff.map((p, i) => { const d = deskAt(i); return deskPlaced.has(p.key) ? <g key={`f${p.key}`}><rect x={d.x + 15} y={d.y + 15} width={22} height={2} fill={WOOD.hi} /><rect x={d.x + 15} y={d.y + 17} width={22} height={5} fill={WOOD.top} /><rect x={d.x + 19} y={d.y + 18} width={13} height={3} fill="#dfe3ea" /><rect x={d.x + 20} y={d.y + 19} width={11} height={1} fill="#b9c0cc" /></g> : null; })}
      {/* 선택 표시 */}
      {placed.filter((x) => x.p.key === selected).map(({ x, y, w, h }) => <rect key="sel" className="ofc-sel" x={x - 1.5} y={y - 1.5} width={w + 3} height={h + 3} fill="none" stroke="#14b8a6" strokeWidth={1} />)}
      {/* 조명: 스탠드·모니터·플로어 램프(저녁·밤에 은은하게) */}
      <g style={{ opacity: mood.lamp, ...tr }} pointerEvents="none">
        {staff.map((p, i) => { const d = deskAt(i); return <g key={p.key}><circle cx={d.x + 42} cy={d.y + 10} r={11} fill="url(#glow-lamp)" opacity={0.5} />{deskPlaced.has(p.key) && <circle cx={d.x + 10} cy={d.y + 8} r={10} fill="url(#glow-screen)" opacity={0.3} />}</g>; })}
        <circle cx={6} cy={L + 3} r={16} fill="url(#glow-lamp)" opacity={0.55} />
        <circle cx={257} cy={78} r={26} fill="url(#glow-lamp)" opacity={0.3} />
      </g>
    </svg>
  );
}
