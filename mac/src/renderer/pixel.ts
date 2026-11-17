// 도트 그림 그리기 도구: 칸(픽셀) 격자에 모양(사각형·둥근 사각형·타원·선)을 칠하고, 바깥 테두리와 빛(왼쪽 위)·그늘(오른쪽 아래)을 자동으로 넣은 뒤
// 가로로 이어진 같은 색 칸을 묶어 SVG 사각형 목록으로 만든다. 좌표는 모두 정수(화면에서 정수 배율로만 확대해 가장자리가 고르게 보이게).
export type Rect = [number, number, number, number, string];

export function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(k >= 1 ? v + (255 - v) * (k - 1) : v * k)));
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => f(v).toString(16).padStart(2, '0')).join('')}`;
}
export function mix(a: string, b: string, t: number): string {
  const x = parseInt(a.slice(1), 16); const y = parseInt(b.slice(1), 16);
  const c = (s: number) => Math.round(((x >> s) & 255) + (((y >> s) & 255) - ((x >> s) & 255)) * t);
  return `#${[c(16), c(8), c(0)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

export class Grid {
  readonly px: (string | null)[][];
  private tag: (string | null)[][]; // 칸마다 어느 부분인지(그늘·빛을 부분별로 넣기 위해)
  constructor(readonly w: number, readonly h: number) {
    this.px = Array.from({ length: h }, () => Array(w).fill(null));
    this.tag = Array.from({ length: h }, () => Array(w).fill(null));
  }
  set(x: number, y: number, c: string | null, tag: string | null = null) {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.px[y][x] = c; this.tag[y][x] = c ? tag : null;
  }
  get(x: number, y: number) { return x < 0 || y < 0 || x >= this.w || y >= this.h ? null : this.px[y][x]; }
  tagAt(x: number, y: number) { return x < 0 || y < 0 || x >= this.w || y >= this.h ? null : this.tag[y][x]; }
  rect(x: number, y: number, w: number, h: number, c: string, tag: string | null = null) { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, c, tag); }
  /** 둥근 사각형(r: 모서리 반지름 칸 수) */
  rrect(x: number, y: number, w: number, h: number, r: number, c: string, tag: string | null = null) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const cx = i < r ? r - i - 0.5 : i >= w - r ? i - (w - r) + 0.5 : 0;
      const cy = j < r ? r - j - 0.5 : j >= h - r ? j - (h - r) + 0.5 : 0;
      if (cx * cx + cy * cy <= r * r + 0.3) this.set(x + i, y + j, c, tag);
    }
  }
  /** 타원(왼쪽 위 x,y와 너비·높이로) */
  ellipse(x: number, y: number, w: number, h: number, c: string, tag: string | null = null) {
    const rx = w / 2; const ry = h / 2;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const dx = (i + 0.5 - rx) / rx; const dy = (j + 0.5 - ry) / ry;
      if (dx * dx + dy * dy <= 1.02) this.set(x + i, y + j, c, tag);
    }
  }
  hline(x: number, y: number, w: number, c: string, tag: string | null = null) { this.rect(x, y, w, 1, c, tag); }
  vline(x: number, y: number, h: number, c: string, tag: string | null = null) { this.rect(x, y, 1, h, c, tag); }
  /** 같은 부분(tag)의 오른쪽·아래 가장자리를 어둡게, 왼쪽·위를 밝게(빛은 왼쪽 위) */
  light(tag: string, dark = 0.8, lite = 1.12, width = 1) {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (this.tag[y][x] !== tag || !this.px[y][x]) continue;
      const c = this.px[y][x]!;
      const edge = (dx: number, dy: number) => { for (let k = 1; k <= width; k++) if (this.tag[y + dy * k]?.[x + dx * k] !== tag) return true; return false; };
      if (edge(1, 0) || edge(0, 1)) this.px[y][x] = shade(c, dark);
      else if (edge(-1, 0) || edge(0, -1)) this.px[y][x] = shade(c, lite);
    }
  }
  /** 칠한 칸 바깥에 테두리(빈칸 중 칠한 칸과 맞닿은 곳) */
  outline(c: string) {
    const out: [number, number][] = [];
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) if (!this.px[y][x] && ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).some(([dx, dy]) => this.get(x + dx, y + dy))) out.push([x, y]);
    for (const [x, y] of out) this.set(x, y, c, 'outline');
  }
  /** 부분끼리 맞닿은 곳에 안쪽 경계선(예: 머리와 얼굴 사이) */
  seam(tagA: string, tagB: string, c: string) {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) if (this.tag[y][x] === tagA && ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).some(([dx, dy]) => this.tag[y + dy]?.[x + dx] === tagB)) this.px[y][x] = c;
  }
  toRects(maxY = this.h, ox = 0, oy = 0): Rect[] {
    const rects: Rect[] = [];
    for (let y = 0; y < Math.min(maxY, this.h); y++) { let x = 0; while (x < this.w) { const col = this.px[y][x]; if (!col) { x++; continue; } let w = 1; while (x + w < this.w && this.px[y][x + w] === col) w++; rects.push([x + ox, y + oy, w, 1, col]); x += w; } }
    return rects;
  }
}

/** 같은 색 사각형을 한 경로로 묶는다(SVG 요소 수를 줄여 화면 갱신을 가볍게) */
const pathMemo = new WeakMap<Rect[], { fill: string; d: string }[]>();
export function toPaths(rects: Rect[]): { fill: string; d: string }[] {
  const hit = pathMemo.get(rects); if (hit) return hit;
  const by = new Map<string, string[]>();
  for (const [x, y, w, h, c] of rects) { let a = by.get(c); if (!a) { a = []; by.set(c, a); } a.push(`M${x} ${y}h${w}v${h}h${-w}z`); }
  const out = [...by].map(([fill, parts]) => ({ fill, d: parts.join('') }));
  pathMemo.set(rects, out); return out;
}
