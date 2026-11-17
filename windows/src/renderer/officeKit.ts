// 사무실 그림 키트: A안(예전 픽셀 감성)과 B안(현재 스타일 보완)이 같은 배치 규칙을 쓰도록 자리 묶음(스테이션)을 같은 모양으로 돌려준다.
// 좌표는 각 키트의 그림 칸 단위이며, 화면에서는 키트마다 정한 정수 배율로만 키운다.
import { beanbag, bookshelf2, char2, CHAR2_H, CHAR2_SIT_H, CHAR2_W, charSide, coffeeBar, deskFront, chairBack, flipX, floorLamp, laptop, plant2, podTable, SEAT_X, SEAT_Y, sharedScreen, SIDE_H, SIDE_W, sofaBack, sofaFront, STANDING_POSES, STATION_H, STATION_W, windowFrame, type ArtMod, type ArtPose, type Screen } from './art';
import { RETRO_H, RETRO_SIT_H, RETRO_W, retroBar, retroBean, retroChar, retroDesk, retroLamp, retroLaptop, retroPlant, retroScreen, retroShelf, retroSofa, retroTable, retroWindow, RS_SEAT } from './artRetro';
import type { CharDef } from './characters';
import type { Rect } from './pixel';

export type Piece = { r: Rect[]; x: number; y: number; sky?: { w: number; h: number } };
export type Slot = { x: number; y: number; poses: ArtPose[]; spot: string };
export type Station = { kind: string; w: number; h: number; back: Piece[]; front: Piece[]; slots: Slot[] };
export type Pod = { w: number; h: number; back: Piece[]; front: Piece[]; author: { x: number; y: number; side: boolean }; reviewers: { x: number; y: number }[]; laptops: { x: number; y: number }[] };
export type DeskKit = { w: number; h: number; seat: { x: number; y: number } };

export interface Kit {
  id: 'A' | 'B'; label: string; scale: number;
  cw: number; ch: number; sitH: number;
  person(c: CharDef, pose: ArtPose, mod?: ArtMod, frame?: number): Rect[];
  /** 리뷰받는 직원(탁자 왼쪽 끝): 옆모습이 있으면 옆모습, 없으면 오른쪽을 보는 앞모습 */
  author(c: CharDef, mod?: ArtMod): { r: Rect[]; w: number; h: number };
  station(kind: 'nook' | 'sofa' | 'bar' | 'window' | 'arm' | 'bean'): Station;
  pod(reviewers: number, laptopsAt: number[]): Pod;
  desk: DeskKit;
  deskBack(empty: boolean): Rect[];
  deskFront(screen: Screen, prop: string, i: number): Rect[];
  laptop(): Rect[];
}

// ───── B안 ─────
const B: Kit = {
  id: 'B', label: 'B안 · 현재 스타일 보완', scale: 2, cw: CHAR2_W, ch: CHAR2_H, sitH: CHAR2_SIT_H,
  person: (c, pose, mod = '', frame = 0) => char2(c, pose, frame, mod),
  author: (c, mod = '') => ({ r: charSide(c, 'sit').length && mod === 'blink' ? charSide(c, 'sit') : charSide(c, 'sit'), w: SIDE_W, h: SIDE_H }),
  station(kind) {
    switch (kind) {
      case 'nook': return { kind, w: 112, h: 60, back: [{ r: bookshelf2(40), x: 0, y: 4 }, { r: floorLamp(), x: 94, y: 0 }, { r: sofaBack(1, '#5b8f6a'), x: 46, y: 22 }], front: [{ r: sofaFront(1, '#5b8f6a'), x: 46, y: 22 }], slots: [{ x: 49, y: 8, poses: ['read', 'cup'], spot: '책 읽는 자리' }] };
      case 'sofa': return { kind, w: 106, h: 54, back: [{ r: sofaBack(3), x: 0, y: 16 }], front: [{ r: sofaFront(3), x: 0, y: 16 }], slots: [0, 2, 1].map((k) => ({ x: 6 + k * 30 + 15 - 17, y: 2, poses: (k === 1 ? ['rest', 'cup'] : k === 0 ? ['cup', 'rest', 'read'] : ['read', 'rest']) as ArtPose[], spot: '소파' })) };
      case 'bar': return { kind, w: 76, h: 90, back: [{ r: coffeeBar(72), x: 0, y: 0 }], front: [], slots: [{ x: 2, y: 40, poses: ['standcup'], spot: '커피 공간' }, { x: 38, y: 40, poses: ['stand', 'standcup'], spot: '커피 공간' }] };
      case 'window': return { kind, w: 82, h: 90, back: [{ r: windowFrame(62, 38), x: 0, y: 0, sky: { w: 62, h: 38 } }, { r: plant2(true), x: 48, y: 50 }], front: [], slots: [{ x: 4, y: 40, poses: ['stretch', 'standcup'], spot: '창가' }, { x: 42, y: 40, poses: ['standcup', 'stand'], spot: '창가' }] };
      case 'arm': return { kind, w: 46, h: 54, back: [{ r: sofaBack(1, '#c8643c'), x: 0, y: 16 }], front: [{ r: sofaFront(1, '#c8643c'), x: 0, y: 16 }], slots: [{ x: 3, y: 2, poses: ['cup', 'rest'], spot: '개별 의자' }] };
      case 'bean': return { kind, w: 44, h: 46, back: [{ r: beanbag('#d08a3c', 'back'), x: 0, y: 16 }], front: [{ r: beanbag('#d08a3c', 'front'), x: 0, y: 16 }], slots: [{ x: 4, y: 4, poses: ['read', 'rest'], spot: '빈백' }] };
    }
  },
  pod(n, laptopsAt) {
    const tw = Math.max(46, 16 + n * 30);
    const reviewers = Array.from({ length: n }, (_, i) => ({ x: 28 + 8 + i * 30 - 2, y: 6 }));
    return {
      w: 28 + tw + 50, h: 72,
      back: [{ r: sharedScreen(), x: 28 + tw + 4, y: 10 }],
      front: [{ r: podTable(tw), x: 28, y: 38 }],
      author: { x: 0, y: 14, side: true }, reviewers,
      laptops: laptopsAt.map((i) => ({ x: reviewers[i].x + 8, y: 28 })),
    };
  },
  desk: { w: STATION_W, h: STATION_H, seat: { x: SEAT_X, y: SEAT_Y } },
  deskBack: (empty) => chairBack(empty),
  deskFront: (screen, prop, i) => deskFront(screen, prop as never, i % 3 !== 1),
  laptop: () => laptop(),
};

