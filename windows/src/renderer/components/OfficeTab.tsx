// 사무실 — 직원들의 지금 상태(일하는 중·대기 중·쉬는 중·휴가)를 휴대용 게임기 느낌의 도트 그림으로 보여 준다.
// 캐릭터·배경은 이 앱에서 새로 그린 도트 그림이다(기존 게임의 캐릭터·그림을 쓰지 않는다).
import { useEffect, useMemo, useState, type JSX } from 'react';
import type { Agent, LiveEvent, Mission, Project, WorkingItem } from '../../shared/types';
import { useLoad, ws } from '../api';
import { Banner, Loading } from './common';

// ───── 도트 그림 ─────
// 글자 하나가 한 칸. '.' 투명, k 외곽선, h 머리, s 피부, e 눈, r 입, t 윗옷, p 바지, b 신발, w 흰색
const STAND = [
  '...kkkkkk...',
  '..khhhhhhk..',
  '.khhhhhhhhk.',
  '.khsssssshk.',
  '.ksesssseks.',
  '.kssssssssk.',
  '..kssrrssk..',
  '...kkkkkk...',
  '..kttttttk..',
  '.ksttttttsk.',
  '.ksttttttsk.',
  '..kppppppk..',
  '..kppkkppk..',
  '..kbbk.kbbk.',
];
// 앉은 윗몸(책상 뒤): 머리 + 어깨까지
const SIT = STAND.slice(0, 10);
const SLEEPY = SIT.map((r, i) => (i === 4 ? '.kskksskksk.' : r)); // 감은 눈

type Palette = { h: string; s: string; t: string; p: string; acc?: Accessory };
// 직군 소품: 기본 그림 위에 겹쳐 그리는 도트(글자 하나가 한 칸, '.'은 투명)
type Accessory = { map: string[]; colors: Record<string, string>; shirt?: string };
const ACC: Record<string, Accessory> = {
  tie: { map: ['', '', '', '', '', '', '', '', '.....rr.....', '.....rr.....', '......r.....'], colors: { r: '#c0392b' } }, // 총괄: 넥타이
  glasses: { map: ['', '', '', '', '..g.gggg.g..'], colors: { g: '#1b1b24' } }, // 분석: 안경
  pencil: { map: ['', '', '..........y.', '..........y.', '..........k.'], colors: { y: '#f2c94c', k: '#1b1b24' } }, // 설계: 귀에 꽂은 연필
  headphones: { map: ['..dddddddd..', '', '', '.c........c.', '.c........c.'], colors: { d: '#2b2b3a', c: '#e0533d' } }, // 개발: 헤드폰
  beanie: { map: ['...pppppp...', '..pwpwpwpw..'], colors: { p: '#e75480', w: '#ffffff' } }, // 프런트엔드: 비니
  visor: { map: ['', '', '.vvvvvvvvvv.'], colors: { v: '#2f9e62' } }, // 데이터: 녹색 차양
  beret: { map: ['..rrrrrr....', '.rrrrrrrr...'], colors: { r: '#8e1b2a' } }, // 문서: 베레모
  cap: { map: ['..nnnnnnnn..', '.nnnnynnnnn.', '.kkkkkkkkkk.'], colors: { n: '#1f2f5a', y: '#f2c94c', k: '#1b1b24' } }, // 보안: 경비 모자
  reviewer: { map: ['', '', '', '', '..r.rrrr.r..', '', '', '', '', '........r...'], colors: { r: '#c0392b' } }, // 리뷰: 빨간 안경·빨간 펜
  lab: { map: ['', '', '', '.oooooooooo.'], colors: { o: '#5bc0be' }, shirt: '#f4f4f4' }, // 시험: 고글·실험 가운
  hardhat: { map: ['...yyyyyy...', '.yyyyyyyyyy.'], colors: { y: '#f2c94c' } }, // 통합: 안전모
};
/** 이름·역할로 직군 소품을 고른다(직접 만든 직원도 이름에 직군이 들어 있으면 같은 소품) */
function accessoryFor(a: Agent): Accessory | undefined {
  const rules: [RegExp, string][] = [
    [/총괄|오퍼레이터|팀장/, 'tie'], [/보안|권한/, 'cap'], [/코드 리뷰|독립 검토|리뷰|검수/, 'reviewer'], [/시험|품질|검증|QA/i, 'lab'],
    [/통합|결과물/, 'hardhat'], [/프런트|화면|UI/i, 'beanie'], [/백엔드|서버|작성·구현|구현|개발/, 'headphones'], [/데이터|DB/i, 'visor'],
    [/문서|작성/, 'beret'], [/설계/, 'pencil'], [/기획|요구|조사|분석|연구/, 'glasses'],
  ];
  const hit = rules.find(([re]) => re.test(a.name)) ?? rules.find(([re]) => re.test(a.role)); // 이름이 우선, 없으면 역할
  return hit ? ACC[hit[1]] : undefined;
}
const HAIR = ['#2b2b3a', '#6b3a1e', '#c0392b', '#2e7d32', '#1f4e9c', '#7b3fa0', '#d9a21b', '#9e9e9e'];
const SHIRT = ['#e0533d', '#3a7bd5', '#2f9e62', '#f2a33a', '#8e5bd1', '#d64f8a', '#1fa3a3', '#556070'];
const SKIN = ['#f5c9a0', '#e8b088', '#c98d60'];
const PANTS = ['#2e3a59', '#3b3b3b', '#5a4632', '#24507a'];

