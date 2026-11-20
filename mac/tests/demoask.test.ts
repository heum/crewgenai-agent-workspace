// 시연 실행 승인을 확인함으로: 승인이 필요하면 확인함 항목(텔레그램과 같은 처리)으로 올리고, 포트만 바뀐 경우에는 이전 승인을 유지한다
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { DemoManager, demoManifestPath, readManifest, verifyDemo } from '../src/main/demo';
import type { DemoAsk, PlanFields } from '../src/shared/types';
import { gitInit, mkService, plan as mkPlan, sleep, tmpProject } from './helpers';

function freePort(): Promise<number> {
  return new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });
}
async function until<T>(f: () => T | null | undefined | false, ms = 60000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('시간 초과'); await sleep(50); }
}
function write(plan: PlanFields, m: unknown) { const p = demoManifestPath(plan); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, JSON.stringify(m)); }
function server(d: string, port: number) { mkdirSync(join(d, 'svc'), { recursive: true }); writeFileSync(join(d, 'svc', 'server.js'), `require('http').createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT||${port}), '127.0.0.1');`); }

describe('시연 실행 승인 기준', () => {
  it('포트·PORT 환경값·주소의 포트만 바뀌면 이전 승인을 유지하고, 명령·환경값이 바뀌면 다시 승인을 받는다', async () => {
    const d = tmpProject(); const plan = mkPlan(d); server(d, 1);
    const base = { id: 'web', name: '웹', kind: 'web', repo: 'svc', start: ['node', 'server.js'], port: 3301, health: '/', env: { DEMO_PORT: '3301', API: 'http://127.0.0.1:8101/api', DIST: '.next-demo-c1' } };
    write(plan, { services: [base] });
    const mgr = new DemoManager(new DatabaseSync(':memory:'), join(tmpdir(), `demo-logs-${Date.now()}`));
    mgr.approve('p', readManifest(plan).services[0]);
    write(plan, { services: [{ ...base, port: 3302, env: { DEMO_PORT: '3302', API: 'http://127.0.0.1:8102/api', DIST: '.next-demo-c1' } }] });
    expect(mgr.approved('p', readManifest(plan).services[0])).toBe(true);
    write(plan, { services: [{ ...base, port: 3302, env: { DEMO_PORT: '3302', API: 'http://127.0.0.1:8102/api', DIST: '.next-demo-c2' } }] });
    expect(mgr.approved('p', readManifest(plan).services[0])).toBe(false);
    write(plan, { services: [{ ...base, start: ['node', 'other.js'] }] });
    expect(mgr.approved('p', readManifest(plan).services[0])).toBe(false);    // 이름에 PORT가 들어갔을 뿐인 값, 포트가 아닌 짧은 옵션, 코드·경로 속 주소처럼 보이는 글자는 포트로 보지 않는다
    const chk = (extra: object) => { write(plan, { services: [{ ...base, ...extra }] }); return mgr.approved('p', readManifest(plan).services[0]); };
    mgr.approve('p', readManifest(plan).services[0]);
    expect(chk({ env: { ...base.env, EXPORT_DIR: '/tmp/a' } })).toBe(false);
    mgr.approve('p', readManifest(plan).services[0]);
    expect(chk({ env: { ...base.env, EXPORT_DIR: '/tmp/b' } })).toBe(false);
    write(plan, { services: [{ ...base, start: ['node', 'server.js', '-p', '1234'] }] }); mgr.approve('p', readManifest(plan).services[0]);
    expect(chk({ start: ['node', 'server.js', '-p', '5678'] })).toBe(false);
    write(plan, { services: [{ ...base, start: ['node', 'server.js', '--port', '1234'] }] }); mgr.approve('p', readManifest(plan).services[0]);
    expect(chk({ start: ['node', 'server.js', '--port', '5678'] })).toBe(true);
    write(plan, { services: [{ ...base, env: { ...base.env, CODE: 'x ./localhost:1234/f' } }] }); mgr.approve('p', readManifest(plan).services[0]);
    expect(chk({ env: { ...base.env, CODE: 'x ./localhost:9999/f' } })).toBe(false);
  });

  it('승인되지 않은 서비스는 켜지 않고 확인함에 올릴 항목으로 돌려준다', async () => {
    const d = tmpProject(); const plan = mkPlan(d); const port = await freePort(); server(d, port);
    write(plan, { services: [{ id: 'web', name: '웹', kind: 'web', repo: 'svc', start: ['node', 'server.js'], port, health: '/', startupSec: 20 }] });
    const mgr = new DemoManager(new DatabaseSync(':memory:'), join(tmpdir(), `demo-logs-${Date.now()}`));
    const asks: DemoAsk[] = [];
    const lines = await verifyDemo(mgr, 'p', plan, asks);
    expect(asks.map((a) => [a.serviceId, a.kind, a.command])).toEqual([['web', 'approve', 'node server.js']]);
    expect(lines.join('\n')).toContain('확인함');
    expect(await mgr.health(readManifest(plan).services[0])).toBe(false);
  });
});

