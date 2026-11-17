// 사무실 도트 그림 자산(2단계 해상도): 캐릭터 32×46칸, 책상 한 자리 100×66칸, 창·화분·의자 등.
// 같은 화풍(바깥 테두리, 왼쪽 위 빛·오른쪽 아래 그늘, 3단 색)과 같은 비율로 그린다. 좌표·크기는 모두 정수이며
// 화면에서는 정수 배율(2배·3배)로만 키워 가장자리가 고르게 보이게 한다.
import type { CharDef } from './characters';
import { Grid, mix, shade, type Rect } from './pixel';

const INK = '#2a2129';
export type ArtPose = 'stand' | 'sit' | 'type' | 'review' | 'rest';
export const CHAR2_W = 34; export const CHAR2_H = 48; export const CHAR2_SIT_H = 37;

const cache = new Map<string, Rect[]>();
/** 캐릭터 한 장면. 원점은 그림 왼쪽 위(테두리 포함 34×48). 앉은 자세는 책상에 가리는 아래쪽을 그리지 않는다. */
export function char2(c: CharDef, pose: ArtPose, frame = 0): Rect[] {
  const key = `${c.id}|${pose}|${frame}`;
  const hit = cache.get(key); if (hit) return hit;
  const g = new Grid(CHAR2_W, CHAR2_H);
  const o = 1; // 테두리 여유
  const R = (x: number, y: number, w: number, h: number, col: string, t: string | null = null) => g.rect(x + o, y + o, w, h, col, t);
  const RR = (x: number, y: number, w: number, h: number, r: number, col: string, t: string | null = null) => g.rrect(x + o, y + o, w, h, r, col, t);
  const E = (x: number, y: number, w: number, h: number, col: string, t: string | null = null) => g.ellipse(x + o, y + o, w, h, col, t);
  const P = (x: number, y: number, col: string, t: string | null = null) => g.set(x + o, y + o, col, t);
  const skin = c.skin; const hair = c.hair; const top = c.top; const inner = c.inner ?? '#f4f1ea';
  const seated = pose !== 'stand';
  const hs = c.hairStyle;

  // 1) 몸 뒤로 내려오는 머리
  if (hs === 'long' || hs === 'wavy') { RR(5, 9, 5, 18, 2, hair, 'hair'); RR(22, 9, 5, 18, 2, hair, 'hair'); if (hs === 'wavy') { P(4, 14, hair, 'hair'); P(4, 20, hair, 'hair'); P(27, 17, hair, 'hair'); P(27, 23, hair, 'hair'); } }
  if (hs === 'ponytail') { E(22, 6, 6, 6, hair, 'hair'); RR(24, 10, 5, 13, 2, hair, 'hair'); }
  if (hs === 'braid') { for (let i = 0; i < 6; i++) E(4 + (i % 2), 14 + i * 3, 5, 4, i % 2 ? shade(hair, 0.85) : hair, 'hair'); }
  if (hs === 'afro') E(3, 0, 26, 20, hair, 'hair');
  if (hs === 'curlbun') E(10, 0, 12, 8, hair, 'hair');
  if (hs === 'bun') E(12, 0, 8, 6, hair, 'hair');

  // 2) 몸(옷)·팔·손
  RR(8, 21, 16, 15, 4, top, 'top');
  const armsDown = pose === 'stand' || pose === 'rest';
  if (armsDown) { RR(5, 22, 5, 12, 2, top, 'top'); RR(22, 22, 5, 12, 2, top, 'top'); E(5, 32, 5, 5, skin, 'hand'); E(22, 32, 5, 5, skin, 'hand'); }
  else { RR(5, 22, 5, 9, 2, top, 'top'); RR(22, 22, 5, 9, 2, top, 'top'); }
  switch (c.topStyle) {
    case 'jacket': R(14, 21, 4, 14, inner, 'inner'); for (let j = 0; j < 6; j++) { P(13 + Math.floor(j / 2), 21 + j, shade(top, 0.65)); P(18 - Math.floor(j / 2), 21 + j, shade(top, 0.65)); } P(13, 29, shade(top, 0.6)); P(13, 32, shade(top, 0.6)); R(15, 23, 2, 6, shade(top, 0.9)); break;
    case 'hoodie': RR(10, 19, 12, 5, 2, shade(top, 0.82), 'hood'); R(13, 24, 1, 4, '#f4f1ea'); R(18, 24, 1, 4, '#f4f1ea'); RR(11, 29, 10, 5, 1, shade(top, 0.88), 'pocket'); break;
    case 'knit': R(12, 21, 8, 2, shade(top, 1.15), 'collar'); for (let y = 25; y < 35; y += 3) for (let x = 9 + ((y / 3) % 2); x < 23; x += 2) P(x, y, shade(top, 0.86)); break;
    case 'shirt': for (let j = 0; j < 3; j++) { R(12 + j, 21 + j, 2, 1, shade(top, 1.2), 'collar'); R(18 - j, 21 + j, 2, 1, shade(top, 1.2), 'collar'); } for (let y = 25; y < 35; y += 3) P(16, y, shade(top, 0.7)); break;
    case 'cardigan': R(13, 21, 6, 15, inner, 'inner'); R(13, 21, 1, 15, shade(top, 0.8)); R(18, 21, 1, 15, shade(top, 0.8)); for (let y = 25; y < 35; y += 3) P(12, y, shade(top, 0.6)); break;
    case 'vest': RR(8, 21, 16, 15, 4, inner, 'inner'); RR(5, 22, 5, armsDown ? 12 : 9, 2, inner, 'inner'); RR(22, 22, 5, armsDown ? 12 : 9, 2, inner, 'inner'); R(9, 23, 5, 12, top, 'top'); R(18, 23, 5, 12, top, 'top'); for (let y = 26; y < 35; y += 3) P(17, y, shade(top, 0.6)); break;
    case 'blouse': R(12, 21, 8, 2, '#fbf4ee', 'collar'); R(14, 23, 4, 1, '#fbf4ee', 'collar'); R(15, 24, 2, 2, shade(top, 0.7)); break;
  }
  // 앉은 자세의 손(타자 두 장면·검토 문서)
  if (pose === 'sit') { E(9, 29, 5, 4, skin, 'hand'); E(18, 29, 5, 4, skin, 'hand'); }
  if (pose === 'type') { E(9, frame ? 30 : 29, 5, 4, skin, 'hand'); E(18, frame ? 29 : 30, 5, 4, skin, 'hand'); }
  if (pose === 'review') { RR(17, 23, 12, 13, 1, '#fbf8f0', 'paper'); for (let y = 26; y < 34; y += 2) R(19, y, y % 4 ? 6 : 8, 1, '#a3a9b4'); R(25, 27, 2, 1, '#c2413b'); E(14, 28, 5, 4, skin, 'hand'); }
  // 3) 다리·신발(서 있을 때)
  if (!seated) { R(9, 35, 14, 7, c.pants, 'pants'); R(16, 37, 1, 5, shade(c.pants, 0.7)); RR(7, 41, 8, 4, 1, '#3a2a1e', 'shoe'); RR(17, 41, 8, 4, 1, '#3a2a1e', 'shoe'); }

  // 4) 목·귀·얼굴
  R(13, 18, 6, 4, shade(skin, 0.86), 'neck');
  E(6, 11, 4, 6, skin, 'skin'); E(22, 11, 4, 6, skin, 'skin');
  E(8, 4, 16, 17, skin, 'skin');
  // 5) 머리(앞)
  const cap = () => { E(7, 2, 18, 11, hair, 'hair'); };
  switch (hs) {
    case 'short': cap(); R(7, 7, 2, 6, hair, 'hair'); R(23, 7, 2, 6, hair, 'hair'); R(9, 8, 14, 1, hair, 'hair'); break;
    case 'sidepart': cap(); R(9, 8, 11, 2, hair, 'hair'); R(9, 10, 4, 1, hair, 'hair'); R(7, 7, 2, 6, hair, 'hair'); R(23, 7, 2, 5, hair, 'hair'); R(19, 3, 1, 4, shade(hair, 0.7)); break;
    case 'messy': cap(); for (const x of [10, 13, 16, 19, 22]) R(x, 1, 2, 2, hair, 'hair'); for (const x of [9, 12, 16, 20]) R(x, 9, 2, 2, hair, 'hair'); R(7, 7, 2, 6, hair, 'hair'); R(23, 7, 2, 6, hair, 'hair'); break;
    case 'spiky': cap(); for (const x of [9, 12, 15, 18, 21]) { R(x, 0, 2, 3, hair, 'hair'); P(x, 0, hair, 'hair'); } R(7, 7, 2, 5, hair, 'hair'); R(23, 7, 2, 5, hair, 'hair'); R(9, 8, 14, 1, hair, 'hair'); break;
    case 'long': case 'wavy': cap(); R(9, 8, 6, 2, hair, 'hair'); R(17, 8, 6, 2, hair, 'hair'); R(6, 8, 3, 12, hair, 'hair'); R(23, 8, 3, 12, hair, 'hair'); break;
    case 'ponytail': cap(); R(9, 8, 14, 2, hair, 'hair'); R(7, 7, 2, 6, hair, 'hair'); R(23, 7, 2, 4, hair, 'hair'); E(24, 5, 4, 4, shade(hair, 0.6), 'tie'); break;
    case 'braid': cap(); R(9, 8, 7, 2, hair, 'hair'); R(16, 8, 7, 1, hair, 'hair'); R(6, 8, 3, 10, hair, 'hair'); R(23, 8, 2, 6, hair, 'hair'); break;
    case 'bun': cap(); R(9, 8, 14, 2, hair, 'hair'); R(7, 7, 2, 6, hair, 'hair'); R(23, 7, 2, 6, hair, 'hair'); break;
    case 'bob': cap(); R(8, 8, 16, 3, hair, 'hair'); R(6, 8, 4, 11, hair, 'hair'); R(22, 8, 4, 11, hair, 'hair'); break;
    case 'afro': R(8, 6, 16, 4, hair, 'hair'); R(5, 8, 4, 8, hair, 'hair'); R(23, 8, 4, 8, hair, 'hair'); break;
    case 'curly': cap(); for (const x of [8, 11, 14, 17, 20, 23]) E(x, 1, 3, 3, hair, 'hair'); for (const x of [9, 13, 17, 21]) E(x, 8, 3, 3, hair, 'hair'); R(7, 7, 2, 6, hair, 'hair'); R(23, 7, 2, 6, hair, 'hair'); break;
    case 'curlbun': cap(); R(9, 8, 14, 2, hair, 'hair'); R(7, 7, 2, 6, hair, 'hair'); R(23, 7, 2, 6, hair, 'hair'); break;
    case 'bald': E(9, 3, 14, 6, shade(skin, 1.06), 'skin'); R(7, 9, 2, 5, hair, 'hair'); R(23, 9, 2, 5, hair, 'hair'); break;
  }
  // 얼굴: 눈(흰자·눈동자·빛), 눈썹, 코, 입, 볼
  const eyeY = 12;
  if (pose === 'rest') { R(10, eyeY + 1, 4, 1, INK); R(18, eyeY + 1, 4, 1, INK); }
  else {
    for (const ex of [10, 18]) { R(ex, eyeY, 4, 3, '#ffffff', 'eye'); R(ex + 1, eyeY + 1, 2, 2, '#2b2333', 'eye'); P(ex + 1, eyeY + 1, '#8a96b0', 'eye'); R(ex, eyeY, 4, 1, shade(skin, 0.75)); }
  }
  if (hs !== 'afro' || true) { R(10, eyeY - 2, 4, 1, shade(hair === skin ? '#5a4632' : hair, 0.8)); R(18, eyeY - 2, 4, 1, shade(hair === skin ? '#5a4632' : hair, 0.8)); }
  P(16, 15, shade(skin, 0.8)); P(15, 16, shade(skin, 0.86));
  R(14, 18, 4, 1, mix(shade(skin, 0.6), '#b14b52', 0.5));
  P(9, 16, mix(skin, '#f08a8a', 0.35)); P(22, 16, mix(skin, '#f08a8a', 0.35));
  // 6) 소품
  for (const e of c.extras) {
    if (e === 'glassesRound' || e === 'glassesSquare') {
      const fc = e === 'glassesSquare' ? '#1d1d26' : '#6b4f33';
      for (const ex of [9, 17]) { R(ex, eyeY - 1, 6, 1, fc); R(ex, eyeY + 3, 6, 1, fc); R(ex, eyeY, 1, 3, fc); R(ex + 5, eyeY, 1, 3, fc); P(ex + 1, eyeY, '#e6f2ff'); }
      R(15, eyeY, 2, 1, fc);
    }
    if (e === 'headset') { R(8, 1, 16, 2, '#2b2f38'); R(6, 3, 2, 8, '#2b2f38'); R(24, 3, 2, 8, '#2b2f38'); E(4, 10, 5, 8, '#1fb0a3', 'cup'); E(23, 10, 5, 8, '#1fb0a3', 'cup'); R(24, 18, 4, 1, '#2b2f38'); P(21, 18, '#2b2f38'); }
    if (e === 'beard') { E(9, 13, 14, 9, hair, 'hair'); R(14, 17, 4, 1, mix(shade(skin, 0.6), '#b14b52', 0.5)); R(13, 16, 6, 1, hair, 'hair'); }
    if (e === 'mustache') { R(13, 17, 6, 1, hair, 'hair'); P(12, 18, hair, 'hair'); P(19, 18, hair, 'hair'); }
    if (e === 'clip') { R(19, 7, 3, 1, '#f2c94c'); P(22, 7, '#d9a21b'); }
  }
  // 7) 빛·그늘, 머리와 얼굴 경계, 바깥 테두리
  g.light('top', 0.78, 1.1); g.light('inner', 0.88, 1.04); g.light('skin', 0.9, 1.04); g.light('hair', 0.72, 1.18); g.light('pants', 0.78, 1.08);
  g.light('hand', 0.88, 1.04); g.light('shoe', 0.7, 1.2); g.light('hood', 0.85, 1.05); g.light('paper', 0.9, 1);
  g.seam('hair', 'skin', shade(hair, 0.62));
  g.outline(INK);
  const rects = g.toRects(seated ? CHAR2_SIT_H : CHAR2_H);
  cache.set(key, rects);
  return rects;
}

