// 사무실의 시간대 분위기: 창밖 하늘, 햇빛 방향·세기, 실내 조명. 직원 상태(작업·대기·리뷰·휴가)는 바꾸지 않는다.
// 기준 시각 사이를 분 단위로 이어서(보간) 시간이 바뀌어도 갑자기 바뀌지 않게 한다.

export type TimeMode = 'auto' | 'morning' | 'afternoon' | 'evening' | 'night' | 'off';
export const TIME_MODES: { id: TimeMode; label: string; hour?: number }[] = [
  { id: 'auto', label: '현재 시간' },
  { id: 'morning', label: '아침', hour: 9 },
  { id: 'afternoon', label: '오후', hour: 14 },
  { id: 'evening', label: '저녁', hour: 18.6 },
  { id: 'night', label: '밤', hour: 22 },
  { id: 'off', label: '효과 끄기' },
];

export interface Mood {
  skyTop: string; skyBottom: string; // 창밖 하늘
  city: string; cityLights: number; // 건물 실루엣과 창문 불빛(0~1)
  sunLight: string; sunOpacity: number; sunShift: number; // 바닥에 비치는 햇빛(색·세기·기울기, 음수면 왼쪽)
  ambient: string; ambientOpacity: number; // 실내 전체에 덮는 빛 색
  lamp: number; // 스탠드·모니터 빛(0~1)
  label: string; // 아침·오후·저녁·밤
}

type Key = Omit<Mood, 'label'> & { h: number };
// 기준 시각(0~24시). 사이 시각은 앞뒤 기준을 섞는다.
const KEYS: Key[] = [
  { h: 0, skyTop: '#0b1430', skyBottom: '#1c2a52', city: '#0a1124', cityLights: 1, sunLight: '#ffffff', sunOpacity: 0, sunShift: 0, ambient: '#0d1638', ambientOpacity: 0.34, lamp: 1 },
  { h: 5, skyTop: '#18224a', skyBottom: '#3d4775', city: '#121a36', cityLights: 0.8, sunLight: '#ffd9a8', sunOpacity: 0, sunShift: 22, ambient: '#18214a', ambientOpacity: 0.26, lamp: 0.85 },
  { h: 7, skyTop: '#86b9e8', skyBottom: '#f4d8b0', city: '#5f7590', cityLights: 0.15, sunLight: '#fff0cf', sunOpacity: 0.32, sunShift: 22, ambient: '#ffe6c2', ambientOpacity: 0.08, lamp: 0.2 },
  { h: 10, skyTop: '#6eb0f0', skyBottom: '#d6ecff', city: '#6c829c', cityLights: 0, sunLight: '#fff6e2', sunOpacity: 0.3, sunShift: 12, ambient: '#ffffff', ambientOpacity: 0, lamp: 0 },
  { h: 13, skyTop: '#5aa6f2', skyBottom: '#cbe6ff', city: '#6d849f', cityLights: 0, sunLight: '#ffffff', sunOpacity: 0.26, sunShift: 0, ambient: '#ffffff', ambientOpacity: 0, lamp: 0 },
  { h: 16, skyTop: '#6eaee8', skyBottom: '#f2e0b6', city: '#6a7d96', cityLights: 0, sunLight: '#fff1d0', sunOpacity: 0.3, sunShift: -12, ambient: '#ffd9a0', ambientOpacity: 0.04, lamp: 0.05 },
  { h: 18.5, skyTop: '#6b58a8', skyBottom: '#f59a62', city: '#3f3a5c', cityLights: 0.45, sunLight: '#ffb06a', sunOpacity: 0.28, sunShift: -24, ambient: '#ff9a52', ambientOpacity: 0.14, lamp: 0.6 },
  { h: 20, skyTop: '#26295c', skyBottom: '#6e5486', city: '#1b1c3a', cityLights: 0.9, sunLight: '#ffb06a', sunOpacity: 0, sunShift: -24, ambient: '#1a1f4c', ambientOpacity: 0.26, lamp: 0.95 },
  { h: 24, skyTop: '#0b1430', skyBottom: '#1c2a52', city: '#0a1124', cityLights: 1, sunLight: '#ffffff', sunOpacity: 0, sunShift: 0, ambient: '#0d1638', ambientOpacity: 0.34, lamp: 1 },
];

function hex(c: string): [number, number, number] { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function mixColor(a: string, b: string, t: number) {
  const x = hex(a); const y = hex(b);
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}
const mixNum = (a: number, b: number, t: number) => a + (b - a) * t;

export function phaseLabel(h: number): string {
  if (h >= 5 && h < 11) return '아침';
  if (h >= 11 && h < 17) return '오후';
  if (h >= 17 && h < 20) return '저녁';
  return '밤';
}

/** 시각(0~24, 소수 = 분)에 맞는 분위기 */
export function moodAt(hour: number): Mood {
  const h = ((hour % 24) + 24) % 24;
  const i = KEYS.findIndex((k) => k.h > h);
  const b = KEYS[Math.max(1, i)]; const a = KEYS[Math.max(0, i - 1)];
  const t = b.h === a.h ? 0 : (h - a.h) / (b.h - a.h);
  return {
    skyTop: mixColor(a.skyTop, b.skyTop, t), skyBottom: mixColor(a.skyBottom, b.skyBottom, t),
    city: mixColor(a.city, b.city, t), cityLights: mixNum(a.cityLights, b.cityLights, t),
    sunLight: mixColor(a.sunLight, b.sunLight, t), sunOpacity: mixNum(a.sunOpacity, b.sunOpacity, t), sunShift: mixNum(a.sunShift, b.sunShift, t),
    ambient: mixColor(a.ambient, b.ambient, t), ambientOpacity: mixNum(a.ambientOpacity, b.ambientOpacity, t), lamp: mixNum(a.lamp, b.lamp, t),
    label: phaseLabel(h),
  };
}

/** 효과 끄기: 시간과 관계없는 밝은 낮 분위기(햇빛·조명 효과 없음) */
export const NEUTRAL: Mood = { ...moodAt(13), sunOpacity: 0, ambientOpacity: 0, lamp: 0, label: '' };

export function moodFor(mode: TimeMode, now: Date): { mood: Mood; hour: number } {
  if (mode === 'off') return { mood: NEUTRAL, hour: now.getHours() + now.getMinutes() / 60 };
  const fixed = TIME_MODES.find((m) => m.id === mode)?.hour;
  const hour = fixed ?? now.getHours() + now.getMinutes() / 60;
  return { mood: moodAt(hour), hour };
}
