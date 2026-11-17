// 사무실 그림 출력: 정수 배율, 무대 폭 채우기, 한 사람 한 자리(겹침 없음), 정수 좌표
import { describe, expect, it } from 'vitest';
import { char2, deskFront } from '../src/renderer/art';
import { CHARACTERS } from '../src/renderer/characters';
import { pickScale, placePeople, type Person, type Pose } from '../src/renderer/components/officeScene';

function people(poses: Pose[]): Person[] {
  return poses.map((pose, i) => ({ key: `k${i}`, agent: null, code: String(i).padStart(2, '0'), name: `n${i}`, role: '', char: CHARACTERS[i % 20], prop: 'plant', state: pose === 'off' ? 'off' : pose === 'rest' ? 'rest' : 'work', pose, task: '', since: null, external: false, blocked: [], blockedSteps: [], asks: false }));
}
const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w - 6 && b.x < a.x + a.w - 6 && a.y < b.y + b.h - 6 && b.y < a.y + a.h - 6;

describe('사무실 그림 출력', () => {
  it('배율×화소 비율은 늘 정수이고, 장면 폭은 무대 폭을 채운다(옆 여백은 배율 1칸 미만)', () => {
    for (const [w, h, dpr] of [[1226, 740, 1], [757, 620, 1], [757, 620, 2], [600, 480, 1], [1600, 900, 1], [1100, 700, 2]] as const) {
      const { scale, layout } = pickScale(w, h, dpr, 11, 1);
      expect(Number.isInteger(scale * dpr)).toBe(true);
      expect(w - layout.W * scale).toBeLessThan(Math.max(scale, 1) + 0.001);
      expect(w - layout.W * scale).toBeGreaterThanOrEqual(0);
    }
    expect(pickScale(1226, 740, 1, 11, 1).scale).toBe(2); // 1920 창(외부 모니터)
    expect(pickScale(757, 620, 2, 11, 1).scale).toBe(1.5); // 레티나 1440 창: 화소 3배
  });

  it('배율이 작아도 책상 이름표(22px)가 다음 줄 머리를 가리지 않는다', () => {
    for (const [w, h, dpr] of [[600, 392, 1], [1226, 740, 1], [757, 620, 2]] as const) {
      const { scale, layout } = pickScale(w, h, dpr, 12, 0);
      if (layout.rows < 2) continue;
      const tagBottom = layout.desks[0].y + 43 + 22 / scale; const nextHead = layout.desks[layout.cols].y - 8 + 1;
      expect(tagBottom).toBeLessThanOrEqual(nextHead);
    }
  });

  it('모두 쉬는 상태(12명)도 라운지에 한 사람 한 자리, 서로 겹치지 않는다', () => {
    const ps = people(Array(12).fill('rest'));
    const { layout } = pickScale(1226, 740, 1, 12, 0);
    const { placed, overflow } = placePeople(ps, ps, layout);
    expect(overflow.lounge).toBe(0);
    expect(new Set(placed.map((p) => p.p.key)).size).toBe(12);
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(overlap(placed[i], placed[j]), `${placed[i].p.key}/${placed[j].p.key}`).toBe(false);
  });

  it('섞인 상태: 일하는 사람은 자기 책상, 리뷰는 리뷰룸, 휴가는 지도에 앉히지 않는다', () => {
    const ps = people(['plan', 'code', 'doc', 'wait', 'reviewed', 'review', 'rest', 'rest', 'off']);
    const staff = ps.filter((p) => p.state !== 'off');
    const { layout } = pickScale(1226, 740, 1, staff.length, 1);
    const { placed } = placePeople(ps, staff, layout);
    const zone = (k: string) => placed.find((p) => p.p.key === k)?.zone;
    expect([zone('k0'), zone('k1'), zone('k2'), zone('k3')]).toEqual(['desk', 'desk', 'desk', 'desk']);
    expect([zone('k4'), zone('k5')]).toEqual(['review', 'review']);
    expect([zone('k6'), zone('k7')]).toEqual(['lounge', 'lounge']);
    expect(zone('k8')).toBeUndefined();
    for (const p of placed) { expect(Number.isInteger(p.x)).toBe(true); expect(Number.isInteger(p.y)).toBe(true); }
  });

  it('그림 자산 좌표는 모두 정수(가장자리가 고르게)', () => {
    for (const r of [...char2(CHARACTERS[0], 'type'), ...deskFront('code', 'clipboard', true)]) for (const v of r.slice(0, 4)) expect(Number.isInteger(v)).toBe(true);
  });
});