function hashOf(s: string) { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
function paletteFor(a: Agent): Palette {
  const n = hashOf(`${a.code}:${a.name}`);
  const acc = accessoryFor(a);
  return { h: HAIR[n % HAIR.length], t: acc?.shirt ?? SHIRT[(n >>> 3) % SHIRT.length], s: SKIN[(n >>> 6) % SKIN.length], p: PANTS[(n >>> 8) % PANTS.length], acc };
}

function Pixels({ map, pal, x = 0, y = 0 }: { map: string[]; pal: Palette; x?: number; y?: number }) {
  const color: Record<string, string> = { k: '#1b1b24', h: pal.h, s: pal.s, e: '#1b1b24', r: '#c0504d', t: pal.t, p: pal.p, b: '#3a2a1a', w: '#ffffff' };
  const rects: JSX.Element[] = [];
  map.forEach((row, yy) => [...row].forEach((ch, xx) => {
    const c = color[ch];
    if (c) rects.push(<rect key={`${xx}-${yy}`} x={x + xx} y={y + yy} width={1} height={1} fill={c} />);
  }));
  // 직군 소품: 그림 높이만큼만 겹친다(앉은 그림이면 아래쪽 소품은 책상에 가려 그리지 않음). 선글라스(휴가) 줄은 덮지 않는다
  const sun = map[4] === '.kkkkskkkks.';
  pal.acc?.map.slice(0, map.length).forEach((row, yy) => [...row].forEach((ch, xx) => {
    const c = pal.acc!.colors[ch];
    if (c && !(sun && yy === 4)) rects.push(<rect key={`a${xx}-${yy}`} x={x + xx} y={y + yy} width={1} height={1} fill={c} />);
  }));
  return <g>{rects}</g>;
}

type State = 'work' | 'reviewed' | 'wait' | 'rest' | 'off';
type Pose = 'code' | 'doc' | 'review' | 'plan' | 'reviewed' | 'wait' | 'rest' | 'off';

const INK = '#1b1b24';
function Desk() {
  return (
    <g>
      <rect x={2} y={12} width={21} height={2} fill="#8a5a2b" />
      <rect x={2} y={14} width={2} height={4} fill="#6b4320" />
      <rect x={21} y={14} width={2} height={4} fill="#6b4320" />
    </g>
  );
}
/** 두 장면을 번갈아 보여 움직임을 만든다(타자, 걸음, 펜 등) */
function Frames({ a, b }: { a: JSX.Element; b: JSX.Element }) {
  return (<g><g className="frame-a">{a}</g><g className="frame-b">{b}</g></g>);
}
const LEGS_A = ['..kppkkppk..', '..kbbk.kbbk.'];
const LEGS_B = ['...kpkkpk...', '...kbbkbb...'];

/** 장면 하나(24×18 칸): 상태·하는 일마다 다른 자세와 소품 */
function Sprite({ pal, pose }: { pal: Palette; pose: Pose }) {
  return (
    <svg className={`sprite sprite-${pose}`} viewBox="0 0 24 18" shapeRendering="crispEdges" aria-hidden="true">
      {pose === 'code' && (
        <g>
          <Pixels map={SIT} pal={pal} x={2} y={2} />
          {/* 모니터: 코드 줄이 위로 흘러간다 */}
          <rect x={11} y={4} width={11} height={8} fill={INK} />
          <rect x={12} y={5} width={9} height={6} fill="#10202a" />
          <clipPath id="scr"><rect x={12} y={5} width={9} height={6} /></clipPath>
          <g clipPath="url(#scr)">
            <g className="code-scroll">
              {[[12, 3, '#7ee787'], [13, 5, '#79c0ff'], [12, 2, '#ffa657'], [14, 4, '#d2a8ff'], [13, 6, '#7ee787'], [12, 4, '#79c0ff'], [14, 3, '#ffa657'], [12, 5, '#d2a8ff'],
                [12, 3, '#7ee787'], [13, 5, '#79c0ff'], [12, 2, '#ffa657'], [14, 4, '#d2a8ff']].map(([x, w, c], i) => (
                <rect key={i} x={x as number} y={5.5 + i} width={w as number} height={0.6} fill={c as string} />
              ))}
            </g>
          </g>
          <Desk />
          <rect x={3} y={11} width={7} height={1} fill="#d8d8d8" />
          <Frames a={<><rect x={3} y={10} width={2} height={1} fill={pal.s} /><rect x={8} y={10} width={2} height={1} fill={pal.s} /></>}
            b={<><rect x={4} y={10} width={2} height={1} fill={pal.s} /><rect x={7} y={10} width={2} height={1} fill={pal.s} /></>} />
        </g>
      )}
      {pose === 'doc' && (
        <g>
          <Pixels map={SIT} pal={pal} x={4} y={2} />
          <Desk />
          {/* 종이에 한 줄씩 써 내려간다 */}
          <rect x={12} y={7} width={8} height={5} fill="#ffffff" stroke={INK} strokeWidth={0.3} />
          {[0, 1, 2, 3].map((i) => <rect key={i} className={`write-line write-line-${i}`} x={13} y={8 + i} width={6} height={0.5} fill="#5a5a6a" />)}
          <g className="pencil"><rect x={13} y={6} width={1} height={3} fill="#f2c94c" /><rect x={13} y={9} width={1} height={0.7} fill={INK} /></g>
          <rect x={9} y={10} width={3} height={1} fill={pal.s} />
        </g>
      )}
      {pose === 'review' && (
        <g>
          <Pixels map={SIT} pal={pal} x={2} y={2} />
          <Desk />
          {/* 문서를 들고 돋보기로 훑으며 표시한다 */}
          <rect x={10} y={3} width={10} height={9} fill="#ffffff" stroke={INK} strokeWidth={0.3} />
          {[0, 1, 2, 3, 4, 5].map((i) => <rect key={i} x={11} y={4 + i * 1.3} width={i % 2 ? 6 : 8} height={0.5} fill="#8a8a9a" />)}
          <g className="mark-1"><rect x={18} y={4} width={1} height={1} fill="#d33" /><rect x={17.5} y={4.5} width={0.6} height={0.6} fill="#d33" /></g>
          <g className="mark-2"><rect x={18} y={7} width={1} height={1} fill="#2a9d4b" /><rect x={17.5} y={7.5} width={0.6} height={0.6} fill="#2a9d4b" /></g>
          <g className="magnifier">
            <circle cx={12} cy={6} r={1.6} fill="rgba(160,210,255,0.5)" stroke={INK} strokeWidth={0.5} />
            <rect x={13} y={7.2} width={0.8} height={2} fill="#6b4320" transform="rotate(-40 13 7.2)" />
          </g>
          <rect x={8} y={8} width={2} height={1} fill={pal.s} />
        </g>
      )}
      {pose === 'plan' && (
        <g className="walk">
          <g className="walk-flip">
            <Pixels map={STAND.slice(0, 12)} pal={pal} x={6} y={2} />
            <Frames a={<Pixels map={LEGS_A} pal={pal} x={6} y={14} />} b={<Pixels map={LEGS_B} pal={pal} x={6} y={14} />} />
            {/* 클립보드 */}
            <rect x={15} y={9} width={3} height={4} fill="#c9a26b" stroke={INK} strokeWidth={0.3} />
            <rect x={15.5} y={10} width={2} height={0.4} fill={INK} /><rect x={15.5} y={11} width={2} height={0.4} fill={INK} />
          </g>
        </g>
      )}
      {pose === 'reviewed' && (
        <g>
          <Pixels map={STAND} pal={pal} x={1} y={3} />
          <rect className="sweat" x={10} y={4} width={1} height={2} fill="#5bb4ff" />
          {/* 내 결과물에 빨간 펜 표시가 하나씩 붙는다 */}
          <rect x={13} y={2} width={10} height={12} fill="#ffffff" stroke={INK} strokeWidth={0.4} />
          {[0, 1, 2, 3, 4, 5, 6].map((i) => <rect key={i} x={14} y={3.5 + i * 1.4} width={i % 3 ? 7 : 5} height={0.5} fill="#8a8a9a" />)}
          <rect className="red-1" x={20} y={4.5} width={2} height={0.6} fill="#d33" />
          <rect className="red-2" x={14} y={8.6} width={7} height={0.4} fill="#d33" />
          <g className="red-3"><rect x={20} y={11} width={1} height={1} fill="#2a9d4b" /><rect x={19.4} y={11.5} width={0.7} height={0.7} fill="#2a9d4b" /></g>
          <rect x={18} y={14} width={1} height={4} fill="#6b4320" />
        </g>
      )}
      {pose === 'rest' && (
        <g>
          <Pixels map={SLEEPY} pal={pal} x={4} y={4} />
          <rect x={3} y={14} width={12} height={2} fill="#6b4320" />
          <rect x={4} y={16} width={2} height={2} fill="#6b4320" />
          <rect x={12} y={16} width={2} height={2} fill="#6b4320" />
          <rect x={17} y={11} width={3} height={3} fill="#ffffff" stroke={INK} strokeWidth={0.3} />
          <rect x={20} y={12} width={1} height={1} fill={INK} />
          <g className="steam"><rect x={18} y={8} width={0.6} height={2} fill="#bbb" /><rect x={19} y={7} width={0.6} height={2} fill="#bbb" /></g>
          <g className="zzz"><text x={16} y={6} fontSize={4} fill={INK} fontFamily="monospace">z</text><text x={19} y={3.5} fontSize={3} fill={INK} fontFamily="monospace">z</text></g>
        </g>
      )}
      {pose === 'wait' && (
        <g className="bob">
          <Pixels map={STAND} pal={pal} x={6} y={3} />
          <g className="dots"><rect x={18} y={3} width={1} height={1} fill={INK} /><rect x={20} y={3} width={1} height={1} fill={INK} /><rect x={22} y={3} width={1} height={1} fill={INK} /></g>
        </g>
      )}
      {pose === 'off' && (
        <g>
          {/* 휴가: 파라솔 아래 선글라스, 여행 가방 */}
          <rect x={0} y={15} width={24} height={3} fill="#f3d98b" />
          <rect x={3} y={1} width={10} height={1} fill="#e0533d" />
          <rect x={2} y={2} width={12} height={1} fill="#ffffff" />
          <rect x={1} y={3} width={14} height={1} fill="#e0533d" />
          <rect x={8} y={4} width={1} height={11} fill="#6b4320" />
          <Pixels map={STAND.map((r, i) => (i === 4 ? '.kkkkskkkks.' : r))} pal={pal} x={10} y={2} />
          <rect x={20} y={11} width={4} height={4} fill="#2f9e62" />
          <rect x={21} y={10} width={2} height={1} fill={INK} />
        </g>
      )}
    </svg>
  );
}

const STATE_LABEL: Record<State, string> = { work: '일하는 중', reviewed: '리뷰 받는 중', wait: '대기 중', rest: '쉬는 중', off: '휴가 중' };
const KIND_LABEL: Record<WorkingItem['kind'], string> = { author: '작성', reviewer: '검토', codex: 'Codex 리뷰', check: '검사', operator: '계획·판단' };
const RECEIVE_LABEL: Record<WorkingItem['kind'], string> = { author: '작성', reviewer: '검토를 받는 중', codex: 'Codex 리뷰를 받는 중', check: '자동 검사를 받는 중', operator: '' };
const ACTIVE: Mission['status'][] = ['planning', 'running', 'evaluating'];
const CODEX_PAL: Palette = { h: '#6e56cf', s: '#f5c9a0', t: '#2b2b3a', p: '#3b3b3b' };

// ───── 사무실 지도(위에서 본 모습) ─────
// 업무 공간(책상): 작성 중이면 자기 책상에 앉아 있고, 대기 중이면 책상 옆에 서 있다. 총괄은 계획·판단 중에 통로를 돌아다닌다.
// 회의실: 검토하는 직원·리뷰 받는 직원·Codex(외부 검토자)가 둘러앉는다. 휴게실: 쉬는 직원. 아래 해변: 휴가 중인 직원.
const SUN = (map: string[]) => map.map((r, i) => (i === 4 ? '.kkkkskkkks.' : r));
const PS = 1.3; // 지도 속 인물 확대 배율
const COLS = 4; const CELL_W = 48; const CELL_H = 46; const TOP = 26; const WORK_W = 198; const W = 330;

function Bubble({ x, y, text, color = '#ffffff' }: { x: number; y: number; text: string; color?: string }) {
  return (
    <g className="bubble">
      <rect x={x} y={y} width={text.length * 4 + 3} height={7} rx={1} fill={color} stroke={INK} strokeWidth={0.5} />
      <text x={x + 1.6} y={y + 5.4} fontSize={5} fill={INK} fontFamily="monospace" fontWeight={700}>{text}</text>
    </g>
  );
}
function Plant({ x, y }: { x: number; y: number }) {
  return (<g><rect x={x + 2} y={y + 7} width={6} height={5} fill="#b5651d" /><rect x={x} y={y} width={10} height={8} fill="#2f9e62" /><rect x={x + 2} y={y - 3} width={6} height={4} fill="#3fbf76" /></g>);
}
function Shelf({ x, y, w }: { x: number; y: number; w: number }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={14} fill="#c89b5e" stroke={INK} strokeWidth={0.5} />
      <rect x={x + 2} y={y + 2} width={w - 4} height={4} fill="#7a5530" />
      <rect x={x + 2} y={y + 8} width={w - 4} height={4} fill="#7a5530" />
      {Array.from({ length: Math.floor((w - 4) / 3) }, (_, i) => <rect key={i} x={x + 2.5 + i * 3} y={y + (i % 2 ? 2.5 : 8.5)} width={1.6} height={3} fill={['#d33', '#3a7bd5', '#2f9e62', '#f2a33a'][i % 4]} />)}
    </g>
  );
}
function NameTag({ x, y, code, name, dim }: { x: number; y: number; code: string; name: string; dim?: boolean }) {
  const label = `${code} ${name}`.slice(0, 11);
  return <text x={x} y={y} fontSize={4.6} textAnchor="middle" fill={dim ? '#666' : INK} fontFamily="monospace" fontWeight={700}>{label}</text>;
}

