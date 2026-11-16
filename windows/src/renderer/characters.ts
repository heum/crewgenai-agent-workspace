// 직원 캐릭터 20종(이 앱에서 직접 만든 도트 그림). 같은 화풍·같은 크기(16×24칸)·같은 광원(왼쪽 위)으로 그린다.
// 색만 바꾼 것이 아니라 머리 모양·옷 종류·안경·헤드셋·수염으로 작은 크기에서도 구분되게 했다.
import { defaultCharacter } from '../shared/characterIds';
export { defaultCharacter };
// 자세: stand(서 있기), sit(앉기·대기), type(타자 — 손 두 장면), review(문서 들고 검토), rest(눈 감고 쉼).

export type Hair = 'short' | 'sidepart' | 'messy' | 'long' | 'wavy' | 'ponytail' | 'bun' | 'bob' | 'afro' | 'curly' | 'bald' | 'braid' | 'curlbun' | 'spiky';
export type Top = 'jacket' | 'hoodie' | 'knit' | 'shirt' | 'cardigan' | 'vest' | 'blouse';
export type Extra = 'glassesRound' | 'glassesSquare' | 'headset' | 'beard' | 'mustache' | 'clip';
export interface CharDef { id: string; name: string; skin: string; hair: string; hairStyle: Hair; top: string; topStyle: Top; pants: string; extras: Extra[]; inner?: string }

export const CHARACTERS: CharDef[] = [
  { id: 'C01', name: '네이비 재킷', skin: '#f2c6a0', hair: '#2a2a33', hairStyle: 'sidepart', top: '#2c3e6b', topStyle: 'jacket', inner: '#f4f1ea', pants: '#2f3442', extras: [] },
  { id: 'C02', name: '코랄 후디', skin: '#f4cdb0', hair: '#a8492e', hairStyle: 'wavy', top: '#ec7a64', topStyle: 'hoodie', pants: '#3a3f4c', extras: [] },
  { id: 'C03', name: '민트 니트', skin: '#f0c49c', hair: '#1f2a33', hairStyle: 'messy', top: '#7fcfae', topStyle: 'knit', pants: '#2f3a4f', extras: [] },
  { id: 'C04', name: '크림 가디건', skin: '#f4cdb0', hair: '#6b3f24', hairStyle: 'long', top: '#efe3c4', topStyle: 'cardigan', inner: '#7d5a3c', pants: '#5a4634', extras: [] },
  { id: 'C05', name: '올리브 셔츠', skin: '#b67a52', hair: '#2a1d16', hairStyle: 'bald', top: '#6f7d3c', topStyle: 'shirt', pants: '#c9b38a', extras: ['beard'] },
  { id: 'C06', name: '라벤더 셔츠', skin: '#f0c8a6', hair: '#b9b7b4', hairStyle: 'short', top: '#b8a6dc', topStyle: 'shirt', pants: '#3a3f4c', extras: ['glassesRound'] },
  { id: 'C07', name: '데님 재킷', skin: '#f2c6a0', hair: '#5a3420', hairStyle: 'ponytail', top: '#4f78b0', topStyle: 'jacket', inner: '#f4f1ea', pants: '#2f3442', extras: [] },
  { id: 'C08', name: '머스터드 니트', skin: '#8a5636', hair: '#1c1512', hairStyle: 'afro', top: '#e0a63a', topStyle: 'knit', pants: '#3a3f4c', extras: ['glassesRound'] },
  { id: 'C09', name: '스카이 셔츠', skin: '#f2c6a0', hair: '#24242c', hairStyle: 'bun', top: '#9fcbea', topStyle: 'shirt', pants: '#3a4152', extras: [] },
  { id: 'C10', name: '와인 가디건', skin: '#f4cdb0', hair: '#a5432a', hairStyle: 'wavy', top: '#7d2a3c', topStyle: 'cardigan', inner: '#f1ece2', pants: '#3a3f4c', extras: [] },
  { id: 'C11', name: '차콜 후디', skin: '#f0c49c', hair: '#1a1d24', hairStyle: 'spiky', top: '#3b3f48', topStyle: 'hoodie', pants: '#55595f', extras: ['headset'] },
  { id: 'C12', name: '세이지 조끼', skin: '#f2c6a0', hair: '#7a4a2a', hairStyle: 'sidepart', top: '#8fa77a', topStyle: 'vest', inner: '#f4f1ea', pants: '#b59c74', extras: [] },
  { id: 'C13', name: '피치 블라우스', skin: '#f4cdb0', hair: '#3a2420', hairStyle: 'bob', top: '#f2b29a', topStyle: 'blouse', pants: '#3a3f4c', extras: ['clip'] },
  { id: 'C14', name: '인디고 셔츠', skin: '#9a6440', hair: '#1c1512', hairStyle: 'curly', top: '#3d4f9c', topStyle: 'shirt', pants: '#c9b38a', extras: [] },
  { id: 'C15', name: '아이보리 셔츠', skin: '#f0c8a6', hair: '#c9c6c0', hairStyle: 'short', top: '#f1ece0', topStyle: 'shirt', pants: '#3a3f4c', extras: ['mustache'] },
  { id: 'C16', name: '테라코타 셔츠', skin: '#8a5636', hair: '#2a1a12', hairStyle: 'curlbun', top: '#c8643c', topStyle: 'shirt', pants: '#f1ece0', extras: [] },
  { id: 'C17', name: '틸 재킷', skin: '#f2c6a0', hair: '#18181e', hairStyle: 'braid', top: '#2a8a86', topStyle: 'jacket', inner: '#f4f1ea', pants: '#2f3442', extras: [] },
  { id: 'C18', name: '베이지 니트', skin: '#f4cdb0', hair: '#e6c06a', hairStyle: 'messy', top: '#dcc9a4', topStyle: 'knit', pants: '#3a4b6e', extras: [] },
  { id: 'C19', name: '플럼 니트', skin: '#f0c49c', hair: '#5a3a6e', hairStyle: 'short', top: '#7a3f66', topStyle: 'knit', pants: '#3a3f4c', extras: ['glassesRound'] },
  { id: 'C20', name: '블루 후디', skin: '#f2c6a0', hair: '#1a1d24', hairStyle: 'messy', top: '#3f72c8', topStyle: 'hoodie', pants: '#c9b38a', extras: ['glassesSquare'] },
];
// 외부 Codex 리뷰어(직원 아님): 후드를 쓴 모습으로 직원과 구분
export const EXTERNAL: CharDef[] = [
  { id: 'X1', name: 'Codex 리뷰어', skin: '#f2c6a0', hair: '#5b4bb5', hairStyle: 'short', top: '#5b4bb5', topStyle: 'hoodie', pants: '#2a2a33', extras: ['glassesSquare'] },
  { id: 'X2', name: 'Codex 리뷰어', skin: '#c48a5e', hair: '#1f8f8f', hairStyle: 'short', top: '#1f8f8f', topStyle: 'hoodie', pants: '#2a2a33', extras: ['glassesSquare'] },
  { id: 'X3', name: 'Codex 리뷰어', skin: '#e3ad86', hair: '#b5603b', hairStyle: 'short', top: '#b5603b', topStyle: 'hoodie', pants: '#2a2a33', extras: ['glassesSquare'] },
];
export const charById = (id: string | undefined | null) => CHARACTERS.find((c) => c.id === id) ?? EXTERNAL.find((c) => c.id === id) ?? null;

