// 시연 환경: 목록 검사(명령·경로·비밀값), 실행 승인, 실제로 켜고 끄기, API 시연 요청(쿠키·잡아 둔 값 유지)
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { DemoManager, demoManifestPath, readManifest, verifyDemo } from '../src/main/demo';
import type { PlanFields } from '../src/shared/types';
import { tmpProject } from './helpers';

function freePort(): Promise<number> {
  return new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });
}
function planAt(folder: string): PlanFields {
  return { name: 't', goal: '', scope: '', doneCriteria: '', folder, outputDir: 'out', writablePaths: [], referenceDocs: [], priorOutputs: [] } as unknown as PlanFields;
}
function write(plan: PlanFields, m: unknown) { const p = demoManifestPath(plan); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, JSON.stringify(m)); }

describe('시연 환경', () => {
  it('시연 목록 검사: 저장소 밖·링크 실행 파일·비밀값 환경값·잘못된 포트는 버리고 이유를 남긴다', () => {
    const d = tmpProject(); const plan = planAt(d);
    mkdirSync(join(d, 'app', 'scripts'), { recursive: true });
    writeFileSync(join(d, 'app', 'scripts', 'run.sh'), '#!/bin/sh\n');
    symlinkSync('/bin/sh', join(d, 'app', 'scripts', 'link.sh'));
    write(plan, { services: [
      { id: 'ok', name: '정상', repo: 'app', start: ['./scripts/run.sh'], port: 8081, health: '/h', env: { SPRING_PROFILES_ACTIVE: 'demo' }, data: 'api+db' },
      { id: 'npm-ok', repo: 'app', start: ['npm', 'run', 'dev'], port: 3212 },
      { id: 'link', repo: 'app', start: ['./scripts/link.sh'], port: 8082 },
      { id: 'abs', repo: 'app', start: ['/bin/sh', '-c', 'x'], port: 8083 },
      { id: 'out', repo: '../elsewhere', start: ['npm'], port: 8084 },
      { id: 'sec', repo: 'app', start: ['npm'], port: 8085, env: { DB_PASSWORD: 'x' } },
      { id: 'port', repo: 'app', start: ['npm'], port: 80 },
    ], apis: [{ service: 'ok', id: 'list', method: 'GET', path: '/api/x' }, { service: 'nope', id: 'bad', method: 'GET', path: '/x' }] });
    const m = readManifest(plan);
    expect(m.services.map((s) => s.id)).toEqual(['ok', 'npm-ok']);
    expect(m.services[0].data).toBe('api+db');
    expect(m.apis.map((a) => a.id)).toEqual(['list']);
    expect(m.errors.join('\n')).toMatch(/link[\s\S]*abs[\s\S]*out[\s\S]*sec[\s\S]*port[\s\S]*bad/);
  });

  it('실행 승인 전에는 켜지 않고, 승인 후 켜서 상태 확인·API 요청(쿠키·잡아 둔 값)·중지까지 된다. 명령이 바뀌면 다시 승인', async () => {
    const d = tmpProject(); const plan = planAt(d); const port = await freePort();
    mkdirSync(join(d, 'svc'), { recursive: true });
    writeFileSync(join(d, 'svc', 'server.js'), `require('http').createServer((q,s)=>{ if(q.url==='/login'){ s.setHeader('Set-Cookie','sid=abc; Path=/'); s.setHeader('Content-Type','application/json'); return s.end(JSON.stringify({token:'t-1'})); }
      if(q.url==='/me'){ s.setHeader('Content-Type','application/json'); return s.end(JSON.stringify({cookie:q.headers.cookie||'', auth:q.headers.authorization||''})); } s.end('ok'); }).listen(${port}, '127.0.0.1');`);
    write(plan, { services: [{ id: 'api', name: '시험 서버', kind: 'api', repo: 'svc', start: ['node', 'server.js'], port, health: '/', startupSec: 20 }] });
    const db = new DatabaseSync(':memory:');
    const mgr = new DemoManager(db, join(tmpdir(), `demo-logs-${Date.now()}`));
    const man = readManifest(plan); const s = man.services[0];
    expect((await mgr.state('p1', s)).status).toBe('needs_approval');
    await expect(mgr.start('p1', man.services, 'api')).rejects.toThrow(/승인/);
    mgr.approve('p1', s);
    await mgr.start('p1', man.services, 'api');
    expect((await mgr.state('p1', s)).status).toBe('running');
    const login = await mgr.request('p1', s, { method: 'POST', path: '/login', headers: {}, body: '{}', capture: { token: 'token' } });
    expect(login.status).toBe(200); expect(login.vars).toEqual(['token']); expect(login.cookies).toEqual(['sid']);
    const me = await mgr.request('p1', s, { method: 'GET', path: '/me', headers: { Authorization: 'Bearer {{token}}' }, body: '' });
    expect(JSON.parse(me.body)).toEqual({ cookie: 'sid=abc', auth: 'Bearer t-1' });
    await expect(mgr.request('p1', s, { method: 'GET', path: '//evil.example/x', headers: {}, body: '' })).rejects.toThrow();
    await expect(mgr.request('p1', s, { method: 'GET', path: '/\\evil.example/x', headers: {}, body: '' })).rejects.toThrow(); // 역슬래시로 다른 호스트로 새지 않게
    expect(() => mgr.approve('p1', s, 'stale-hash')).toThrow(/바뀌었습니다/); // 승인 창에서 본 명령과 다르면 승인하지 않음
    expect(mgr.stop('p1', 'api')).toBe(true);
    for (let i = 0; i < 30 && (await mgr.health(s)); i++) await new Promise((r) => setTimeout(r, 200));
    expect((await mgr.state('p1', s)).status).toBe('stopped');
    // 명령이 바뀌면 이전 승인은 무효
    write(plan, { services: [{ id: 'api', name: '시험 서버', kind: 'api', repo: 'svc', start: ['node', 'server.js', '--x'], port, health: '/' }] });
    expect(mgr.approved('p1', readManifest(plan).services[0])).toBe(false);
  }, 40000);

  it('앱의 시연 확인: 승인 안 된 서비스는 켜지 않고, 승인된 서비스만 켜서 GET·로그인 요청만 보내고 데이터 변경 요청은 보내지 않는다', async () => {
    const d = tmpProject(); const plan = planAt(d); const port = await freePort(); const port2 = await freePort();
    mkdirSync(join(d, 'svc'), { recursive: true });
    writeFileSync(join(d, 'svc', 'server.js'), `let writes=0; require('http').createServer((q,s)=>{ if(q.method==='PATCH'){writes++;} s.setHeader('Content-Type','application/json'); s.end(JSON.stringify({ok:true,writes})); }).listen(${port}, '127.0.0.1');`);
    write(plan, { services: [
      { id: 'api', name: '시험 서버', kind: 'api', repo: 'svc', start: ['node', 'server.js'], port, health: '/', startupSec: 20 },
      { id: 'web', name: '승인 안 된 화면', kind: 'web', repo: 'svc', start: ['node', 'server.js'], port: port2, health: '/' },
    ], apis: [
      { service: 'api', id: 'list', method: 'GET', path: '/items' },
      { service: 'api', id: 'edit', method: 'PATCH', path: '/items/1', body: {} },
    ] });
    const mgr = new DemoManager(new DatabaseSync(':memory:'), join(tmpdir(), `demo-logs-v-${Date.now()}`));
    const man = readManifest(plan);
    mgr.approve('p1', man.services[0]);
    const lines = await verifyDemo(mgr, 'p1', plan);
    expect(lines.join('\n')).toMatch(/시험 서버\(api\): 실행 중/);
    expect(lines.join('\n')).toMatch(/승인 안 된 화면\(web\): 실행 승인 필요/);
    expect(lines.join('\n')).toMatch(/API list GET \/items: 200/);
    expect(lines.join('\n')).toMatch(/API edit PATCH .*자동으로 보내지 않음/);
    expect((await mgr.state('p1', man.services[1])).status).toBe('needs_approval'); // 켜지 않았다
    mgr.stop('p1', 'api');
  }, 40000);
});