// ───── 가구(같은 화풍·같은 빛 방향) ─────
const W = { hi: '#ecc08a', top: '#d9a46c', top2: '#cf9a62', grain: '#c08a55', front: '#a86d3f', front2: '#955f35', dark: '#7d4c28', leg: '#6a3f22' };
export const STATION_W = 96; export const STATION_H = 68;
/** 앉은 사람을 책상 그림 기준 어디에 그리는지(머리·어깨가 상판 위로 보이게) */
export const SEAT_X = 38; export const SEAT_Y = -8;
export type Screen = 'code' | 'doc' | 'plan' | 'wait' | 'off';
export type DeskProp = 'clipboard' | 'notes' | 'blueprint' | 'server' | 'tablet' | 'books' | 'lock' | 'redpen' | 'flask' | 'boxes' | 'plant' | 'cables';
const fcache = new Map<string, Rect[]>();
function memo(key: string, f: () => Rect[]) { const h = fcache.get(key); if (h) return h; const r = f(); fcache.set(key, r); return r; }

/** 의자 등받이(사람 뒤에 그린다). 비어 있으면 책상에서 빼 둔 의자 */
export function chairBack(empty: boolean): Rect[] {
  return memo(`chair|${empty}`, () => {
    const g = new Grid(STATION_W, STATION_H);
    const c = '#3b4a7a';
    if (empty) { g.rrect(56, 14, 26, 22, 5, c, 'chair'); g.rrect(59, 17, 20, 14, 4, shade(c, 1.15), 'cush'); g.rect(66, 36, 6, 5, '#2a3150', 'pole'); }
    else { g.rrect(40, 4, 30, 32, 6, c, 'chair'); g.rrect(44, 8, 22, 22, 5, shade(c, 1.15), 'cush'); }
    g.light('chair', 0.75, 1.12); g.light('cush', 0.85, 1.1); g.outline(INK);
    return g.toRects();
  });
}
/** 책상 앞쪽(사람 앞에 그린다): 상판·앞판·서랍·다리·그림자·모니터·키보드·마우스·스탠드·머그·직군 소품 */
export function deskFront(screen: Screen, prop: DeskProp, mug: boolean): Rect[] {
  return memo(`desk|${screen}|${prop}|${mug}`, () => {
    const g = new Grid(STATION_W, STATION_H);
    // 상판(윗면 결) + 두께
    g.rrect(1, 32, 94, 10, 2, W.top, 'top');
    for (let x = 6; x < 90; x += 17) g.hline(x, 35 + (Math.floor(x / 17) % 3), 9, W.grain, 'top');
    g.hline(2, 32, 92, W.hi, 'tophi');
    g.rect(2, 42, 92, 13, W.front, 'front');
    g.rrect(8, 44, 30, 9, 1, W.front2, 'drawer'); g.rect(20, 47, 6, 2, '#e3c48d', 'handle');
    g.rect(4, 55, 5, 10, W.leg, 'leg'); g.rect(87, 55, 5, 10, W.leg, 'leg');
    // 모니터(받침·화면·빛 반사)
    g.rect(15, 26, 6, 7, '#3a4256', 'stand'); g.rrect(10, 31, 16, 3, 1, '#3a4256', 'stand');
    g.rrect(2, 4, 32, 23, 2, '#262d40', 'bezel');
    const sc = screen === 'code' ? '#12333d' : screen === 'doc' ? '#f3eee3' : screen === 'plan' ? '#e9eef7' : screen === 'wait' ? '#2a3550' : '#1a2030';
    g.rect(5, 7, 26, 17, sc, 'screen');
    if (screen === 'code') [[7, 10, '#7ee0a8'], [9, 13, '#79b8ff'], [7, 9, '#ffb070'], [11, 14, '#c8a6ff'], [7, 11, '#7ee0a8'], [9, 7, '#79b8ff']].forEach(([x, w, c], i) => g.hline(x as number, 9 + i * 2, w as number, c as string, 'ink'));
    if (screen === 'doc') for (let i = 0; i < 6; i++) g.hline(8, 10 + i * 2, i % 2 ? 14 : 20, '#9aa1ad', 'ink');
    if (screen === 'plan') ['#f7d774', '#9ad3a8', '#9cc3f0'].forEach((c, i) => { g.rect(7 + i * 8, 10, 6, 12, c, 'ink'); g.hline(8 + i * 8, 12, 4, shade(c, 0.7), 'ink'); });
    if (screen === 'wait') { g.ellipse(14, 11, 8, 8, '#3c4a6e', 'ink'); g.vline(18, 13, 3, '#9fb0d8', 'ink'); g.hline(18, 15, 2, '#9fb0d8', 'ink'); }
    if (screen !== 'off') for (let i = 0; i < 6; i++) g.set(29 - i, 8 + i, shade(sc, 1.25), 'glare');
    // 키보드·마우스
    g.rrect(40, 35, 30, 6, 1, '#dfe3ea', 'kb'); for (let y = 36; y < 40; y += 2) for (let x = 42; x < 68; x += 3) g.rect(x, y, 2, 1, '#b7bfcc', 'key');
    g.ellipse(71, 36, 4, 4, '#dfe3ea', 'mouse');
    // 직군 소품(오른쪽), 스탠드(오른쪽 끝), 머그(모니터 받침 옆)
    drawProp(g, prop, 72, 18);
    g.ellipse(84, 30, 10, 4, '#4a3f36', 'lamp'); g.vline(92, 12, 19, '#4a3f36', 'lamp'); g.hline(87, 12, 6, '#4a3f36', 'lamp');
    g.rrect(82, 8, 10, 6, 2, '#e09a2c', 'shade');
    if (mug) { g.rrect(28, 26, 6, 7, 1, '#f1efe8', 'mug'); g.rect(34, 28, 1, 3, '#f1efe8', 'mug'); g.rect(29, 27, 4, 1, '#8a5a3a'); }
    g.light('top', 0.9, 1.06); g.light('front', 0.85, 1.08); g.light('drawer', 0.85, 1.1); g.light('leg', 0.8, 1.1); g.light('bezel', 0.75, 1.3); g.light('kb', 0.85, 1.05);
    g.light('mouse', 0.8, 1.05); g.light('shade', 0.75, 1.15); g.light('mug', 0.85, 1.0); g.light('stand', 0.8, 1.2);
    g.outline(INK);
    // 바닥 그림자(테두리 다음, 반투명)
    const r = g.toRects();
    r.unshift([6, 64, 86, 3, '#00000026']);
    return r;
  });
}
function drawProp(g: Grid, p: DeskProp, x: number, y: number) {
  switch (p) {
    case 'clipboard': g.rrect(x, y, 12, 14, 1, '#b88a55', 'p'); g.rect(x + 2, y + 2, 8, 11, '#fbf6ea', 'p2'); g.rect(x + 4, y - 1, 4, 3, '#8a8f99', 'p3'); for (let i = 0; i < 4; i++) g.hline(x + 3, y + 4 + i * 2, 6, '#a3a9b4'); break;
    case 'notes': g.rect(x, y + 4, 8, 8, '#f7d774', 'p'); g.rect(x + 6, y + 7, 8, 8, '#9ad3a8', 'p2'); g.rect(x + 2, y, 7, 7, '#f3a6b8', 'p3'); break;
    case 'blueprint': g.rrect(x, y + 6, 16, 8, 1, '#3d6fb0', 'p'); for (let i = 0; i < 3; i++) g.hline(x + 2, y + 8 + i * 2, 11, '#cfe2ff'); g.rect(x + 13, y + 1, 2, 12, '#f2c94c', 'p2'); break;
    case 'server': g.rrect(x, y, 12, 15, 1, '#2e3442', 'p'); for (let i = 0; i < 3; i++) { g.hline(x + 2, y + 3 + i * 4, 8, '#4a5266'); g.set(x + 9, y + 3 + i * 4, i ? '#e0a43c' : '#3ad29f'); } break;
    case 'tablet': g.rrect(x, y + 4, 14, 10, 1, '#1f2638', 'p'); g.rect(x + 2, y + 6, 10, 6, '#f3a6b8', 'p2'); g.rect(x + 4, y + 8, 4, 2, '#fff'); break;
    case 'books': ['#7d2333', '#2f8a63', '#d9953a', '#3d6fb0'].forEach((c, i) => g.rrect(x, y + 4 + i * 3, 16 - i, 3, 1, c, `b${i}`)); break;
    case 'lock': g.rrect(x + 1, y + 7, 12, 8, 1, '#e0a43c', 'p'); g.rect(x + 3, y + 2, 2, 5, '#8a8f99'); g.rect(x + 9, y + 2, 2, 5, '#8a8f99'); g.hline(x + 3, y + 1, 8, '#8a8f99'); g.rect(x + 6, y + 10, 2, 3, '#7a4c2a'); break;
    case 'redpen': g.rrect(x, y + 3, 15, 12, 1, '#fbf6ea', 'p'); for (let i = 0; i < 4; i++) g.hline(x + 2, y + 5 + i * 2, i === 2 ? 6 : 10, i === 2 ? '#c2413b' : '#a3a9b4'); g.rect(x + 13, y, 2, 10, '#c2413b', 'p2'); break;
    case 'flask': g.rect(x + 4, y, 5, 5, '#d6eef2', 'p2'); g.ellipse(x, y + 4, 13, 11, '#5bc0be', 'p'); g.rect(x + 2, y + 9, 9, 4, '#2f8f8f'); break;
    case 'boxes': g.rrect(x, y + 6, 15, 9, 1, '#c49a62', 'p'); g.rrect(x + 3, y, 10, 7, 1, '#d9b27a', 'p2'); g.vline(x + 7, y + 6, 9, '#9e7848'); break;
    case 'cables': g.rrect(x, y + 3, 13, 12, 1, '#3b3f48', 'p'); for (let i = 0; i < 3; i++) g.set(x + 3 + i * 3, y + 6, i ? '#3ad29f' : '#e0a43c'); g.vline(x + 13, y + 9, 5, '#e0a43c'); break;
    default: plantInto(g, x, y, false);
  }
  g.light('p', 0.82, 1.1); g.light('p2', 0.85, 1.08);
}
function plantInto(g: Grid, x: number, y: number, big: boolean) {
  const s = big ? 2 : 1;
  g.rrect(x + 3 * s, y + 9 * s, 10 * s, 7 * s, 1, '#b4673d', 'pot'); g.hline(x + 2 * s, y + 9 * s, 12 * s, '#cf8250', 'pot');
  const greens = ['#2f7d55', '#3e9a68', '#58b47e'];
  const leaves: [number, number, number, number, number][] = [[0, 4, 7, 6, 0], [9, 3, 7, 6, 0], [3, 0, 7, 7, 1], [7, -2, 6, 7, 1], [5, 3, 7, 6, 2], [1, 1, 5, 5, 2]];
  for (const [lx, ly, w, h, k] of leaves) g.ellipse(x + lx * s, y + ly * s, w * s, h * s, greens[k], `leaf${k}`);
  g.light('pot', 0.8, 1.1); g.light('leaf0', 0.8, 1.1); g.light('leaf1', 0.85, 1.12); g.light('leaf2', 0.85, 1.12);
}
export function plant2(big: boolean): Rect[] {
  return memo(`plant|${big}`, () => { const g = new Grid(big ? 34 : 18, big ? 36 : 18); plantInto(g, 1, big ? 4 : 2, big); g.outline(INK); return g.toRects(); });
}
/** 책장(두 칸, 책 높이·색 다양) */
export function bookshelf2(w: number): Rect[] {
  return memo(`shelf|${w}`, () => {
    const h = 44; const g = new Grid(w + 2, h + 2);
    g.rect(1, 1, w, h, W.front, 'frame'); g.hline(1, 1, w, W.hi, 'frame');
    for (const sy of [4, 23]) {
      g.rect(4, sy, w - 6, 17, '#5e3a20', 'back');
      let x = 5; let i = 0; const cols = ['#b5523b', '#3d6fb0', '#2f8a63', '#d9a03a', '#7a58b8', '#e2d6bd', '#c2547d', '#3a4b6e'];
      while (x < w - 4) { const bw = 3 + (i % 3); const bh = 12 + ((i * 7) % 5); if (x + bw > w - 3) break; g.rect(x, sy + 17 - bh, bw, bh, cols[(i + sy) % cols.length], `bk${i % 4}`); g.hline(x, sy + 17 - bh + 2, bw, '#ffffff40'); x += bw + (i % 5 === 4 ? 3 : 0); i++; }
    }
    g.light('frame', 0.8, 1.08); for (let k = 0; k < 4; k++) g.light(`bk${k}`, 0.8, 1.1);
    g.outline(INK); return g.toRects();
  });
}
/** 창틀(유리 부분은 비워 두고 뒤에 하늘·건물을 그린다) */
export function windowFrame(w: number, h: number): Rect[] {
  return memo(`win|${w}|${h}`, () => {
    const g = new Grid(w + 2, h + 6);
    const f = '#f3ece0';
    g.rect(1, 1, w, 3, f, 'wf'); g.rect(1, h - 2, w, 3, f, 'wf'); g.rect(1, 1, 3, h, f, 'wf'); g.rect(w - 2, 1, 3, h, f, 'wf');
    g.rect(Math.floor(w / 2) - 1, 1, 3, h, f, 'wf'); g.rect(1, Math.floor(h / 2) - 1, w, 2, f, 'wf');
    g.rect(0, h + 1, w + 2, 3, '#e6d9c0', 'sill'); g.hline(0, h + 1, w + 2, '#fbf6ea', 'sill');
    // 블라인드(위쪽)
    for (let y = 4; y < 9; y += 2) g.hline(4, y, w - 6, '#e9e2d4', 'bl');
    g.light('wf', 0.82, 1.04); g.light('sill', 0.78, 1.04);
    g.outline('#8a7a62'); return g.toRects();
  });
}