type MapRow = { key: string; code: string; name: string; title: string; pal: Palette; state: State; pose: Pose; note: string; desk: number | null };

function Person({ r, x, y, sit, sleepy, sun, children }: { r: MapRow; x: number; y: number; sit?: boolean; sleepy?: boolean; sun?: boolean; children?: JSX.Element | null }) {
  const map = sit ? (sleepy ? SLEEPY : SIT) : sun ? SUN(STAND) : STAND;
  return (
    <g className={`person person-${r.pose}`}>
      <title>{`${r.title}\n${r.note}`}</title>
      <g transform={`translate(${x} ${y}) scale(${PS})`}><Pixels map={map} pal={r.pal} /></g>
      {children}
    </g>
  );
}

function OfficeMap({ rows }: { rows: MapRow[] }) {
  const staff = rows.filter((r) => r.desk !== null);
  const deskRows = Math.max(2, Math.ceil(staff.length / COLS));
  const workH = TOP + deskRows * CELL_H;
  const H = Math.max(workH, 206) + 40;
  const beachY = H - 40;
  const deskPos = (i: number) => ({ x: 10 + (i % COLS) * CELL_W, y: TOP + Math.floor(i / COLS) * CELL_H });
  const meeting = rows.filter((r) => r.pose === 'review' || r.pose === 'reviewed');
  const resting = rows.filter((r) => r.state === 'rest');
  const vacation = rows.filter((r) => r.state === 'off');
  // 회의실 자리: 탁자 왼쪽·오른쪽·위·아래
  const MEET_Y = 104;
  // 리뷰 받는 직원은 탁자 왼쪽, 검토하는 쪽(직원·Codex)은 오른쪽에 마주 앉는다
  const leftSeats = [[218, MEET_Y + 16], [218, MEET_Y + 44], [218, MEET_Y + 72]];
  const rightSeats = [[298, MEET_Y + 16], [298, MEET_Y + 44], [298, MEET_Y + 72]];
  const lounge = [[258, 40], [276, 40], [294, 40], [208, 28], [226, 34], [244, 26], [310, 24], [208, 58], [226, 64], [244, 58], [312, 60], [292, 66]];
  return (
    <svg className="office-map" viewBox={`0 0 ${W} ${H}`} shapeRendering="crispEdges" role="img" aria-label="사무실 지도: 직원들의 현재 위치와 상태">
      {/* 바닥 */}
      <rect x={0} y={0} width={W} height={H} fill="#22284a" />
      <rect x={0} y={18} width={WORK_W} height={beachY - 18} fill="#b07a45" />
      {Array.from({ length: Math.ceil((beachY - 18) / 8) }, (_, i) => <rect key={`fl${i}`} x={0} y={18 + i * 8} width={WORK_W} height={0.5} fill="#9c6a3a" />)}
      <rect x={WORK_W + 4} y={18} width={W - WORK_W - 4} height={70} fill="#ece6da" />
      {Array.from({ length: 8 }, (_, i) => <rect key={`tl${i}`} x={WORK_W + 4 + i * 16} y={18} width={0.5} height={70} fill="#d6cfc0" />)}
      <rect x={WORK_W + 4} y={92} width={W - WORK_W - 4} height={beachY - 92} fill="#3f6fb0" />
      {/* 벽·가구 */}
      <Shelf x={8} y={3} w={40} /><Shelf x={52} y={3} w={40} /><Shelf x={110} y={3} w={40} /><Shelf x={154} y={3} w={38} />
      <text x={6} y={beachY - 4} fontSize={5} fill="#f8f0e0" fontFamily="monospace" fontWeight={700}>업무 공간</text>
      {/* 휴게실: 자판기·정수기·소파·시계 */}
      <rect x={206} y={4} width={16} height={24} fill="#dfe8f3" stroke={INK} strokeWidth={0.6} />
      {[0, 1, 2].map((i) => <rect key={i} x={208} y={7 + i * 6} width={8} height={4} fill={['#d33', '#2f9e62', '#3a7bd5'][i]} />)}
      <rect x={226} y={10} width={9} height={18} fill="#f4f4f4" stroke={INK} strokeWidth={0.6} /><rect x={227} y={4} width={7} height={7} fill="#9fd3ff" stroke={INK} strokeWidth={0.5} />
      <circle cx={300} cy={8} r={4} fill="#fff" stroke={INK} strokeWidth={0.6} /><rect x={299.6} y={5} width={0.8} height={3.4} fill={INK} /><rect x={300} y={8} width={2.4} height={0.8} fill={INK} />
      <rect x={256} y={56} width={54} height={12} fill="#c0504d" stroke={INK} strokeWidth={0.6} /><rect x={256} y={52} width={54} height={5} fill="#a33f3c" />
      <text x={206} y={86} fontSize={5} fill={INK} fontFamily="monospace" fontWeight={700}>휴게실</text>
      {/* 회의실: 액자·탁자 */}
      <rect x={236} y={92} width={36} height={8} fill="#c89b5e" stroke={INK} strokeWidth={0.5} /><rect x={238} y={94} width={32} height={4} fill="#9fd3ff" /><rect x={240} y={96} width={10} height={2} fill="#2f9e62" /><circle cx={265} cy={95.5} r={1.4} fill="#f2c94c" />
      <rect x={236} y={MEET_Y + 14} width={58} height={70} fill="#c89b5e" stroke={INK} strokeWidth={0.6} />
      {[0, 1, 2].map((k) => (
        <g key={k}>
          <rect x={242} y={MEET_Y + 20 + k * 28} width={12} height={9} fill="#ffffff" stroke={INK} strokeWidth={0.4} />
          {[0, 1, 2].map((i) => <rect key={i} x={243.5} y={MEET_Y + 22 + k * 28 + i * 2.2} width={8} height={0.6} fill="#888" />)}
          {meeting.some((r) => r.pose === 'reviewed') && k === 0 && <rect className="redline" x={243.5} y={MEET_Y + 24.2} width={8} height={0.6} fill="#d33" />}
        </g>
      ))}
      <rect x={272} y={MEET_Y + 24} width={12} height={8} fill="#cfd6e0" stroke={INK} strokeWidth={0.4} />
      <Plant x={308} y={100} /><Plant x={206} y={100} />
      <text x={206} y={beachY - 4} fontSize={5} fill="#f8f0e0" fontFamily="monospace" fontWeight={700}>회의실 · 리뷰</text>
      {/* 해변(휴가) */}
      <rect x={0} y={beachY} width={W} height={10} fill="#5bb4ff" />
      <rect x={0} y={beachY + 10} width={W} height={30} fill="#f3d98b" />
      <rect x={4} y={beachY + 12} width={30} height={2} fill="#e0533d" /><rect x={18} y={beachY + 14} width={1} height={18} fill="#6b4320" />
      <text x={40} y={beachY + 7} fontSize={5} fill="#ffffff" fontFamily="monospace" fontWeight={700}>휴가</text>

      {/* 책상과 직원 */}
      {staff.map((r, i) => {
        const { x, y } = deskPos(i);
        const atDesk = r.pose === 'code' || r.pose === 'doc';
        return (
          <g key={r.key}>
            <rect x={x + 8} y={y - 2} width={12} height={8} fill="#6b4320" />
            {atDesk && (
              <Person r={r} x={x + 6} y={y - 4}>
                <>
                  {r.pose === 'code' && <Bubble x={x + 22} y={y - 10} text="</>" color="#e8ffe8" />}
                  {r.pose === 'doc' && <Bubble x={x + 22} y={y - 10} text="✎" color="#fff8d6" />}
                </>
              </Person>
            )}
            <rect x={x} y={y + 9} width={28} height={11} fill="#8a5a2b" stroke={INK} strokeWidth={0.5} />
            <rect x={x + 1} y={y + 20} width={2} height={3} fill="#5a3a1a" /><rect x={x + 25} y={y + 20} width={2} height={3} fill="#5a3a1a" />
            {/* 노트북·서류 */}
            <rect x={x + 9} y={y + 11} width={10} height={6} fill={atDesk && r.pose === 'code' ? '#2b2b3a' : '#9aa3ad'} stroke={INK} strokeWidth={0.4} />
            {atDesk && r.pose === 'code' && <rect className="led" x={x + 13.5} y={y + 13.5} width={1} height={1} fill="#7ee787" />}
            {atDesk && r.pose === 'doc' && <g><rect x={x + 20} y={y + 10} width={6} height={8} fill="#fff" stroke={INK} strokeWidth={0.3} /><rect className="pen" x={x + 21} y={y + 12} width={1} height={3} fill="#f2c94c" /></g>}
            {!atDesk && <rect x={x + 2} y={y + 11} width={5} height={5} fill="#fff" stroke={INK} strokeWidth={0.3} />}
            {r.pose === 'wait' && (
              <Person r={r} x={x + 30} y={y + 2}>
                <Bubble x={x + 32} y={y - 6} text="..." />
              </Person>
            )}
            <NameTag x={x + 14} y={y + 31} code={r.code} name={r.name} dim={!atDesk && r.pose !== 'wait'} />
          </g>
        );
      })}
      {/* 돌아다니는 총괄 */}
      {rows.filter((r) => r.pose === 'plan').map((r, i) => (
        <g key={r.key} className="walker" style={{ ['--walk-y' as string]: `${TOP + 30 + i * CELL_H}px` }}>
          <g className="walker-flip">
            <Person r={r} x={0} y={0}>
              <><rect x={14} y={10} width={4} height={5} fill="#c9a26b" stroke={INK} strokeWidth={0.3} /><Bubble x={8} y={-8} text="계획" color="#e6f0ff" /></>
            </Person>
          </g>
        </g>
      ))}
      {/* 회의실 */}
      {[...meeting.filter((r) => r.pose === 'reviewed').slice(0, leftSeats.length).map((r, i) => ({ r, pos: leftSeats[i] })),
        ...meeting.filter((r) => r.pose === 'review').slice(0, rightSeats.length).map((r, i) => ({ r, pos: rightSeats[i] }))].map(({ r, pos: [x, y] }) => (
        <Person key={r.key} r={r} x={x} y={y} sit>
          <>
            {r.pose === 'review' && <Bubble x={x - 2} y={y - 8} text={r.code === 'CX' ? 'CX' : '검토'} color="#e6f0ff" />}
            {r.pose === 'review' && <g className="magnify-small"><circle cx={x - 3} cy={y + 8} r={2} fill="rgba(160,210,255,0.6)" stroke={INK} strokeWidth={0.6} /></g>}
            {r.pose === 'reviewed' && <><rect className="sweat" x={x + 14} y={y + 1} width={1} height={2} fill="#5bb4ff" /><Bubble x={x + 4} y={y - 8} text="!?" color="#ffe0e0" /></>}
            <NameTag x={x + 8} y={y + 20} code={r.code} name={r.name} />
          </>
        </Person>
      ))}
      {/* 휴게실 */}
      {resting.slice(0, lounge.length).map((r, i) => {
        const [x, y] = lounge[i];
        const onSofa = i < 3;
        return (
          <Person key={r.key} r={r} x={x} y={y} sit={onSofa} sleepy={onSofa}>
            {onSofa ? <g className="zzz"><text x={x + 12} y={y - 1} fontSize={5} fill={INK} fontFamily="monospace">z</text></g>
              : <><rect x={x + 15} y={y + 10} width={3} height={3} fill="#fff" stroke={INK} strokeWidth={0.3} /><rect className="steam" x={x + 16} y={y + 7} width={0.6} height={2} fill="#bbb" /></>}
          </Person>
        );
      })}
      {resting.length > lounge.length && <text x={206} y={78} fontSize={4.5} fill={INK} fontFamily="monospace">외 {resting.length - lounge.length}명</text>}
      {/* 해변 */}
      {vacation.map((r, i) => {
        const x = 44 + i * 46;
        if (x > W - 14) return null;
        return (
          <Person key={r.key} r={r} x={x} y={beachY + 11} sun>
            <NameTag x={x + 8} y={beachY + 38} code={r.code} name={r.name} />
          </Person>
        );
      })}
    </svg>
  );
}

