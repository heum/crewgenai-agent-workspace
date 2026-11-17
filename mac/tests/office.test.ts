// 사무실 그림(A안) 배치: 정수 배율, 무대 폭 채우기, 휴식 인원별 자리(겹침 없음·누락 없음), 작업별 리뷰 그룹
import { describe, expect, it } from 'vitest';
import { CHARACTERS } from '../src/renderer/characters';
import { pickScale, placePeople, type Person, type Pose } from '../src/renderer/components/officeScene';
import { retroChar } from '../src/renderer/artRetro';

function people(poses: Pose[], reviewOf: (string | null)[] = []): Person[] {
  return poses.map((pose, i) => ({ key: `k${i}`, agent: null, code: String(i).padStart(2, '0'), name: `n${i}`, role: '', char: CHARACTERS[i % 20], prop: 'plant', state: pose === 'off' ? 'off' : pose === 'rest' ? 'rest' : pose === 'review' || pose === 'reviewed' ? 'review' : 'work', pose, task: reviewOf[i] ? `작업${reviewOf[i]!.slice(1)}` : `작업${i}`, since: null, external: false, blocked: [], blockedSteps: [], asks: false, reviewOf: reviewOf[i] ?? null }));
}
type R = { x: number; y: number; w: number; h: number };
const overlap = (a: R, b: R) => a.x < b.x + b.w - 3 && b.x < a.x + a.w - 3 && a.y < b.y + b.h - 3 && b.y < a.y + a.h - 3; // 소파에서 어깨 테두리가 닿는 정도(3칸)는 겹침이 아님
const noOverlap = (rs: (R & { p: { key: string } })[]) => { for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) expect(overlap(rs[i], rs[j]), `${rs[i].p.key}/${rs[j].p.key}`).toBe(false); };

