// 사용량 속도 조절 시험 — CLI가 알려 준 주간·5시간 사용률로 새 사이클 시작을 미룬다
import { afterEach, describe, expect, it } from 'vitest';
import { interpretLine, type StreamSink } from '../src/main/cli/claudeCli';
import { DEFAULT_PACE, WEEK_MS, noteRateLimit, paceDecision, resetUsageForTest, usageSnapshot } from '../src/main/pace';
import type { Mission } from '../src/shared/types';
import { gitInit, mkService, plan, sleep, tmpProject } from './helpers';

const H = 3600 * 1000;
const snap = (week: number, weekLeftH: number, five = 0.1, now = Date.now()) => ({
  sevenDay: { utilization: week, resetsAt: now + weekLeftH * H }, fiveHour: { utilization: five, resetsAt: now + 2 * H }, at: now,
});
afterEach(() => resetUsageForTest());

describe('사용률 받기', () => {
  it('CLI의 rate_limit_event에서 주간·5시간 사용률과 초기화 시각(ms)을 읽는다', () => {
    const sink: StreamSink = { sessionId: null, result: null, limit: null };
    interpretLine(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.84, resetsAt: 1900000000,
      unifiedWindows: { five_hour: { utilization: 0.71, resetsAt: 1899990000, status: 'allowed' }, seven_day: { utilization: 0.84, resetsAt: 1900000000, status: 'allowed_warning' } } } }), sink);
    const s = usageSnapshot()!;
    expect(s.sevenDay).toEqual({ utilization: 0.84, resetsAt: 1900000000 * 1000 });
    expect(s.fiveHour).toEqual({ utilization: 0.71, resetsAt: 1899990000 * 1000 });
    expect(sink.limit).toBeNull(); // 경고는 한도 도달이 아니다
  });
  it('사용률이 없는 이벤트는 무시하고, 한쪽 창만 오면 다른 창은 이전 값을 유지한다', () => {
    expect(noteRateLimit({ status: 'rejected', resetsAt: 1900000000 })).toBeNull();
    noteRateLimit({ unifiedWindows: { seven_day: { utilization: 0.3, resetsAt: 1900000000 }, five_hour: { utilization: 0.2, resetsAt: 1899990000 } } });
    noteRateLimit({ rateLimitType: 'five_hour', utilization: 0.5, resetsAt: 1899999000 });
    expect(usageSnapshot()!.sevenDay!.utilization).toBe(0.3);
    expect(usageSnapshot()!.fiveHour!.utilization).toBe(0.5);
  });
});

