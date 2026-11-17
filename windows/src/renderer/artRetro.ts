// A안: 예전 픽셀 감성(작은 캐릭터 16×24칸, 단순하고 뚜렷한 실루엣, 굵은 가구). 화면에서는 정수 배율(3배 등)로만 키운다.
// B안(art.ts)과 같은 자세·작은 동작을 지원해 같은 배치로 비교할 수 있게 한다.
import type { CharDef } from './characters';
import { Grid, shade as sh, type Rect } from './pixel';
import { STANDING_POSES, type ArtMod, type ArtPose } from './art';

const OUT = '#2a2230';
const GW = 18; const GH = 26;
export const RETRO_W = GW; export const RETRO_H = GH; export const RETRO_SIT_H = 20;
function shade(hex: string, k: number) { return sh(hex, k); }
const cache = new Map<string, Rect[]>();
export function retroChar(c: CharDef, pose: ArtPose, frame = 0, mod: ArtMod = ''): Rect[] {
  const key = `${c.id}|${pose}|${frame}|${mod}`;
  const hit = cache.get(key); if (hit) return hit;
  const g: (string | null)[][] = Array.from({ length: GH }, () => Array(GW).fill(null));
  const P = (x: number, y: number, w: number, h: number, col: string) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (yy >= 0 && yy < GH && xx >= 0 && xx < GW) g[yy][xx] = col; };
  const ox = 1; const oy = 1; // 테두리 여유
  const p = (x: number, y: number, w: number, h: number, col: string) => P(x + ox, y + oy, w, h, col);
  const hair = c.hair; const hairD = shade(hair, 0.78); const top = c.top; const topD = shade(top, 0.8); const topL = shade(top, 1.12);
  const skin = c.skin; const skinD = shade(skin, 0.86);
  const seated = !STANDING_POSES.includes(pose);
  const waving = pose === 'wave' || mod === 'wave';
  // 1) 뒤로 내려오는 머리(몸 뒤)
  if (c.hairStyle === 'long' || c.hairStyle === 'wavy') { p(2, 5, 2, 10, hair); p(12, 5, 2, 10, hairD); if (c.hairStyle === 'wavy') { p(1, 8, 1, 2, hair); p(14, 10, 1, 2, hairD); p(1, 12, 1, 2, hair); } }
  if (c.hairStyle === 'ponytail') { p(12, 4, 2, 2, hairD); p(13, 6, 2, 6, hair); p(13, 12, 1, 1, hairD); }
  if (c.hairStyle === 'braid') { p(2, 5, 2, 7, hair); p(12, 5, 2, 4, hairD); for (let i = 0; i < 4; i++) p(2 + (i % 2), 12 + i * 2, 2, 2, i % 2 ? hairD : hair); }
  // 2) 몸통(옷)·팔·손
  p(4, 13, 8, 6, top); p(11, 13, 1, 6, topD); // 오른쪽이 그늘
  const armsSide = pose === 'stand' || pose === 'rest' || pose === 'wave';
  const leftDown = armsSide || pose === 'cup' || pose === 'standcup';
  if (pose === 'stretch') { p(2, 4, 1, 9, top); p(13, 4, 1, 9, topD); p(2, 3, 1, 1, skin); p(13, 3, 1, 1, skinD); }
  else {
    if (leftDown) { p(3, 13, 1, 5, top); p(3, 18, 1, 1, skin); } else p(3, 13, 1, 3, top);
    if (waving) { p(13, 8, 1, 5, topD); p(13, 6, 2, 2, skin); }
    else if (armsSide) { p(12, 13, 1, 5, topD); p(12, 18, 1, 1, skinD); }
    else p(12, 13, 1, 3, topD);
  }
  const armsSideStr = armsSide;
  switch (c.topStyle) {
    case 'jacket': p(7, 13, 2, 4, c.inner ?? '#f4f1ea'); p(6, 13, 1, 3, topL); p(9, 13, 1, 3, topD); p(5, 17, 1, 1, topD); break;
    case 'hoodie': p(5, 12, 6, 1, topD); p(6, 14, 1, 2, '#f4f1ea'); p(9, 14, 1, 2, '#f4f1ea'); p(5, 17, 6, 1, topD); break;
    case 'knit': p(6, 13, 4, 1, topL); for (let x = 4; x < 12; x += 2) { p(x, 15, 1, 1, topD); p(x + 1, 17, 1, 1, topD); } break;
    case 'shirt': p(6, 13, 1, 1, shade(top, 1.25)); p(9, 13, 1, 1, shade(top, 1.25)); p(7, 14, 1, 1, topD); p(7, 16, 1, 1, topD); break;
    case 'cardigan': p(6, 13, 4, 6, c.inner ?? '#7d5a3c'); p(6, 13, 1, 6, top); p(9, 13, 1, 6, topD); p(7, 15, 1, 1, shade(top, 0.7)); break;
    case 'vest': p(4, 13, 8, 6, c.inner ?? '#f4f1ea'); p(4, 14, 3, 5, top); p(9, 14, 3, 5, topD); p(3, 13, 1, armsSideStr ? 5 : 3, c.inner ?? '#f4f1ea'); if (!waving && pose !== 'stretch') p(12, 13, 1, armsSideStr ? 5 : 3, shade(c.inner ?? '#f4f1ea', 0.9)); break;
    case 'blouse': p(6, 13, 4, 1, '#fbf4ee'); p(7, 14, 2, 1, '#fbf4ee'); p(7, 15, 2, 1, shade(top, 0.75)); break;
  }
  // 앉은 자세의 손: 타자(두 장면)·검토(문서)·쉼(무릎 위)
  if (pose === 'sit') { p(4, 16, 2, 1, top); p(10, 16, 2, 1, topD); p(5, 17, 1, 1, skin); p(10, 17, 1, 1, skinD); }
  if (pose === 'type') { p(4, 16, 2, 1, top); p(10, 16, 2, 1, topD); p(5, frame ? 17 : 16, 1, 1, skin); p(10, frame ? 16 : 17, 1, 1, skinD); }
  if (pose === 'cup' || pose === 'standcup') { const my = mod === 'sip' ? 9 : 14; p(8, my, 3, 3, '#f4f1ea'); p(11, my + 1, 1, 1, '#f4f1ea'); p(8, my, 3, 1, '#8a5a3a'); p(9, my + 3, 2, 1, skin); }
  if (pose === 'read') { p(4, 14, 8, 5, '#3d6fb0'); p(5, 15, 3, 3, '#fbf6ea'); p(8, 15, 3, 3, '#efe6d2'); p(5, 16, 2, 1, '#b7bcc6'); p(9, 16, 2, 1, '#b7bcc6'); p(3, 16, 1, 1, skin); p(12, 16, 1, 1, skinD); }
  if (pose === 'review') { p(9, 13, 5, 6, '#fbf8f0'); p(10, 14, 3, 1, '#9aa1ad'); p(10, 16, 2, 1, '#9aa1ad'); p(12, 17, 1, 1, '#c2413b'); p(8, 16, 2, 1, skin); }
  // 3) 바지·신발(서 있을 때)
  if (!seated) { p(4, 19, 8, 3, c.pants); p(11, 19, 1, 3, shade(c.pants, 0.8)); p(7, 21, 2, 1, null as unknown as string); p(4, 22, 3, 1, '#3a2a1e'); p(9, 22, 3, 1, '#3a2a1e'); }
  // 4) 목·얼굴
  p(7, 12, 2, 1, skinD);
  p(4, 5, 8, 7, skin); p(11, 6, 1, 5, skinD); p(5, 11, 6, 1, skin);
  // 눈·입(쉬는 중이면 감은 눈)
  if (pose === 'stretch' || waving) { p(5, 8, 1, 1, OUT); p(6, 7, 1, 1, OUT); p(9, 7, 1, 1, OUT); p(10, 8, 1, 1, OUT); }
  else if (pose === 'rest' || mod === 'blink') { p(5, 8, 2, 1, OUT); p(9, 8, 2, 1, OUT); }
  else { const dx = mod === 'glanceL' ? -1 : mod === 'glanceR' ? 1 : 0; p(6 + dx, 8, 1, 1, OUT); p(9 + dx, 8, 1, 1, OUT); p(5, 9, 1, 1, shade(skin, 0.92)); p(10, 9, 1, 1, shade(skin, 0.92)); }
  if (pose === 'stretch') p(7, 10, 2, 1, '#7a2f38'); else if (waving) { p(6, 10, 4, 1, shade(skin, 0.7)); p(7, 11, 2, 1, '#7a2f38'); } else p(7, 10, 2, 1, shade(skin, 0.7));
  // 5) 앞머리·머리 모양
  const cap = () => { p(4, 2, 8, 3, hair); p(3, 3, 1, 3, hair); p(12, 3, 1, 3, hairD); p(5, 1, 6, 1, hair); p(11, 2, 1, 2, hairD); };
  switch (c.hairStyle) {
    case 'short': cap(); p(4, 5, 8, 1, hair); p(3, 6, 1, 2, hair); p(12, 6, 1, 2, hairD); break;
    case 'sidepart': cap(); p(4, 5, 5, 1, hair); p(4, 6, 2, 1, hair); p(3, 6, 1, 2, hair); p(12, 6, 1, 2, hairD); p(9, 2, 1, 1, hairD); break;
    case 'messy': cap(); p(4, 5, 8, 1, hair); p(5, 6, 1, 1, hair); p(8, 6, 1, 1, hair); p(4, 0, 1, 1, hair); p(7, 0, 1, 1, hair); p(10, 0, 1, 1, hairD); p(3, 6, 1, 2, hair); p(12, 6, 1, 2, hairD); break;
    case 'spiky': cap(); p(4, 5, 8, 1, hair); for (const x of [4, 6, 8, 10]) p(x, 0, 1, 1, x > 8 ? hairD : hair); p(3, 6, 1, 1, hair); p(12, 6, 1, 1, hairD); break;
    case 'long': case 'wavy': cap(); p(4, 5, 3, 1, hair); p(9, 5, 3, 1, hairD); p(3, 5, 1, 7, hair); p(12, 5, 1, 7, hairD); break;
    case 'ponytail': cap(); p(4, 5, 8, 1, hair); p(3, 6, 1, 2, hair); p(12, 6, 1, 1, hairD); break;
    case 'braid': cap(); p(4, 5, 4, 1, hair); p(8, 5, 4, 1, hairD); p(3, 5, 1, 6, hair); p(12, 5, 1, 3, hairD); break;
    case 'bun': cap(); p(4, 5, 8, 1, hair); p(6, -1, 4, 2, hair); p(9, -1, 1, 2, hairD); p(3, 6, 1, 2, hair); p(12, 6, 1, 2, hairD); break;
    case 'bob': cap(); p(4, 5, 8, 1, hair); p(3, 5, 1, 6, hair); p(12, 5, 1, 6, hairD); p(2, 7, 1, 4, hair); p(13, 7, 1, 4, hairD); break;
    case 'afro': p(2, 0, 12, 6, hair); p(1, 2, 1, 6, hair); p(14, 2, 1, 6, hairD); p(3, -1, 10, 1, hair); p(12, 0, 2, 6, hairD); p(2, 6, 2, 3, hair); p(12, 6, 2, 3, hairD); p(4, 5, 8, 1, hair); break;
    case 'curly': cap(); p(4, 5, 8, 1, hair); for (const x of [4, 6, 8, 10]) p(x, 1, 1, 1, hairD); p(3, 4, 1, 3, hair); p(12, 4, 1, 3, hairD); break;
    case 'curlbun': cap(); p(4, 5, 8, 1, hair); p(5, -1, 6, 3, hair); p(4, 0, 1, 2, hair); p(11, 0, 1, 2, hairD); p(6, -1, 1, 1, hairD); p(9, 0, 1, 1, hairD); p(3, 6, 1, 2, hair); p(12, 6, 1, 2, hairD); break;
    case 'bald': p(4, 3, 8, 2, skin); p(5, 2, 6, 1, skin); p(11, 3, 1, 2, skinD); p(3, 6, 1, 2, hair); p(12, 6, 1, 2, hairD); p(6, 3, 1, 1, shade(skin, 1.08)); break;
  }
  // 6) 소품
  for (const e of c.extras) {
    if (e === 'glassesRound' || e === 'glassesSquare') { const fc = e === 'glassesSquare' ? '#1a1a22' : '#5a4632'; p(5, 7, 3, 1, fc); p(8, 7, 3, 1, fc); p(5, 9, 3, 1, fc); p(8, 9, 3, 1, fc); p(5, 8, 1, 1, fc); p(7, 8, 1, 1, fc); p(8, 8, 1, 1, fc); p(10, 8, 1, 1, fc); p(6, 8, 1, 1, '#d8ecfa'); p(9, 8, 1, 1, '#d8ecfa'); }
    if (e === 'headset') { p(3, 1, 10, 1, '#2b2f38'); p(2, 2, 1, 5, '#2b2f38'); p(13, 2, 1, 5, '#2b2f38'); p(1, 6, 2, 3, '#22b3a6'); p(13, 6, 2, 3, '#1d968b'); p(11, 10, 3, 1, '#2b2f38'); }
    if (e === 'beard') { p(4, 9, 8, 3, hair); p(5, 12, 6, 1, hair); p(7, 10, 2, 1, shade(skin, 0.7)); p(11, 9, 1, 3, hairD); }
    if (e === 'mustache') { p(6, 10, 4, 1, hair); p(7, 10, 2, 1, hairD); }
    if (e === 'clip') { p(10, 4, 2, 1, '#f2c94c'); }
  }
  // 7) 바깥 테두리: 칠한 칸 옆의 빈칸
  const out: [number, number][] = [];
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) if (!g[y][x] && ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).some(([dx, dy]) => g[y + dy]?.[x + dx])) out.push([x, y]);
  for (const [x, y] of out) g[y][x] = OUT;
  // 앉은 자세는 윗몸만(책상·탁자에 가리는 아래쪽은 그리지 않음)

  const maxY = seated ? RETRO_SIT_H : GH;
  const rects: Rect[] = [];
  for (let y = 0; y < maxY; y++) { let x = 0; while (x < GW) { const col = g[y][x]; if (!col) { x++; continue; } let w = 1; while (x + w < GW && g[y][x + w] === col) w++; rects.push([x, y, w, 1, col]); x += w; } }
  cache.set(key, rects);
  return rects;
}