// ───── 라운지·리뷰룸 가구 ─────
const TEAL = '#2f7f82'; const TEAL_L = '#3f9a9c'; const TEAL_D = '#22605f';
export const SOFA_W = 104; export const SOFA_SEAT = 30; export const SOFA_H = 38;
/** 소파 등받이(사람 뒤) */
export function sofaBack(seats: number, color = TEAL): Rect[] {
  return memo(`sofab|${seats}|${color}`, () => {
    const w = 14 + seats * SOFA_SEAT; const g = new Grid(w + 2, 26);
    g.rrect(1, 1, w, 22, 5, color, 'back');
    for (let i = 0; i < seats; i++) g.rrect(8 + i * SOFA_SEAT, 4, SOFA_SEAT - 2, 15, 4, shade(color, 1.18), `cb${i % 2}`);
    g.light('back', 0.75, 1.12); g.light('cb0', 0.82, 1.1); g.light('cb1', 0.82, 1.1);
    g.outline(INK); return g.toRects();
  });
}
/** 소파 앞(앉은 사람의 다리를 가리는 방석·팔걸이·다리) */
export function sofaFront(seats: number, color = TEAL): Rect[] {
  return memo(`sofaf|${seats}|${color}`, () => {
    const w = 14 + seats * SOFA_SEAT; const g = new Grid(w + 2, SOFA_H + 2);
    for (let i = 0; i < seats; i++) g.rrect(6 + i * SOFA_SEAT, 18, SOFA_SEAT - 1, 11, 3, shade(color, 1.1), `seat${i % 2}`);
    g.rect(5, 27, w - 8, 7, shade(color, 0.8), 'base');
    g.rrect(1, 9, 9, 26, 3, color, 'arm'); g.rrect(w - 8, 9, 9, 26, 3, color, 'arm2');
    g.rect(6, 35, 3, 3, '#4a3426', 'leg'); g.rect(w - 7, 35, 3, 3, '#4a3426', 'leg');
    g.light('seat0', 0.85, 1.1); g.light('seat1', 0.85, 1.1); g.light('base', 0.8, 1.05); g.light('arm', 0.75, 1.12); g.light('arm2', 0.75, 1.12);
    g.outline(INK); return g.toRects();
  });
}
/** 커피 탁자(머그·잡지) */
export function coffeeTable(w = 46): Rect[] {
  return memo(`ctable|${w}`, () => {
    const g = new Grid(w + 2, 18);
    g.rrect(1, 3, w, 7, 2, W.top, 'top'); g.hline(2, 3, w - 2, W.hi);
    g.rect(2, 10, w - 2, 3, W.front, 'front'); g.rect(4, 13, 3, 4, W.leg); g.rect(w - 5, 13, 3, 4, W.leg);
    g.rect(8, 4, 12, 4, '#f3a6b8', 'mag'); g.hline(9, 5, 8, '#fbe3ea');
    g.rrect(w - 14, 0, 6, 7, 1, '#f1efe8', 'mug'); g.rect(w - 8, 2, 1, 3, '#f1efe8', 'mug'); g.hline(w - 13, 1, 4, '#8a5a3a');
    g.light('top', 0.85, 1.05); g.light('front', 0.8, 1.05); g.light('mug', 0.85, 1);
    g.outline(INK); return g.toRects();
  });
}
/** 커피 바(상판·앞판·커피 머신·컵) */
export function coffeeBar(w = 72): Rect[] {
  return memo(`bar|${w}`, () => {
    const g = new Grid(w + 2, 50);
    g.rrect(10, 1, 20, 22, 2, '#3b3f4a', 'mach'); g.rect(13, 4, 14, 6, '#22262e'); g.rect(15, 5, 4, 2, '#e05b4b'); g.rect(21, 5, 2, 2, '#3ad29f');
    g.rect(17, 12, 6, 4, '#8a8f99'); g.rrect(16, 17, 8, 6, 1, '#f1efe8', 'cup');
    g.rrect(36, 9, 12, 14, 2, '#d6dbe3', 'jar'); g.rect(38, 15, 8, 6, '#8a5a3a');
    g.rrect(52, 15, 6, 8, 1, '#f1efe8', 'cup'); g.rrect(60, 15, 6, 8, 1, '#9cc3f0', 'cup2');
    g.rect(1, 23, w, 5, W.top, 'top'); g.hline(1, 23, w, W.hi);
    g.rect(2, 28, w - 2, 20, W.front, 'front');
    for (let x = 6; x < w - 8; x += 22) g.rrect(x, 31, 18, 14, 1, W.front2, 'door');
    g.light('mach', 0.75, 1.2); g.light('jar', 0.85, 1.05); g.light('cup', 0.85, 1); g.light('cup2', 0.85, 1.05); g.light('top', 0.85, 1.05); g.light('front', 0.8, 1.05); g.light('door', 0.85, 1.1);
    g.outline(INK); return g.toRects();
  });
}
/** 플로어 스탠드 */
export function floorLamp(): Rect[] {
  return memo('flamp', () => {
    const g = new Grid(18, 58);
    g.rrect(2, 1, 14, 10, 3, '#f2d39a', 'shade'); g.vline(8, 11, 42, '#4a3f36'); g.vline(9, 11, 42, '#5a4d42'); g.ellipse(3, 52, 12, 4, '#4a3f36', 'base');
    g.light('shade', 0.82, 1.08); g.outline(INK); return g.toRects();
  });
}
/** 화이트보드(포스트잇·글줄) */
export function whiteboard(w = 60): Rect[] {
  return memo(`wb|${w}`, () => {
    const g = new Grid(w + 2, 36);
    g.rect(1, 1, w, 30, '#9aa1ad', 'frame'); g.rect(3, 3, w - 4, 26, '#fbfbf8', 'board');
    [['#f7d774', 5, 6], ['#9ad3a8', 13, 6], ['#f3a6b8', 5, 15], ['#9cc3f0', 13, 15]].forEach(([c, x, y]) => g.rect(x as number, y as number, 7, 7, c as string, 'note'));
    for (let i = 0; i < 4; i++) g.hline(24, 7 + i * 5, i === 2 ? 14 : 22, i === 2 ? '#c2413b' : '#3d6fb0');
    g.rect(4, 31, w - 6, 2, '#7a8190', 'tray'); g.rect(10, 30, 6, 1, '#c2413b'); g.rect(18, 30, 6, 1, '#3d6fb0');
    g.light('frame', 0.8, 1.1); g.outline(INK); return g.toRects();
  });
}
/** 벽시계 */
export function wallClock(): Rect[] {
  return memo('clock', () => { const g = new Grid(18, 18); g.ellipse(1, 1, 16, 16, '#3a4256', 'rim'); g.ellipse(3, 3, 12, 12, '#fbfbf8', 'face'); g.vline(9, 5, 4, '#2a2129'); g.hline(9, 9, 4, '#2a2129'); g.outline(INK); return g.toRects(); });
}
/** 휴가 게시판 틀(코르크): n칸 */
export const BOARD_SLOT = 28;
export function corkBoard(n: number): Rect[] {
  return memo(`cork|${n}`, () => {
    const w = 8 + Math.max(1, n) * BOARD_SLOT; const g = new Grid(w + 2, 36);
    g.rect(1, 1, w, 32, '#b98654', 'frame'); g.rect(3, 3, w - 4, 28, '#d9b27a', 'cork');
    for (let i = 0; i < 40; i++) g.set(4 + ((i * 37) % (w - 6)), 4 + ((i * 17) % 26), '#c99d63');
    for (let i = 0; i < Math.max(1, n); i++) { g.rect(6 + i * BOARD_SLOT, 6, BOARD_SLOT - 4, 23, '#fbf6ea', 'photo'); g.set(6 + i * BOARD_SLOT + 11, 5, '#c2413b'); g.set(6 + i * BOARD_SLOT + 12, 5, '#c2413b'); }
    g.light('frame', 0.8, 1.1); g.outline(INK); return g.toRects();
  });
}
/** 캐릭터 얼굴만(머리 위~턱): 목록·게시판용. 너비 30, 높이 22 */
export function charHead(c: CharDef): Rect[] {
  const k = `head|${c.id}`; const hit = cache.get(k); if (hit) return hit;
  const out: Rect[] = [];
  for (const [x, y, w, h, col] of char2(c, 'stand')) {
    if (y >= 23) continue; const x0 = Math.max(x, 2); const x1 = Math.min(x + w, 32); if (x1 <= x0) continue;
    out.push([x0 - 2, y, x1 - x0, h, col]);
  }
  cache.set(k, out); return out;
}
export const HEAD_W = 30; export const HEAD_H = 23;