// ───── A안 ─────
const A: Kit = {
  id: 'A', label: 'A안 · 예전 픽셀 감성', scale: 3, cw: RETRO_W, ch: RETRO_H, sitH: RETRO_SIT_H,
  person: (c, pose, mod = '', frame = 0) => retroChar(c, pose, frame, mod),
  author: (c, mod = '') => ({ r: retroChar(c, 'sit', 0, mod || 'glanceR'), w: RETRO_W, h: RETRO_SIT_H }),
  station(kind) {
    switch (kind) {
      case 'nook': return { kind, w: 56, h: 32, back: [{ r: retroShelf(), x: 0, y: 2 }, { r: retroLamp(), x: 46, y: 0 }, { r: retroSofa(1, '#5b8f6a', 'back'), x: 24, y: 10 }], front: [{ r: retroSofa(1, '#5b8f6a', 'front'), x: 24, y: 10 }], slots: [{ x: 25, y: 3, poses: ['read', 'cup'], spot: '책 읽는 자리' }] };
      case 'sofa': return { kind, w: 54, h: 30, back: [{ r: retroSofa(3, '#2e6b6e', 'back'), x: 0, y: 8 }], front: [{ r: retroSofa(3, '#2e6b6e', 'front'), x: 0, y: 8 }], slots: [0, 2, 1].map((k) => ({ x: 3 + k * RS_SEAT + 7 - 9, y: 1, poses: (k === 1 ? ['rest', 'cup'] : k === 0 ? ['cup', 'rest', 'read'] : ['read', 'rest']) as ArtPose[], spot: '소파' })) };
      case 'bar': return { kind, w: 40, h: 46, back: [{ r: retroBar(), x: 0, y: 0 }], front: [], slots: [{ x: 1, y: 20, poses: ['standcup'], spot: '커피 공간' }, { x: 20, y: 20, poses: ['stand', 'standcup'], spot: '커피 공간' }] };
      case 'window': return { kind, w: 42, h: 46, back: [{ r: retroWindow(), x: 0, y: 0, sky: { w: 34, h: 22 } }, { r: retroPlant(), x: 27, y: 24 }], front: [], slots: [{ x: 1, y: 20, poses: ['stretch', 'standcup'], spot: '창가' }, { x: 21, y: 20, poses: ['standcup', 'stand'], spot: '창가' }] };
      case 'arm': return { kind, w: 24, h: 30, back: [{ r: retroSofa(1, '#c8643c', 'back'), x: 0, y: 8 }], front: [{ r: retroSofa(1, '#c8643c', 'front'), x: 0, y: 8 }], slots: [{ x: 1, y: 1, poses: ['cup', 'rest'], spot: '개별 의자' }] };
      case 'bean': return { kind, w: 24, h: 26, back: [{ r: retroBean('#d08a3c', 'back'), x: 0, y: 8 }], front: [{ r: retroBean('#d08a3c', 'front'), x: 0, y: 8 }], slots: [{ x: 3, y: 2, poses: ['read', 'rest'], spot: '빈백' }] };
    }
  },
  pod(n, laptopsAt) {
    const tw = Math.max(26, 8 + n * 17);
    const reviewers = Array.from({ length: n }, (_, i) => ({ x: 18 + 4 + i * 17, y: 2 }));
    return {
      w: 18 + tw + 30, h: 36,
      back: [{ r: retroScreen(), x: 18 + tw + 2, y: 4 }],
      front: [{ r: retroTable(tw), x: 18, y: 20 }],
      author: { x: 0, y: 4, side: false }, reviewers,
      laptops: laptopsAt.map((i) => ({ x: reviewers[i].x + 3, y: 14 })),
    };
  },
  desk: { w: 50, h: 38, seat: { x: 17, y: 1 } },
  deskBack: (empty) => retroDesk('back', 'off', empty),
  deskFront: (screen) => retroDesk('front', screen as never, false),
  laptop: () => retroLaptop(),
};

export const KITS = { A, B };
export const isStanding = (p: ArtPose) => STANDING_POSES.includes(p);
export { flipX };