describe('속도 판단', () => {
  const now = Date.now();
  it('사용률을 모르면 막지 않는다(첫 호출로 값을 받음)', () => {
    expect(paceDecision(null, now).wait).toBe(false);
  });
  it('주간 창에서 지난 시간 비율만큼은 쓴다: 주 중간(3.5일 지남)에 40%면 그대로 진행', () => {
    expect(paceDecision(snap(0.4, 84, 0.1, now), now).wait).toBe(false);
  });
  it('앞서 있으면 쓸 몫이 따라잡는 시각까지 기다린다(초기화 전)', () => {
    // 5일 지남(쓸 몫 ≈ 0.9×5/7+0.05 ≈ 69%), 사용 84% → 기다림
    const d = paceDecision(snap(0.84, 48, 0.1, now), now);
    expect(d.wait).toBe(true);
    if (!d.wait) return;
    const start = now + 48 * H - WEEK_MS;
    expect(d.until).toBeCloseTo(start + ((0.84 - DEFAULT_PACE.headStart) / 0.9) * WEEK_MS, -3);
    expect(d.until).toBeLessThan(now + 48 * H);
    expect(d.reason).toContain('84%');
  });
  it('앱 몫(100%−남길 몫)을 다 쓰면 주간 초기화까지 기다린다', () => {
    const d = paceDecision(snap(0.92, 30, 0.1, now), now);
    expect(d.wait && d.until).toBe(now + 30 * H + 60 * 1000);
  });
  it('주간 80% 전에는 시간 비율보다 앞서도 조절하지 않는다', () => {
    expect(paceDecision(snap(0.08, 167, 0.1, now), now).wait).toBe(false);
    expect(paceDecision(snap(0.79, 150, 0.1, now), now).wait).toBe(false);
    const d = paceDecision(snap(0.81, 150, 0.1, now), now);
    expect(d.wait).toBe(true);
  });
  it('조절 시작을 0으로 두면 주 초반부터 나눠 쓴다(5%는 바로 허용)', () => {
    const o = { ...DEFAULT_PACE, startAt: 0 };
    expect(paceDecision(snap(0.03, 167, 0.1, now), now, o).wait).toBe(false);
    expect(paceDecision(snap(0.08, 167, 0.1, now), now, o).wait).toBe(true);
  });
  it('남길 몫을 크게 잡으면 더 일찍 멈춘다', () => {
    expect(paceDecision(snap(0.6, 24, 0.1, now), now).wait).toBe(false);
    expect(paceDecision(snap(0.6, 24, 0.1, now), now, { ...DEFAULT_PACE, reserve: 0.4 }).wait).toBe(true);
  });
  it('5시간 사용률이 90% 이상이면 그 창이 풀릴 때까지 쉰다', () => {
    const d = paceDecision(snap(0.1, 150, 0.93, now), now);
    expect(d.wait && d.until).toBe(now + 2 * H + 60 * 1000);
  });
  it('주간 창이 이미 초기화됐으면 막지 않는다', () => {
    expect(paceDecision(snap(0.99, -1, 0.1, now), now).wait).toBe(false);
  });
});

describe('미션 속도 조절', () => {
  async function until<T>(f: () => T | null | undefined | false, ms = 60000): Promise<T> {
    const t0 = Date.now();
    for (;;) { const v = f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('시간 초과'); await sleep(50); }
  }
  it('쓸 몫보다 앞서 있으면 사이클을 시작하지 않고 속도 조절 대기로 표시하며, 지금 다시 시도로 앞당기거나 설정을 끄면 진행한다', async () => {
    const dir = tmpProject(); gitInit(dir); const svc = mkService(dir);
    const p = svc.createProject(plan(dir, { writablePaths: ['docs'] }));
    svc.loadAgentTemplates(p.id);
    noteRateLimit({ unifiedWindows: { seven_day: { utilization: 0.95, resetsAt: Math.floor((Date.now() + 10 * H) / 1000) }, five_hour: { utilization: 0.1, resetsAt: Math.floor((Date.now() + H) / 1000) } } });
    expect(svc.usagePace().waiting).toBe(true);
    const m0 = await svc.startMission(p.id, '문서를 정리하라');
    const w = await until(() => { const m = svc.missions.get(m0.id); return m.limitWait?.source === 'pace' ? m : null; });
    expect(w.limitUntil).not.toBeNull();
    expect(w.currentRunId ?? null).toBeNull(); // 오퍼레이터·직원을 부르지 않았다
    await sleep(300);
    expect(svc.missions.get(m0.id).currentRunId ?? null).toBeNull();
    // 설정을 끄고 지금 다시 시도 → 진행
    svc.saveSettings({ paceEnabled: false });
    expect(svc.usagePace().waiting).toBe(false);
    svc.missions.retryLimitNow(m0.id);
    const ran = await until(() => { const m = svc.missions.get(m0.id); return m.currentRunId || ['waiting_user', 'done'].includes(m.status) ? m : null; });
    expect(ran.limitWait?.source).not.toBe('pace');
    await svc.missions.stop(m0.id);
    svc.close();
  });
  it('남길 몫 설정은 0~50%로 저장된다', () => {
    const dir = tmpProject(); const svc = mkService(dir);
    expect(svc.saveSettings({ paceReservePct: 80 }).paceReservePct).toBe(50);
    expect(svc.saveSettings({ paceReservePct: -3 }).paceReservePct).toBe(0);
    expect(svc.settings().paceEnabled).not.toBe(false); // 기본 켬
    svc.close();
  });
});

export type _M = Mission;