// ───── 옆모습(리뷰룸에서 마주 보고 앉기) ─────
/** 좌우 뒤집기(그림 너비 w 기준) */
export function flipX(r: Rect[], w: number): Rect[] { return r.map(([x, y, rw, rh, c]) => [w - x - rw, y, rw, rh, c] as Rect); }
export const SIDE_W = 36; export const SIDE_H = 48;
/** 의자에 앉아 오른쪽을 보는 옆모습. 'review'는 검토 자료를 들고, 'sit'은 두 손을 탁자에 둔다. 왼쪽 자리는 그대로, 오른쪽 자리는 flipX로 뒤집어 쓴다. */
export function charSide(c: CharDef, pose: 'sit' | 'review'): Rect[] {
  const key = `side|${c.id}|${pose}`; const hit = cache.get(key); if (hit) return hit;
  const g = new Grid(SIDE_W, SIDE_H);
  const skin = c.skin; const hair = c.hair; const top = c.top; const hs = c.hairStyle;
  // 의자(등받이·방석·다리)
  g.rrect(2, 15, 6, 23, 2, '#3b4a7a', 'chair'); g.rrect(4, 33, 20, 5, 2, '#46578c', 'seat'); g.rect(12, 38, 3, 8, '#2a3150'); g.rect(7, 45, 13, 2, '#2a3150');
  // 몸 뒤 머리
  if (hs === 'long' || hs === 'wavy' || hs === 'braid') g.rrect(7, 8, 8, hs === 'braid' ? 20 : 17, 3, hair, 'hair');
  if (hs === 'ponytail') { g.ellipse(4, 6, 6, 6, hair, 'hair'); g.rrect(4, 10, 5, 12, 2, hair, 'hair'); }
  if (hs === 'bun' || hs === 'curlbun') g.ellipse(6, 1, 8, 7, hair, 'hair');
  if (hs === 'afro') g.ellipse(5, 0, 24, 21, hair, 'hair');
  // 다리(허벅지는 앞으로, 정강이는 아래로)·신발
  g.rect(11, 32, 15, 6, c.pants, 'pants'); g.rect(21, 36, 6, 9, c.pants, 'pants'); g.rrect(21, 43, 9, 4, 1, '#3a2a1e', 'shoe');
  // 몸통·옷 특징
  g.rrect(9, 20, 14, 16, 4, top, 'top');
  if (c.topStyle === 'jacket' || c.topStyle === 'cardigan') { g.rect(20, 21, 3, 13, c.inner ?? '#f4f1ea', 'inner'); g.vline(19, 21, 13, shade(top, 0.65)); }
  if (c.topStyle === 'hoodie') g.rrect(9, 18, 8, 5, 2, shade(top, 0.82), 'hood');
  if (c.topStyle === 'vest') { g.rect(19, 21, 4, 13, c.inner ?? '#f4f1ea', 'inner'); }
  if (c.topStyle === 'shirt' || c.topStyle === 'blouse') g.rect(18, 20, 4, 2, shade(top, 1.2), 'collar');
  // 목·머리
  g.rect(15, 17, 6, 5, shade(skin, 0.86), 'neck');
  g.ellipse(9, 3, 16, 17, skin, 'skin');
  g.rect(24, 11, 2, 3, skin, 'skin'); // 코
  // 머리카락(앞머리는 이마 쪽, 뒤쪽은 뒤통수를 덮는다)
  if (hs !== 'bald' && hs !== 'afro') { g.ellipse(8, 1, 17, 10, hair, 'hair'); g.rrect(8, 5, 7, hs === 'long' || hs === 'wavy' || hs === 'bob' ? 15 : 10, 3, hair, 'hair'); g.rect(17, 5, 7, 3, hair, 'hair'); }
  if (hs === 'afro') { g.rect(8, 5, 8, 10, hair, 'hair'); g.rect(16, 4, 8, 3, hair, 'hair'); }
  if (hs === 'bald') { g.rect(9, 9, 4, 5, hair, 'hair'); }
  if (hs === 'spiky') for (const x of [10, 13, 16, 19]) g.rect(x, 0, 2, 3, hair, 'hair');
  if (hs === 'messy' || hs === 'curly') for (const x of [11, 15, 19]) g.ellipse(x, 0, 4, 4, hair, 'hair');
  if (hs === 'sidepart') g.rect(18, 7, 6, 1, hair, 'hair');
  if (hs === 'ponytail') g.ellipse(5, 5, 4, 4, shade(hair, 0.6), 'tie');
  // 귀·눈·눈썹·입·볼
  g.ellipse(13, 10, 4, 5, shade(skin, 0.92), 'ear');
  g.rect(19, 10, 3, 3, '#ffffff'); g.rect(20, 11, 2, 2, '#2b2333'); g.rect(19, 10, 3, 1, shade(skin, 0.75));
  g.rect(19, 8, 4, 1, shade(hair === skin ? '#5a4632' : hair, 0.8));
  g.rect(21, 16, 3, 1, mix(shade(skin, 0.6), '#b14b52', 0.5)); g.set(19, 14, mix(skin, '#f08a8a', 0.35));
  for (const e of c.extras) {
    if (e === 'glassesRound' || e === 'glassesSquare') { const fc = e === 'glassesSquare' ? '#1d1d26' : '#6b4f33'; g.rect(18, 9, 6, 1, fc); g.rect(18, 13, 6, 1, fc); g.rect(23, 9, 1, 5, fc); g.rect(14, 10, 4, 1, fc); }
    if (e === 'headset') { g.rect(10, 1, 12, 2, '#2b2f38'); g.ellipse(12, 8, 6, 8, '#1fb0a3', 'cup'); g.rect(17, 14, 5, 1, '#2b2f38'); }
    if (e === 'beard') { g.ellipse(15, 12, 11, 9, hair, 'hair'); g.rect(21, 16, 3, 1, mix(shade(skin, 0.6), '#b14b52', 0.5)); }
    if (e === 'mustache') g.rect(20, 15, 5, 1, hair, 'hair');
    if (e === 'clip') g.rect(17, 5, 3, 1, '#f2c94c');
  }
  // 팔: 앞으로 뻗어 탁자 위에(검토하는 쪽은 자료를 든다)
  g.rrect(13, 22, 6, 9, 2, shade(top, 0.92), 'arm'); g.rrect(15, 27, 13, 5, 2, shade(top, 0.92), 'arm');
  if (pose === 'review') { g.rrect(26, 17, 9, 12, 1, '#fbf8f0', 'paper'); for (let y = 20; y < 27; y += 2) g.hline(28, y, y % 4 ? 4 : 6, '#a3a9b4'); g.set(31, 24, '#c2413b'); g.ellipse(26, 25, 5, 5, skin, 'hand'); }
  else g.ellipse(27, 27, 5, 5, skin, 'hand');
  g.light('top', 0.78, 1.1); g.light('arm', 0.8, 1.08); g.light('hair', 0.72, 1.18); g.light('skin', 0.9, 1.04); g.light('pants', 0.78, 1.08);
  g.light('shoe', 0.7, 1.2); g.light('chair', 0.75, 1.12); g.light('seat', 0.8, 1.1); g.light('paper', 0.9, 1); g.light('hand', 0.88, 1.04);
  g.seam('hair', 'skin', shade(hair, 0.62));
  g.outline(INK);
  const r = g.toRects(); cache.set(key, r); return r;
}
/** 마주 앉는 작은 탁자(옆에서 본 모습): 상판·앞판·다리, 폭 w */
export function pairTable(w: number): Rect[] {
  return memo(`ptable|${w}`, () => {
    const g = new Grid(w + 2, 22);
    g.rrect(1, 1, w, 6, 2, W.top, 'top'); g.hline(2, 1, w - 2, W.hi);
    g.rect(2, 7, w - 2, 4, W.front, 'front'); g.rect(Math.floor(w / 2) - 1, 11, 4, 9, W.leg); g.rect(Math.floor(w / 2) - 6, 19, 14, 2, W.leg);
    g.light('top', 0.9, 1.05); g.light('front', 0.82, 1.06);
    g.outline(INK); return g.toRects();
  });
}
/** 빈 의자(옆모습) */
export function emptySide(): Rect[] {
  return memo('emptyside', () => { const g = new Grid(SIDE_W, SIDE_H); g.rrect(2, 15, 6, 23, 2, '#3b4a7a', 'chair'); g.rrect(4, 33, 20, 5, 2, '#46578c', 'seat'); g.rect(12, 38, 3, 8, '#2a3150'); g.rect(7, 45, 13, 2, '#2a3150'); g.light('chair', 0.75, 1.12); g.light('seat', 0.8, 1.1); g.outline(INK); return g.toRects(); });
}