function hhmm(iso: string) { try { return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } }

export default function OfficeTab({ project }: { project: Project }) {
  const agents = useLoad(() => ws().listAgents(project.id), [project.id]);
  const [working, setWorking] = useState<WorkingItem[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);
  useEffect(() => {
    let alive = true; let t: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      ws().workingNow(project.id).then((w) => { if (alive) setWorking(w); }).catch(() => {});
      ws().listMissions(project.id).then((m) => { if (alive) setMissions(m); }).catch(() => {});
    };
    load();
    const off = ws().onLive((e: LiveEvent) => { if (['attempt', 'run', 'mission', 'node', 'missionEvent'].includes(e.type)) { if (t) clearTimeout(t); t = setTimeout(load, 300); } });
    const iv = setInterval(load, 8000);
    return () => { alive = false; off(); clearInterval(iv); if (t) clearTimeout(t); };
  }, [project.id]);

  const live = missions.filter((m) => ACTIVE.includes(m.status));
  const limited = missions.find((m) => m.limitUntil && ['planning', 'running', 'evaluating', 'waiting_user'].includes(m.status));
  type Row = MapRow;
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = (agents.data ?? []).map((a) => {
      const jobs = working.filter((w) => w.agentId === a.id);
      const received = working.filter((w) => w.reviewOf === a.id && w.agentId !== a.id);
      let state: State; let pose: Pose; let note: string;
      if (!a.active) { state = 'off'; pose = 'off'; note = '휴가 — 업무 배정 안 함'; }
      else if (jobs.length) {
        const j = jobs[0];
        state = 'work';
        pose = j.kind === 'operator' ? 'plan' : j.kind === 'reviewer' ? 'review' : j.mode === 'doc' ? 'doc' : 'code';
        const what = j.kind === 'operator' ? '돌아다니며 계획·판단' : j.kind === 'reviewer' ? '결과물 검토' : j.mode === 'doc' ? '문서 작성' : '코딩';
        note = `${what}: ${j.task}${jobs.length > 1 ? ` 외 ${jobs.length - 1}건` : ''}`;
      } else if (received.length) { state = 'reviewed'; pose = 'reviewed'; note = `${RECEIVE_LABEL[received[0].kind]}: ${received[0].task}`; }
      else if (limited) { state = 'rest'; pose = 'rest'; note = `사용 한도 휴식${limited.limitUntil ? ` · ${hhmm(limited.limitUntil)}에 다시 시작` : ''}`; }
      else if (live.length) { state = 'wait'; pose = 'wait'; note = '진행 중인 미션에서 차례를 기다림'; }
      else { state = 'rest'; pose = 'rest'; note = '진행 중인 미션 없음'; }
      return { key: a.id, code: a.code, name: a.name, title: `${a.code} ${a.name} — ${a.role}`, pal: paletteFor(a), state, pose, note, desk: a.active ? 0 : null };
    });
    // Codex는 직원이 아니라 외부 검토자로 잠깐 들른다
    working.filter((w) => w.kind === 'codex').forEach((w, i) => out.push({ key: `codex-${i}`, code: 'CX', name: 'Codex', title: 'Codex CLI(외부 검토자)', pal: CODEX_PAL, state: 'work', pose: 'review', note: `외부 리뷰: ${w.task}`, desk: null }));
    return out;
  }, [agents.data, working, live.length, limited]);

  const count = (s: State) => rows.filter((r) => r.state === s).length;
  const order: State[] = ['work', 'reviewed', 'wait', 'rest', 'off'];

  return (
    <div className="office-wrap">
      <div className="office">
        <div className="office-panel office-head">
          <div>
            <div className="office-title">{project.plan.name}</div>
            <div className="office-sub">직원 {(agents.data ?? []).length}명 · 진행 중인 미션 {live.length}개{limited ? ' · 사용 한도 휴식 중' : ''}</div>
          </div>
          <div className="office-counts">
            {order.map((s) => (
              <span key={s} className={`office-count office-count-${s}`}>{STATE_LABEL[s]} {count(s)}</span>
            ))}
          </div>
        </div>
        {agents.loading && !agents.data && <Loading />}
        {agents.error && <Banner>{agents.error}</Banner>}
        {agents.data && rows.length === 0 && <div className="office-panel office-empty">아직 직원이 없습니다. 직원 탭에서 기본 템플릿을 불러오세요.</div>}
        {rows.length > 0 && (
          <div className="office-body">
            <div className="office-panel office-map-panel">
              <OfficeMap rows={rows} />
            </div>
            <section className="office-panel office-side">
              <div className="office-ribbon">직원별 상태</div>
              <div className="office-list">
                {order.flatMap((st) => rows.filter((r) => r.state === st)).map((r) => (
                  <div key={r.key} className={`office-row office-card-${r.state}`} title={`${r.title}\n${r.note}`}>
                    <Sprite pal={r.pal} pose={r.pose} />
                    <div className="office-row-main">
                      <div className="office-row-head"><span className="office-code">{r.code}</span><strong className="office-row-name">{r.name}</strong><span className={`office-count office-count-${r.state}`}>{STATE_LABEL[r.state]}</span></div>
                      <div className="office-row-note">{r.note}</div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
