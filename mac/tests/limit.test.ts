// 사용 한도(플랜 사용량 제한) 도달 시험 — 모의 CLI가 rate_limit_event(rejected)와 is_error 결과로 한 번 한도에 걸린다
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Mission } from '../src/shared/types';
import { claudeLimit, codexLimit, interpretLine, type StreamSink } from '../src/main/cli/claudeCli';
import { gitInit, mkService, plan, sleep, tmpProject } from './helpers';

async function until<T>(f: () => T | null | undefined | false, ms = 60000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('시간 초과'); await sleep(50); }
}
function setup(extra: Parameters<typeof mkService>[2] = {}) {
  const dir = tmpProject(); gitInit(dir); const svc = mkService(dir, [], extra);
  const p = svc.createProject(plan(dir, { writablePaths: ['docs'] }));
  svc.loadAgentTemplates(p.id);
  return { dir, svc, p };
}
const fin = (svc: ReturnType<typeof mkService>, id: string, sts: Mission['status'][]) => until(() => { const m = svc.missions.get(id); return sts.includes(m.status) ? m : null; });

describe('사용 한도 감지', () => {
  it('rate_limit_event rejected + 오류 결과면 한도로 보고, 해제 시각을 ms로 읽는다', () => {
    const sink: StreamSink = { sessionId: null, result: null, limit: null };
    const ev = interpretLine(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1900000000, rateLimitType: 'five_hour' } }), sink);
    expect(ev?.summary).toContain('rejected');
    interpretLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit" }), sink);
    expect(claudeLimit(sink, 1)).toEqual({ resetsAt: 1900000000 * 1000, text: expect.stringContaining('five_hour') });
  });
  it('한도 경고가 있었어도 결과가 성공이면 한도로 보지 않는다', () => {
    const sink: StreamSink = { sessionId: null, result: null, limit: null };
    interpretLine(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1900000000 } }), sink);
    interpretLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '완료' }), sink);
    expect(claudeLimit(sink, 0)).toBeNull();
  });
  it('이벤트 없이 결과 문구만 있어도 한도로 본다(해제 시각 미상)', () => {
    const sink: StreamSink = { sessionId: null, result: null, limit: null };
    interpretLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached' }), sink);
    expect(claudeLimit(sink, 1)?.resetsAt).toBeNull();
    const other: StreamSink = { sessionId: null, result: null, limit: null };
    interpretLine(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '파일을 찾지 못했습니다' }), other);
    expect(claudeLimit(other, 1)).toBeNull();
  });
  it('Codex는 실패 종료 + 오류 출력의 한도 문구만 본다', () => {
    expect(codexLimit("ERROR: You've hit your usage limit. Try again later.", 1)?.text).toContain('usage limit');
    expect(codexLimit('rate limit 처리 코드 검토', 0)).toBeNull();
    expect(codexLimit('stream disconnected', 1)).toBeNull();
  });
});

