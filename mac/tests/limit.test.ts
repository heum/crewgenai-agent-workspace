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
    const { svc, p } = setup({ limitGraceMs: 1500 }); // 대기가 화면에 보일 만큼(해제 시각이 1초 안쪽이면 대기를 알리기 전에 재개될 수 있음)
    const tag = randomUUID().slice(0, 8);
    const m0 = await svc.startMission(p.id, `[[mock:limit-once:${tag}]] 문서를 정리하라`);
    const m = await fin(svc, m0.id, ['done', 'waiting_user', 'failed']);
    expect(m.status).toBe('done');
    expect(m.limitUntil ?? null).toBeNull();
    const d = svc.missions.detail(m.id);
    const texts = d.events.map((e) => e.text).join('\n');
    expect(texts).toContain('Claude 한도 대기 —');
    expect(texts).toContain('Claude 한도가 풀려 자동으로 이어서 진행합니다');
    expect(d.events.filter((e) => e.text.startsWith('Claude 한도 대기')).length).toBe(1); // 처음 한도 도달만 알림
    expect(m.limitWait ?? null).toBeNull();
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

  it('해제 시각을 모르면 1시간 뒤에 한 번 다시 확인하고, 알려 주면 그 시각을 쓴다', () => {
    const { svc } = setup({ limitGraceMs: 0 });
    const t = Date.now();
    const u = svc.engine.limitWaitUntil({ resetsAt: null, text: '' });
    expect(u - t).toBeGreaterThanOrEqual(60 * 60_000 - 50); expect(u - t).toBeLessThan(60 * 60_000 + 2000);
    expect(svc.engine.limitWaitUntil({ resetsAt: t + 5 * 60_000, text: '' })).toBe(t + 5 * 60_000);
    svc.close();
  });

  it('한도 대기 중 앱을 다시 시작해도 예약을 유지하고(Claude를 다시 부르지 않음), 해제되면 멈춘 지점부터 한 번만 이어서 끝낸다', async () => {
    const { Service } = await import('../src/main/service');
    const { MOCK, MOCK_CODEX } = await import('./helpers');
    const { svc, p } = setup({ limitGraceMs: 10 * 60_000 });
    const tag = randomUUID().slice(0, 8);
    const m0 = await svc.startMission(p.id, `[[mock:limit-once:${tag}]] 문서를 정리하라`);
    const opUntil = await until(() => svc.missions.get(m0.id).limitUntil);
    // 1) 오퍼레이터 한도 대기 중 재시작: 저장한 해제 시각까지 Claude를 부르지 않는다
    let file = svc.store.file; svc.close();
    let re = new Service({ dbFile: file, mockScript: MOCK, mockCodexScript: MOCK_CODEX, emit: () => {}, limitGraceMs: 10 * 60_000 });
    await re.engine.recoverOnStartup(); await re.missions.recoverProcesses(); re.missions.recoverOnStartup();
    await sleep(800);
    expect(re.missions.get(m0.id).limitUntil).toBe(opUntil);
    expect(re.missions.events(m0.id).some((e) => e.kind === 'operator_plan')).toBe(false);
    re.missions.retryLimitNow(m0.id); // 해제됨(테스트에서는 바로)
    const runId = await until(() => { const m = re.missions.get(m0.id); return m.currentRunId && re.engine.limitOf(m.currentRunId) ? m.currentRunId : null; });
    // 2) 직원 실행 한도 대기 중 재시작: 예약 유지. 해제 시각이 이미 지났으면(절전·종료 중 지남) 시작 후 한 번만 확인해 이어 간다
    const lim = re.engine.limitOf(runId)!;
    re.store.db.prepare("UPDATE run_meta SET value=? WHERE run_id=? AND key='limit'").run(JSON.stringify({ ...lim, until: Date.now() - 1000 }), runId);
    file = re.store.file; re.close();
    re = new Service({ dbFile: file, mockScript: MOCK, mockCodexScript: MOCK_CODEX, emit: () => {}, limitGraceMs: 10 * 60_000 });
    await re.engine.recoverOnStartup(); await re.missions.recoverProcesses(); re.missions.recoverOnStartup();
    const m = await until(() => { const x = re.missions.get(m0.id); return ['done', 'waiting_user', 'failed'].includes(x.status) ? x : null; });
    expect(m.status).toBe('done');
    const authors = re.engine.detail(runId).attempts.filter((a) => a.role === 'author');
    expect(authors.length).toBe(2); // 한도에 걸린 시도 1 + 재개 1(몰아서 여러 번 실행하지 않음)
    expect(re.missions.events(m0.id).filter((e) => e.kind === 'operator_plan' && e.cycle === 1).length).toBe(1); // 같은 사이클을 다시 계획하지 않음
    re.close();
  });

  it('오류 구분: 로그인 만료·연결 장애·그 밖의 오류를 나누고, 연결 장애는 멈추지 않고 앱이 나중에 다시 시도한다', async () => {
    const { classifyError } = await import('../src/main/mission');
    expect(classifyError('오퍼레이터 호출 실패(종료 코드 1): Invalid API key · Please run /login')).toBe('auth');
    expect(classifyError('API Error: 401 authentication_error')).toBe('auth');
    expect(classifyError('API Error: fetch failed (ECONNRESET)')).toBe('network');
    expect(classifyError('529 overloaded_error')).toBe('network');
    expect(classifyError('오퍼레이터가 구조화된 결과를 돌려주지 않았습니다.')).toBe('other');
    expect(classifyError('오퍼레이터 호출 실패(종료 코드 0)')).toBe('network'); // 결과·이유 없이 끊긴 호출은 다시 시도
    expect(classifyError('오퍼레이터 호출 실패(종료 코드 1): 잘못된 요청')).toBe('other');
    const { svc, p } = setup({ limitGraceMs: 0 });
    const tag = randomUUID().slice(0, 8);
    const m0 = await svc.startMission(p.id, `[[mock:netfail-once:${tag}]] 문서를 정리하라`);
    const w = await until(() => { const m = svc.missions.get(m0.id); return m.limitWait ? m : null; });
    expect(w.status).not.toBe('waiting_user'); // 사용자에게 묻지 않는다
    expect(w.limitWait!.reason).toContain('일시 장애');
    expect(Date.parse(w.limitUntil!) - Date.now()).toBeGreaterThan(9 * 60_000);
    svc.missions.retryLimitNow(m0.id); // (테스트) 예약 시각 대신 바로
    const m = await fin(svc, m0.id, ['done', 'waiting_user', 'failed']);
    expect(m.status).toBe('done');
    expect(svc.missions.events(m.id).some((e) => e.text.startsWith('연결이 회복돼'))).toBe(true);
    svc.close();
  });

  it('중지된 미션의 실행이 한도 대기 예약을 남긴 채 앱이 꺼져도, 다시 켤 때 예약을 끄고 다시 돌지 않는다', async () => {
    const { Service } = await import('../src/main/service');
    const { MOCK, MOCK_CODEX } = await import('./helpers');
    const { svc, p } = setup({ limitGraceMs: 10 * 60_000 });
    const tag = randomUUID().slice(0, 8);
    const m0 = await svc.startMission(p.id, `[[mock:limit-once:${tag}]] 문서를 정리하라`);
    await until(() => svc.missions.get(m0.id).limitUntil);
    svc.missions.retryLimitNow(m0.id);
    const runId = await until(() => { const m = svc.missions.get(m0.id); return m.currentRunId && svc.engine.limitOf(m.currentRunId) ? m.currentRunId : null; });
    // 중지 정리 도중에 꺼진 상황: 미션은 중지로 저장됐지만 실행에는 한도 예약이 남아 있음
    (svc.missions as unknown as { save: (m: object) => void }).save({ ...svc.missions.get(m0.id), status: 'stopped', stage: 'stopped' });
    const file = svc.store.file; svc.close();
    const re = new Service({ dbFile: file, mockScript: MOCK, mockCodexScript: MOCK_CODEX, emit: () => {}, limitGraceMs: 0 });
    await re.engine.recoverOnStartup(); await re.missions.recoverProcesses(); re.missions.recoverOnStartup();
    await sleep(500);
    expect(re.engine.limitOf(runId)).toBeNull();
    expect(re.engine.isActive(runId)).toBe(false);
    expect(re.store.getRun(runId).status).toBe('cancelled');
    expect(re.missions.get(m0.id).status).toBe('stopped');
    re.close();
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