export function characterOf(a: { code: string; name: string; role: string; character?: string | null }): CharDef {
  return charById(a.character) ?? charById(defaultCharacter(a))!;
}

// ───── 그리기: 16×24 칸에 색을 칠하고, 바깥 테두리를 자동으로 두른 뒤, 가로로 이어진 칸을 묶어 사각형 목록으로 만든다 ─────
export type Pose = 'stand' | 'sit' | 'type' | 'review' | 'rest';
export type Rect = [number, number, number, number, string];
const OUT = '#2a2230';
const GW = 18; const GH = 26; // 테두리 여유 1칸씩

function shade(hex: string, k: number) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => f(v).toString(16).padStart(2, '0')).join('')}`;
}

const cache = new Map<string, Rect[]>();
/** 캐릭터·자세(·타자 장면)의 사각형 목록. 좌표 원점은 그림 왼쪽 위(테두리 포함 18×26). sit·type·review·rest는 윗몸(19줄)만. */
export function charRects(c: CharDef, pose: Pose, frame = 0): Rect[] {
  const key = `${c.id}|${pose}|${frame}`;
  const hit = cache.get(key); if (hit) return hit;
  const g: (string | null)[][] = Array.from({ length: GH }, () => Array(GW).fill(null));
  const P = (x: number, y: number, w: number, h: number, col: string) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (yy >= 0 && yy < GH && xx >= 0 && xx < GW) g[yy][xx] = col; };
  const ox = 1; const oy = 1; // 테두리 여유
  const p = (x: number, y: number, w: number, h: number, col: string) => P(x + ox, y + oy, w, h, col);
  const hair = c.hair; const hairD = shade(hair, 0.78); const top = c.top; const topD = shade(top, 0.8); const topL = shade(top, 1.12);
  const skin = c.skin; const skinD = shade(skin, 0.86);
  const seated = pose !== 'stand';
  // 1) 뒤로 내려오는 머리(몸 뒤)
  if (c.hairStyle === 'long' || c.hairStyle === 'wavy') { p(2, 5, 2, 10, hair); p(12, 5, 2, 10, hairD); if (c.hairStyle === 'wavy') { p(1, 8, 1, 2, hair); p(14, 10, 1, 2, hairD); p(1, 12, 1, 2, hair); } }
  if (c.hairStyle === 'ponytail') { p(12, 4, 2, 2, hairD); p(13, 6, 2, 6, hair); p(13, 12, 1, 1, hairD); }
  if (c.hairStyle === 'braid') { p(2, 5, 2, 7, hair); p(12, 5, 2, 4, hairD); for (let i = 0; i < 4; i++) p(2 + (i % 2), 12 + i * 2, 2, 2, i % 2 ? hairD : hair); }
  // 2) 몸통(옷)·팔·손
  p(4, 13, 8, 6, top); p(11, 13, 1, 6, topD); // 오른쪽이 그늘
  const armsSide = pose === 'stand' || pose === 'rest';
  if (armsSide) { p(3, 13, 1, 5, top); p(12, 13, 1, 5, topD); p(3, 18, 1, 1, skin); p(12, 18, 1, 1, skinD); }
  else { p(3, 13, 1, 3, top); p(12, 13, 1, 3, topD); }
  switch (c.topStyle) {
    case 'jacket': p(7, 13, 2, 4, c.inner ?? '#f4f1ea'); p(6, 13, 1, 3, topL); p(9, 13, 1, 3, topD); p(5, 17, 1, 1, topD); break;
    case 'hoodie': p(5, 12, 6, 1, topD); p(6, 14, 1, 2, '#f4f1ea'); p(9, 14, 1, 2, '#f4f1ea'); p(5, 17, 6, 1, topD); break;
    case 'knit': p(6, 13, 4, 1, topL); for (let x = 4; x < 12; x += 2) { p(x, 15, 1, 1, topD); p(x + 1, 17, 1, 1, topD); } break;
    case 'shirt': p(6, 13, 1, 1, shade(top, 1.25)); p(9, 13, 1, 1, shade(top, 1.25)); p(7, 14, 1, 1, topD); p(7, 16, 1, 1, topD); break;
    case 'cardigan': p(6, 13, 4, 6, c.inner ?? '#7d5a3c'); p(6, 13, 1, 6, top); p(9, 13, 1, 6, topD); p(7, 15, 1, 1, shade(top, 0.7)); break;
    case 'vest': p(4, 13, 8, 6, c.inner ?? '#f4f1ea'); p(4, 14, 3, 5, top); p(9, 14, 3, 5, topD); p(3, 13, 1, armsSide ? 5 : 3, c.inner ?? '#f4f1ea'); p(12, 13, 1, armsSide ? 5 : 3, shade(c.inner ?? '#f4f1ea', 0.9)); break;
    case 'blouse': p(6, 13, 4, 1, '#fbf4ee'); p(7, 14, 2, 1, '#fbf4ee'); p(7, 15, 2, 1, shade(top, 0.75)); break;
  }
  // 앉은 자세의 손: 타자(두 장면)·검토(문서)·쉼(무릎 위)
  if (pose === 'sit') { p(4, 16, 2, 1, top); p(10, 16, 2, 1, topD); p(5, 17, 1, 1, skin); p(10, 17, 1, 1, skinD); }
  if (pose === 'type') { p(4, 16, 2, 1, top); p(10, 16, 2, 1, topD); p(5, frame ? 17 : 16, 1, 1, skin); p(10, frame ? 16 : 17, 1, 1, skinD); }
  if (pose === 'review') { p(9, 13, 5, 6, '#fbf8f0'); p(10, 14, 3, 1, '#9aa1ad'); p(10, 16, 2, 1, '#9aa1ad'); p(12, 17, 1, 1, '#c2413b'); p(8, 16, 2, 1, skin); }
  // 3) 바지·신발(서 있을 때)
  if (!seated) { p(4, 19, 8, 3, c.pants); p(11, 19, 1, 3, shade(c.pants, 0.8)); p(7, 21, 2, 1, null as unknown as string); p(4, 22, 3, 1, '#3a2a1e'); p(9, 22, 3, 1, '#3a2a1e'); }
  // 4) 목·얼굴
  p(7, 12, 2, 1, skinD);
  p(4, 5, 8, 7, skin); p(11, 6, 1, 5, skinD); p(5, 11, 6, 1, skin);
  // 눈·입(쉬는 중이면 감은 눈)
  if (pose === 'rest') { p(5, 8, 2, 1, OUT); p(9, 8, 2, 1, OUT); } else { p(6, 8, 1, 1, OUT); p(9, 8, 1, 1, OUT); p(5, 9, 1, 1, shade(skin, 0.92)); p(10, 9, 1, 1, shade(skin, 0.92)); }
  p(7, 10, 2, 1, shade(skin, 0.7));
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
  const maxY = seated ? 20 : GH;
  const rects: Rect[] = [];
  for (let y = 0; y < maxY; y++) { let x = 0; while (x < GW) { const col = g[y][x]; if (!col) { x++; continue; } let w = 1; while (x + w < GW && g[y][x + w] === col) w++; rects.push([x, y, w, 1, col]); x += w; } }
  cache.set(key, rects);
  return rects;
}
export const CHAR_W = GW; export const CHAR_H = GH; export const SIT_H = 20;