describe('사용 한도 도달 시 미션', () => {
  it('오퍼레이터·담당 작업이 한도에 걸리면 실패로 처리하지 않고, 해제 후 같은 세션을 이어서 끝까지 진행한다', async () => {
    const { svc, p } = setup({ limitGraceMs: 0 });
    const tag = randomUUID().slice(0, 8);
    const m0 = await svc.startMission(p.id, `[[mock:limit-once:${tag}]] 문서를 정리하라`);
    const m = await fin(svc, m0.id, ['done', 'waiting_user', 'failed']);
    expect(m.status).toBe('done');
    expect(m.limitUntil ?? null).toBeNull();
    const d = svc.missions.detail(m.id);
    const texts = d.events.map((e) => e.text).join('\n');
    expect(texts).toContain('오퍼레이터 호출이 사용 한도에 걸렸습니다');
    expect(texts).toContain('사용 한도 도달 —');
    expect(d.cycles[0].status).toBe('succeeded');
    const r1 = svc.engine.detail(d.cycles[0].runId);
    const authors = r1.attempts.filter((a) => a.role === 'author');
    expect(authors[0].status).toBe('interrupted');
    expect(authors[0].error).toContain('사용 한도');
    expect(authors[1].status).toBe('succeeded');
    expect(authors[1].sessionId).toBe(authors[0].sessionId); // 같은 세션을 이어서 작업(새로 처음부터 하지 않음)
    expect(authors.length).toBe(2); // 한도 상태에서 재시도로 더 소모하지 않는다
    expect(svc.engine.limitOf(r1.run.id)).toBeNull();
    svc.close();
  });

  it("해제 시각 전에 '지금 다시 시도'하면 바로 이어서 진행한다(오퍼레이터 대기·실행 대기 모두)", async () => {
    const { svc, p } = setup({ limitGraceMs: 10 * 60_000 });
    const tag = randomUUID().slice(0, 8);
    const m0 = await svc.startMission(p.id, `[[mock:limit-once:${tag}]] 문서를 정리하라`);
    await until(() => svc.missions.get(m0.id).limitUntil);
    expect(svc.missions.get(m0.id).currentRunId).toBeNull(); // 오퍼레이터 계획 단계에서 대기
    svc.missions.retryLimitNow(m0.id);
    const runId = await until(() => { const m = svc.missions.get(m0.id); return m.currentRunId && svc.engine.limitOf(m.currentRunId) ? m.currentRunId : null; });
    await until(() => svc.missions.get(m0.id).limitUntil);
    expect(svc.store.getRun(runId).status).toBe('needs_resume');
    expect(svc.store.getRun(runId).reason).toContain('사용 한도 도달');
    expect(svc.missions.get(m0.id).status).toBe('running'); // 실패·판단으로 넘어가지 않고 기다린다
    svc.missions.retryLimitNow(m0.id);
    const m = await fin(svc, m0.id, ['done', 'waiting_user', 'failed']);
    expect(m.status).toBe('done');
    svc.close();
  });

  it('한도 대기 중 중단하면 대기 중인 실행도 취소되고 다시 깨어나지 않는다', async () => {
    const { svc, p } = setup({ limitGraceMs: 10 * 60_000 });
    const tag = randomUUID().slice(0, 8);
    const m0 = await svc.startMission(p.id, `[[mock:limit-once:${tag}]] 문서를 정리하라`);
    await until(() => svc.missions.get(m0.id).limitUntil);
    svc.missions.retryLimitNow(m0.id);
    const runId = await until(() => { const m = svc.missions.get(m0.id); return m.currentRunId && svc.engine.limitOf(m.currentRunId) ? m.currentRunId : null; });
    await svc.missions.stop(m0.id);
    expect(svc.missions.get(m0.id).status).toBe('stopped');
    expect(svc.store.getRun(runId).status).toBe('cancelled');
    expect(svc.engine.limitOf(runId)).toBeNull();
    expect(svc.engine.resumeAfterLimit(runId)).toBe(false);
    svc.close();
  });

  it("실행이 한도 대기 중일 때 '지금 반영' 추가 지시를 하면 기다리지 않고 그 실행을 취소한 뒤 다시 계획한다", async () => {
    const { svc, p } = setup({ limitGraceMs: 10 * 60_000 });
    const tag = randomUUID().slice(0, 8);
    const m0 = await svc.startMission(p.id, `[[mock:limit-once:${tag}]] 문서를 정리하라`);
    await until(() => svc.missions.get(m0.id).limitUntil);
    svc.missions.retryLimitNow(m0.id);
    const runId = await until(() => { const m = svc.missions.get(m0.id); return m.currentRunId && svc.engine.limitOf(m.currentRunId) ? m.currentRunId : null; });
    await svc.missions.addDirective(m0.id, '표 대신 목록으로 정리하라', 'now');
    await until(() => svc.store.getRun(runId).status === 'cancelled');
    expect(svc.engine.limitOf(runId)).toBeNull();
    const m = await fin(svc, m0.id, ['done', 'waiting_user', 'failed']);
    expect(m.status).toBe('done');
    expect(m.cycle).toBeGreaterThan(1); // 취소한 사이클 다음 사이클로 다시 계획
    svc.close();
  });
});

describe('미션 결과물 파일', () => {
  it('사이클 산출물과 기록에 나온 프로젝트 안 파일을 경로로 돌려주고, 폴더 밖 경로는 넣지 않는다', async () => {
    const { svc, p, dir } = setup();
    const m0 = await svc.startMission(p.id, '문서를 정리하라 ../../etc/passwd /etc/hosts');
    const m = await fin(svc, m0.id, ['done', 'waiting_user', 'failed']);
    const files = svc.missions.detail(m.id).files;
    expect(files.map((f) => f.relPath)).toEqual(expect.arrayContaining(['docs/mission/cycle-1.md']));
    expect(files.every((f) => f.path.startsWith(dir) && !f.relPath.includes('..'))).toBe(true);
    expect(files.find((f) => f.relPath === 'docs/mission/cycle-1.md')?.exists).toBe(true);
    svc.close();
  });

  it('지금 일하는 직원: 실행 중인 담당 직원과 단계 이름을 알려 주고, 끝나면 비운다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:hang]] 문서를 정리하라');
    const w = await until(() => { const x = svc.missions.working(p.id).filter((i) => i.kind === 'author'); return x.length ? x : null; });
    const agent = svc.store.listAgents(p.id).find((a) => a.id === w[0].agentId);
    expect(agent).toBeTruthy();
    expect(w[0].who).toBe(`${agent!.code} ${agent!.name}`);
    expect(w[0].task).toContain('문서 작성');
    expect(w[0].missionId).toBe(m0.id);
    expect(svc.missions.detail(m0.id).working.length).toBeGreaterThan(0);
    await svc.missions.stop(m0.id);
    await until(() => svc.missions.working(p.id).length === 0);
    svc.close();
  });
});