describe('사무실 그림 출력(A안)', () => {
  it('배율×화소 비율은 늘 정수, 장면 폭은 무대 폭을 채운다. 1920 창 3배, 좁은 창은 2배', () => {
    for (const [w, h, dpr] of [[1226, 740, 1], [757, 640, 1], [757, 620, 2], [600, 480, 1], [1600, 900, 1]] as const) {
      const { scale, layout } = pickScale(w, h, dpr, 11, 1);
      expect(Number.isInteger(scale * dpr)).toBe(true);
      expect(w - layout.W * scale).toBeLessThan(scale + 0.001);
    }
    expect(pickScale(1226, 740, 1, 11, 1).scale).toBe(3);
    expect(pickScale(600, 480, 1, 11, 1).scale).toBe(2);
  });

  for (const n of [0, 1, 2, 6, 12, 16, 24]) {
    it(`휴식 ${n}명: 겹치지 않고, 앉지 못한 사람은 '자리 밖' 목록에 남는다(누락 없음)`, () => {
      const ps = people(Array(n).fill('rest'));
      const { layout } = pickScale(1226, 740, 1, Math.max(n, 12), 0);
      const plan = placePeople(ps, ps, layout);
      const seated = plan.placed.filter((x) => x.zone === 'lounge');
      expect(seated.length + plan.overflow.lounge.length).toBe(n);
      expect(new Set([...seated.map((x) => x.p.key), ...plan.overflow.lounge.map((p) => p.key)]).size).toBe(n);
      noOverlap(seated);
      for (const s of seated) { expect(s.x).toBeGreaterThanOrEqual(layout.lounge.x); expect(s.x + s.w).toBeLessThanOrEqual(layout.lounge.x + layout.lounge.w + 1); expect(s.y + s.h).toBeLessThanOrEqual(layout.H); }
      if (n >= 6) expect(new Set(seated.map((s) => s.spot)).size).toBeGreaterThanOrEqual(4); // 소파 한 곳에 몰리지 않음
      if (n >= 6) expect(new Set(seated.map((s) => s.pose)).size).toBeGreaterThanOrEqual(3); // 자세가 서로 다름
    });
  }

  it('리뷰: 같은 작업(리뷰받는 직원)의 참여자는 같은 그룹, 여러 건은 그룹끼리 겹치지 않고 누락 없음', () => {
    // k0←k1,k2 / k3←k4 / k5←k6, k7은 대상 없는 검토
    const ps = people(['reviewed', 'review', 'review', 'reviewed', 'review', 'reviewed', 'review', 'review', 'rest'], [null, 'k0', 'k0', null, 'k3', null, 'k5', null]);
    const { layout } = pickScale(1226, 740, 1, 9, 0, [2, 1, 1, 1]);
    const plan = placePeople(ps, ps, layout);
    const g = (k: string) => plan.placed.find((x) => x.p.key === k)?.group;
    const inGroup = (k: string) => g(k) ?? plan.groups.find((x) => x.author?.key === k || x.reviewers.some((r) => r.key === k))?.key;
    expect(inGroup('k1')).toBe(inGroup('k0')); expect(inGroup('k2')).toBe(inGroup('k0')); expect(inGroup('k4')).toBe(inGroup('k3')); expect(inGroup('k6')).toBe(inGroup('k5'));
    expect(inGroup('k0')).not.toBe(inGroup('k3'));
    const reviewKeys = ['k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7'];
    const shown = plan.placed.filter((x) => x.zone === 'review').map((x) => x.p.key);
    expect(new Set([...shown, ...plan.overflow.review.map((p) => p.key)])).toEqual(new Set(reviewKeys));
    const pods = plan.review.pods.map((p) => ({ x: p.x, y: p.y, w: p.pod.w, h: p.pod.h, p: { key: p.key } }));
    noOverlap(pods);
    for (const p of pods) { expect(p.x + p.w).toBeLessThanOrEqual(layout.review.x + layout.review.w); expect(p.y + p.h).toBeLessThanOrEqual(layout.H); }
  });

  it('같은 직원이 두 작업을 동시에 검토받으면 작업별로 다른 그룹, 그 직원은 한 번만 그린다', () => {
    const ps = people(['reviewed', 'review', 'review'], [null, 'k0', 'k0']);
    ps[1].task = 'A작업'; ps[2].task = 'B작업'; ps[0].task = '독립 검토를 받는 중: A작업';
    const { layout } = pickScale(1226, 740, 1, 3, 0, [1, 1]);
    const plan = placePeople(ps, ps, layout);
    expect(plan.groups.map((g) => g.task).sort()).toEqual(['A작업', 'B작업']);
    expect(plan.placed.filter((x) => x.p.key === 'k0').length).toBe(1);
    expect(plan.groups.find((g) => g.task === 'A작업')!.author?.key).toBe('k0');
  });

  it('리뷰 그룹이 두 줄이면 이름표 높이만큼 띄운다', () => {
    const ps = people(['reviewed', 'review', 'reviewed', 'review', 'reviewed', 'review', 'reviewed', 'review'], [null, 'k0', null, 'k2', null, 'k4', null, 'k6']);
    const { scale, layout } = pickScale(600, 480, 1, 8, 0, [1, 1, 1, 1]);
    const plan = placePeople(ps, ps, layout);
    const pods = plan.review.pods;
    for (const a of pods) for (const b of pods) if (b.y > a.y) expect(a.y + a.pod.h + 1 + 22 / scale).toBeLessThanOrEqual(b.y + 2);
  });

  it('참여자 많은 리뷰 1건: 탁자에 못 앉은 검토자는 그룹 목록(+N)에 남는다', () => {
    const ps = people(['reviewed', ...Array(9).fill('review')], [null, ...Array(9).fill('k0')]);
    const { layout } = pickScale(1226, 740, 1, 10, 0, [9]);
    const plan = placePeople(ps, ps, layout);
    const shown = plan.placed.filter((x) => x.zone === 'review').length;
    expect(shown + plan.overflow.review.length).toBe(10);
    // 리뷰룸이 참여자 수만큼 넓어져 5명 그룹은 모두 앉는다
    const five = people(['reviewed', ...Array(5).fill('review')], [null, ...Array(5).fill('k0')]);
    const L5 = pickScale(1226, 740, 1, 12, 0, [5]).layout;
    const p5 = placePeople(five, five, L5);
    expect(p5.overflow.review.length).toBe(0);
  });

  it('그림 자산 좌표는 모두 정수, 작은 동작 그림도 같은 크기', () => {
    for (const mod of ['', 'blink', 'glanceL', 'sip', 'wave'] as const) for (const r of retroChar(CHARACTERS[0], 'cup', 0, mod)) for (const v of r.slice(0, 4)) expect(Number.isInteger(v)).toBe(true);
  });
});
