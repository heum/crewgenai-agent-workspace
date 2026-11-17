// 권한 거부로 멈추기·폴더 산출물 시험
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Mission } from '../src/shared/types';
import { checkOutput } from '../src/main/engine/fsutil';
import { commandPrefix } from '../src/main/mission';
import { gitInit, mkService, plan, sleep, tmpProject } from './helpers';

async function waitMission(svc: ReturnType<typeof mkService>, id: string, statuses: Mission['status'][], ms = 60000) {
  const t0 = Date.now();
  for (;;) {
    const m = svc.missions.get(id);
    if (statuses.includes(m.status)) return m;
    if (Date.now() - t0 > ms) throw new Error(`시간 초과: ${m.status}/${m.stage}`);
    await sleep(50);
  }
}

describe('권한 거부', () => {
  it('허용 명령 접두어 후보를 만든다', () => {
    expect(commandPrefix('shasum -a 256 /x/y.html')).toBe('shasum -a 256');
    expect(commandPrefix('date; shasum -a 256 /x')).toBe('date');
    expect(commandPrefix('F=/tmp/a.txt wc -l "$F"')).toBe('wc -l'); // 변수 지정은 건너뛴다
    expect(commandPrefix('F=/tmp/a.txt')).toBeNull();
    expect(commandPrefix('"/Applications/Some App/bin" --x')).toBeNull(); // 따옴표 경로는 제안하지 않음
    expect(commandPrefix('git -C /repo log -1')).toBe('git -C');
    expect(commandPrefix('ls -la /a /b')).toBe('ls -la');
    expect(commandPrefix('npx --no-install playwright --version')).toBe('npx --no-install');
  });

  it('권한 때문에 막힌 업무는 보류하고, 할 일이 그것뿐이면 멈춰 거부된 명령·경로와 고칠 곳을 보여 준다', async () => {
    const dir = tmpProject(); gitInit(dir); const svc = mkService(dir);
    const p = svc.createProject(plan(dir, { writablePaths: ['docs'] }));
    svc.loadAgentTemplates(p.id);
    const m0 = await svc.startMission(p.id, '[[mock:deny:bash:shasum -a 256 /Users/someone/repo/a.html]] [[mock:deny:read:/Users/someone/repo/b.html]] 해시를 구하라');
    const m = await waitMission(svc, m0.id, ['waiting_user', 'done', 'failed']);
    expect(m.status).toBe('waiting_user');
    expect(svc.missions.detail(m.id).cycles.length).toBe(1); // 보류한 업무를 다시 돌리지 않았다
    const ds = m.denials ?? [];
    const cmd = ds.find((d) => d.kind === 'command')!;
    expect(cmd.tool).toBe('Bash');
    expect(cmd.target).toBe('shasum -a 256 /Users/someone/repo/a.html');
    expect(cmd.suggestion).toBe('shasum -a 256');
    expect(ds.some((d) => d.kind === 'path' && d.target === '/Users/someone/repo/b.html')).toBe(true);
    expect(m.question).toContain('보류한 업무');
    // 사용자가 허용한 뒤 다시 시도하면 거부·보류 목록을 지우고 다음 사이클을 계획한다
    const next = svc.missions.answer(m.id, '', 'continue');
    expect(next.denials ?? null).toBeNull();
    expect(next.parkedSigs).toEqual([]);
    await svc.missions.stop(m.id);
    svc.close();
  });

  it('막힌 업무만 보류하고 나머지 작업은 계속해 완료 보고까지 간다(확인 필요에 남음)', async () => {
    const dir = tmpProject(); gitInit(dir); const svc = mkService(dir);
    const p = svc.createProject(plan(dir, { writablePaths: ['docs'] }));
    svc.loadAgentTemplates(p.id);
    const m0 = await svc.startMission(p.id, '[[mock:two-tasks]] [[mock:deny:bash:shasum -a 256 /Users/someone/repo/a.html]] 해시와 보조 문서');
    const m = await waitMission(svc, m0.id, ['waiting_user', 'done', 'failed']);
    expect(m.status).toBe('done');
    expect(m.cycle).toBe(2);
    expect(m.denials?.some((d) => d.target.startsWith('shasum'))).toBe(true);
    expect(m.question).toContain('보류한 업무 1건');
    const d = svc.missions.detail(m.id);
    expect(svc.engine.detail(d.cycles[1].runId).graph.nodes.filter((n) => n.kind === 'agent').map((n) => n.label.split(' (')[0])).toEqual(['보조 문서 2']); // 보류한 업무는 다시 계획하지 않음
    expect(svc.attention().items.some((i) => i.missionId === m.id && i.kind === 'denied')).toBe(true);
    // 해결했다고 알리면 보류를 풀어 다음 계획부터 다시 시도한다
    const r = svc.missions.retryParked(m.id);
    expect(r.denials ?? null).toBeNull();
    expect(r.parkedSigs).toEqual([]);
    expect(svc.attention().items.some((i) => i.missionId === m.id)).toBe(false);
    svc.missions.answer(m.id, '', 'stop');
    svc.close();
  });

  it('보류한 업무를 오퍼레이터가 다시 계획해 같은 거부가 나도 묻고 멈추지 않고, 보류를 유지한 채 나머지를 계속한다', async () => {
    const dir = tmpProject(); gitInit(dir); const svc = mkService(dir);
    const p = svc.createProject(plan(dir, { writablePaths: ['docs'] }));
    svc.loadAgentTemplates(p.id);
    const m0 = await svc.startMission(p.id, '[[mock:ignore-parked]] [[mock:two-tasks]] [[mock:deny:bash:shasum -a 256 /x/a.html]] 해시');
    const m = await waitMission(svc, m0.id, ['waiting_user', 'done', 'failed']);
    expect(m.question ?? '').not.toContain('다시 막힘');
    const d = svc.missions.detail(m.id);
    expect(d.cycles.length).toBeGreaterThanOrEqual(2);
    expect(d.events.some((e) => e.text.includes('보류를 유지'))).toBe(true);
    expect((m.denials ?? []).length).toBeGreaterThan(0); // 보류한 업무는 확인 필요로 남는다
    await svc.missions.stop(m.id);
    svc.close();
  });

  it('실행 전 점검: 허용되지 않은 명령이 필요한 작업은 돌리지 않고 확인 필요로 빼며, 나머지는 진행한다', async () => {
    const dir = tmpProject(); gitInit(dir); const svc = mkService(dir);
    const p = svc.createProject(plan(dir, { writablePaths: ['docs'] }));
    svc.loadAgentTemplates(p.id);
    // 하나뿐이면 실행하지 않고 묻는다
    const a0 = await svc.startMission(p.id, '[[mock:needs:git -C /x/repo log -1]] 커밋 기록');
    const a = await waitMission(svc, a0.id, ['waiting_user', 'done', 'failed']);
    expect(a.status).toBe('waiting_user');
    expect(svc.missions.detail(a.id).cycles.length).toBe(0);
    expect(a.denials?.[0]).toMatchObject({ kind: 'command', target: 'git -C /x/repo log -1', suggestion: 'git -C', tool: '실행 전 점검 · 명령' });
    svc.missions.answer(a.id, '', 'stop');
    // 다른 작업이 있으면 그 작업은 진행한다
    const b0 = await svc.startMission(p.id, '[[mock:two-tasks]] [[mock:needs:git -C /x/repo log -1]] 커밋 기록과 보조 문서');
    const b = await waitMission(svc, b0.id, ['waiting_user', 'done', 'failed']);
    expect(b.status).toBe('done');
    const first = svc.engine.detail(svc.missions.detail(b.id).cycles[0].runId);
    expect(first.graph.nodes.filter((n) => n.kind === 'agent').map((n) => n.label.split(' (')[0])).toEqual(['보조 문서 1']);
    expect(b.denials?.some((d) => d.tool === '실행 전 점검 · 명령')).toBe(true);
    svc.missions.answer(b.id, '', 'stop');
    svc.close();
  });

  it('근거가 부족한 부분이 있어도 할 수 있는 작업이 있으면 멈추지 않고 진행한다(확인 필요로 남김)', async () => {
    const dir = tmpProject(); gitInit(dir); const svc = mkService(dir);
    const p = svc.createProject(plan(dir, { writablePaths: ['docs'] }));
    svc.loadAgentTemplates(p.id);
    const m0 = await svc.startMission(p.id, '[[mock:gaps-with-tasks]] 문서를 정리하라');
    const m = await waitMission(svc, m0.id, ['waiting_user', 'done', 'failed']);
    expect(m.status).toBe('done');
    expect(m.gaps?.[0]?.issue).toContain('대상 사용자');
    svc.missions.answer(m.id, '', 'stop');
    svc.close();
  });
});

describe('폴더 산출물', () => {
  it('형식이 정해진 폴더 산출물은 안에 그 형식 파일이 있어야 통과한다', () => {
    const d = tmpProject();
    mkdirSync(join(d, 'screens'));
    writeFileSync(join(d, 'screens', 'README.md'), '# 목록');
    expect(checkOutput(d, { path: 'screens', format: 'image', required: true }).ok).toBe(false);
    writeFileSync(join(d, 'screens', 'home.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
    const r = checkOutput(d, { path: 'screens', format: 'image', required: true });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('1개');
    expect(checkOutput(d, { path: 'screens', format: 'any', required: true }).ok).toBe(true);
  });
});

describe('폴더 산출물 — 링크 고리', () => {
  it('자기 자신을 가리키는 링크가 있어도 멈추지 않고 일반 파일만 본다', () => {
    const d = tmpProject();
    const { symlinkSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(join(d, 'out'));
    try { symlinkSync('.', join(d, 'out', 'a')); symlinkSync('.', join(d, 'out', 'b')); } catch { /* 링크 불가 환경 */ }
    const t0 = Date.now();
    expect(checkOutput(d, { path: 'out', format: 'image', required: true }).ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