// ───── A안 가구(굵은 면·1칸 그늘·테두리) ─────
const RW = { hi: '#e2b07a', top: '#cf9a62', front: '#9a6538', dark: '#7a4c2a', leg: '#5e3a20' };
const fm = new Map<string, Rect[]>();
function rm(key: string, f: () => Rect[]) { const h = fm.get(key); if (h) return h; const r = f(); fm.set(key, r); return r; }
function fin(g: Grid, tags: string[]) { for (const t of tags) g.light(t, 0.8, 1.1); g.outline(OUT); return g.toRects(); }
export const RS_SEAT = 15;
export function retroSofa(seats: number, color: string, part: 'back' | 'front'): Rect[] {
  return rm(`rs|${seats}|${color}|${part}`, () => {
    const w = 6 + seats * RS_SEAT; const g = new Grid(w + 2, 21);
    if (part === 'back') { g.rect(1, 1, w, 11, color, 'b'); for (let i = 0; i < seats; i++) g.rect(4 + i * RS_SEAT, 3, RS_SEAT - 2, 6, shade(color, 1.15), 'c'); return fin(g, ['b', 'c']); }
    for (let i = 0; i < seats; i++) g.rect(3 + i * RS_SEAT, 9, RS_SEAT - 1, 5, shade(color, 1.1), 's');
    g.rect(2, 14, w - 2, 4, shade(color, 0.8), 'base'); g.rect(1, 5, 3, 13, color, 'a'); g.rect(w - 2, 5, 3, 13, color, 'a2');
    g.rect(3, 18, 2, 2, '#4a3426'); g.rect(w - 3, 18, 2, 2, '#4a3426');
    return fin(g, ['s', 'base', 'a', 'a2']);
  });
}
export function retroBean(color: string, part: 'back' | 'front'): Rect[] {
  return rm(`rb|${color}|${part}`, () => { const g = new Grid(24, 17); if (part === 'back') g.ellipse(1, 1, 22, 14, color, 'b'); else g.ellipse(1, 8, 22, 8, shade(color, 0.9), 'b'); return fin(g, ['b']); });
}
export function retroBar(): Rect[] {
  return rm('rbar', () => {
    const g = new Grid(40, 28);
    g.rect(4, 1, 10, 11, '#3b3f4a', 'm'); g.rect(6, 3, 6, 3, '#22262e'); g.rect(7, 4, 2, 1, '#e05b4b'); g.rect(7, 8, 4, 3, '#f1efe8');
    g.rect(17, 6, 6, 6, '#d6dbe3', 'j'); g.rect(26, 8, 3, 4, '#f1efe8'); g.rect(31, 8, 3, 4, '#9cc3f0');
    g.rect(1, 12, 38, 3, RW.top, 't'); g.hline(1, 12, 38, RW.hi); g.rect(2, 15, 36, 12, RW.front, 'f'); g.rect(5, 17, 12, 8, RW.dark); g.rect(21, 17, 12, 8, RW.dark);
    return fin(g, ['m', 'j', 't', 'f']);
  });
}
export function retroShelf(): Rect[] {
  return rm('rshelf', () => {
    const g = new Grid(24, 27); g.rect(1, 1, 22, 25, RW.front, 'f'); g.hline(1, 1, 22, RW.hi);
    const cols = ['#b5523b', '#3d6fb0', '#2f8a63', '#d9a03a', '#7a58b8', '#e2d6bd', '#c2547d'];
    for (const sy of [3, 14]) { g.rect(3, sy, 18, 10, '#5e3a20'); let x = 4; let i = sy; while (x < 19) { const bw = 2 + (i % 2); const bh = 7 + (i % 3); g.rect(x, sy + 10 - bh, bw, bh, cols[i % cols.length]); x += bw; i++; } }
    return fin(g, ['f']);
  });
}
export function retroPlant(): Rect[] {
  return rm('rplant', () => { const g = new Grid(16, 22); g.rect(4, 13, 8, 8, '#b4673d', 'p'); g.hline(3, 13, 10, '#cf8250'); g.rect(2, 4, 12, 9, '#2f7d55', 'l'); g.rect(4, 1, 7, 5, '#3e9a68'); g.rect(1, 7, 3, 3, '#4fb07a'); g.rect(12, 8, 3, 3, '#3e9a68'); return fin(g, ['p', 'l']); });
}
export function retroWindow(): Rect[] {
  return rm('rwin', () => { const g = new Grid(36, 26); const f = '#efe6d2'; g.rect(1, 1, 34, 2, f); g.rect(1, 21, 34, 2, f); g.rect(1, 1, 2, 22, f); g.rect(33, 1, 2, 22, f); g.rect(17, 1, 2, 22, f); g.rect(0, 23, 36, 2, '#e6d9c0'); g.outline('#8a7a62'); return g.toRects(); });
}
export function retroLamp(): Rect[] {
  return rm('rlamp', () => { const g = new Grid(10, 32); g.rect(1, 1, 8, 5, '#f2d39a', 's'); g.vline(4, 6, 23, '#4a3f36'); g.rect(2, 29, 6, 2, '#4a3f36'); return fin(g, ['s']); });
}
export function retroTable(w: number): Rect[] {
  return rm(`rt|${w}`, () => { const g = new Grid(w + 2, 14); g.rect(1, 1, w, 4, RW.top, 't'); g.hline(1, 1, w, RW.hi); g.rect(1, 5, w, 4, RW.front, 'f'); g.rect(2, 9, 2, 4, RW.leg); g.rect(w - 2, 9, 2, 4, RW.leg); return fin(g, ['t', 'f']); });
}
export function retroScreen(): Rect[] {
  return rm('rscr', () => { const g = new Grid(26, 30); g.rect(1, 1, 24, 16, '#1f2638', 'b'); g.rect(3, 3, 20, 12, '#f1ece0'); g.rect(4, 4, 8, 2, '#3d6fb0'); g.hline(4, 8, 14, '#9aa1ad'); g.hline(4, 10, 10, '#9aa1ad'); g.rect(16, 4, 5, 4, '#9ad3a8'); g.hline(16, 12, 4, '#c2413b'); g.rect(12, 17, 2, 10, '#3a4256'); g.rect(7, 27, 12, 2, '#3a4256'); return fin(g, ['b']); });
}
export function retroLaptop(): Rect[] {
  return rm('rlap', () => { const g = new Grid(12, 9); g.rect(2, 1, 8, 5, '#2b3350'); g.rect(3, 2, 6, 3, '#7fd0c8'); g.rect(1, 6, 10, 2, '#9aa1ad'); g.outline(OUT); return g.toRects(); });
}
/** 책상 한 칸(50×36): 의자 등받이(back)와 상판·모니터·키보드·스탠드(front) */
export function retroDesk(part: 'back' | 'front', screen: 'code' | 'doc' | 'plan' | 'wait' | 'off', empty: boolean): Rect[] {
  return rm(`rd|${part}|${screen}|${empty}`, () => {
    const g = new Grid(50, 38);
    if (part === 'back') { if (empty) { g.rect(22, 7, 11, 9, '#34406a', 'c'); g.rect(24, 16, 7, 2, '#2a3150'); } else g.rect(19, 3, 14, 13, '#34406a', 'c'); return fin(g, ['c']); }
    g.rect(1, 16, 46, 7, RW.top, 't'); g.hline(1, 16, 46, RW.hi); g.rect(1, 23, 46, 7, RW.front, 'f'); g.rect(3, 24, 18, 4, RW.dark); g.rect(10, 25, 4, 1, RW.hi);
    g.rect(2, 30, 2, 6, RW.leg); g.rect(44, 30, 2, 6, RW.leg);
    const sc = screen === 'code' ? '#12333d' : screen === 'doc' ? '#f1ece0' : screen === 'plan' ? '#e9eef7' : screen === 'wait' ? '#26304a' : '#1b2130';
    g.rect(3, 3, 14, 11, '#1f2638', 'm'); g.rect(4, 4, 12, 8, sc);
    if (screen === 'code') { g.hline(5, 5, 6, '#7ee0a8'); g.hline(6, 7, 7, '#79b8ff'); g.hline(5, 9, 5, '#ffb070'); }
    if (screen === 'doc') for (let i = 0; i < 3; i++) g.hline(5, 5 + i * 2, i % 2 ? 7 : 9, '#8a8f99');
    g.rect(9, 14, 2, 2, '#1f2638'); g.rect(19, 18, 13, 3, '#dfe3ea'); g.rect(34, 19, 2, 2, '#dfe3ea');
    g.vline(42, 6, 10, '#5a4a3a'); g.rect(38, 4, 8, 3, '#e0a43c', 'l');
    return fin(g, ['t', 'f', 'm', 'l']);
  });
}
/** 얼굴만(머리 위~턱, 16×13): 목록·게시판용 */
export const RHEAD_W = 16; export const RHEAD_H = 13;
export function retroHead(c: CharDef): Rect[] {
  return rm(`rhead|${c.id}`, () => retroChar(c, 'stand').filter(([, y]) => y < RHEAD_H).map(([x, y, w, h, col]) => { const x0 = Math.max(x, 1); const x1 = Math.min(x + w, 17); return [x0 - 1, y, x1 - x0, h, col] as Rect; }).filter((r) => r[2] > 0));
}
/** 화이트보드(작은 포스트잇·글줄) */
export function retroBoard(): Rect[] {
  return rm('rboard', () => { const g = new Grid(32, 20); g.rect(1, 1, 30, 16, '#9aa1ad', 'f'); g.rect(2, 2, 28, 14, '#fbfbf8'); g.rect(4, 4, 4, 4, '#f7d774'); g.rect(9, 4, 4, 4, '#9ad3a8'); g.rect(4, 9, 4, 4, '#f3a6b8'); g.hline(15, 5, 12, '#3d6fb0'); g.hline(15, 8, 9, '#c2413b'); g.hline(15, 11, 11, '#3d6fb0'); g.rect(3, 17, 26, 1, '#7a8190'); return fin(g, ['f']); });
}
export function retroClock(): Rect[] {
  return rm('rclock', () => { const g = new Grid(12, 12); g.ellipse(1, 1, 10, 10, '#3a4256'); g.ellipse(2, 2, 8, 8, '#fbfbf8'); g.vline(6, 3, 3, '#2a2129'); g.hline(6, 6, 3, '#2a2129'); g.outline(OUT); return g.toRects(); });
}
export function retroCork(n: number): Rect[] {
  return rm(`rcork|${n}`, () => { const w = 4 + Math.max(1, n) * 18; const g = new Grid(w + 2, 20); g.rect(1, 1, w, 18, '#b98654', 'f'); g.rect(2, 2, w - 2, 16, '#d9b27a'); for (let i = 0; i < Math.max(1, n); i++) g.rect(3 + i * 18, 3, 16, 14, '#fbf6ea'); return fin(g, ['f']); });
}