describe('예전 코드로 떠 있는 앱 서버', () => {
  it('앱이 켠 서버가 상태 확인 주소에 404(예전 코드)면 묻지 않고 끄고 다시 켜며, 확인함에 올리지 않는다', async () => {
    const d = tmpProject(); const plan = mkPlan(d); const port = await freePort();
    mkdirSync(join(d, 'svc'), { recursive: true });
    const code = (ok: boolean) => `require('http').createServer((q,s)=>{ if(q.url==='/build/c2'){ s.statusCode=${ok ? 200 : 404}; return s.end('x'); } s.end('ok'); }).listen(Number(process.env.PORT), '127.0.0.1');`;
    writeFileSync(join(d, 'svc', 'server.js'), code(false));
    write(plan, { services: [{ id: 'web', name: '웹', kind: 'web', repo: 'svc', start: ['node', 'server.js'], port, health: '/build/c2', startupSec: 20 }] });
    const mgr = new DemoManager(new DatabaseSync(':memory:'), join(tmpdir(), `demo-logs-${Date.now()}`));
    const s = readManifest(plan).services[0];
    mgr.approve('p', s); await mgr.start('p', readManifest(plan).services, 'web');
    expect(await mgr.probe(s)).toBe(404);
    writeFileSync(join(d, 'svc', 'server.js'), code(true)); // 새 코드가 들어옴(포트·명령은 그대로)
    const asks: DemoAsk[] = [];
    const lines = await verifyDemo(mgr, 'p', plan, asks);
    expect(lines.join('\n')).toContain('다시 켰습니다');
    expect(asks).toEqual([]);
    expect(await mgr.probe(s)).toBe(200);
    mgr.stopAll();
  }, 60000);
});

describe('확인함의 시연 실행 승인', () => {
  it('미션 판단 전 시연 확인에서 확인함에 올리고, 사용자가 고르면 그때 승인·실행한다', async () => {
    const dir = tmpProject(); gitInit(dir); const svc = mkService(dir);
    const p = svc.createProject(mkPlan(dir, { writablePaths: ['docs'] })); svc.loadAgentTemplates(p.id);
    const port = await freePort(); server(dir, port);
    write(svc.store.getProject(p.id).plan, { services: [{ id: 'web', name: '시험 웹', kind: 'web', repo: 'svc', start: ['node', 'server.js'], port, health: '/', startupSec: 20 }] });
    const m0 = await svc.startMission(p.id, '문서를 정리하라');
    const it = await until(() => svc.pendingDecisions().find((x) => x.missionId === m0.id && x.kind === 'demo'));
    expect(it.question).toContain("'시험 웹'");
    expect(it.explain).toContain('명령: node server.js');
    expect(it.urgent).toBe(false);
    const s = readManifest(svc.store.getProject(p.id).plan).services[0];
    expect(svc.demo.approved(p.id, s)).toBe(false); // 고르기 전에는 승인·실행하지 않음
    expect(svc.applyDecisions([{ key: it.key, choice: '아무 글' }]).applied).toBe(0); // 보여 준 선택지만
    expect(svc.applyDecisions([{ key: it.key, choice: '승인하고 켜기' }], '텔레그램').applied).toBe(1);
    expect(svc.demo.approved(p.id, s)).toBe(true);
    await until(() => svc.missions.detail(m0.id).events.some((e) => e.text.includes("'시험 웹'을(를) 승인하고 켰습니다(텔레그램)")), 30000);
    expect(await svc.demo.health(s)).toBe(true);
    expect(svc.pendingDecisions().some((x) => x.kind === 'demo')).toBe(false);
    await svc.missions.stop(m0.id); svc.close();
  });
});
