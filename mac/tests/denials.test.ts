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
    expect(commandPrefix('git -C /repo log -1')).toBe('git -C');
    expect(commandPrefix('ls -la /a /b')).toBe('ls -la');
    expect(commandPrefix('npx --no-install playwright --version')).toBe('npx --no-install');
  });

  it('작업이 권한 때문에 실패하면 같은 설정으로 다시 돌지 않고 멈춰, 거부된 명령·경로와 고칠 곳을 보여 준다', async () => {
    const dir = tmpProject(); gitInit(dir); const svc = mkService(dir);
    const p = svc.createProject(plan(dir, { writablePaths: ['docs'] }));
    svc.loadAgentTemplates(p.id);
    const m0 = await svc.startMission(p.id, '[[mock:deny:bash:shasum -a 256 /Users/someone/repo/a.html]] [[mock:deny:read:/Users/someone/repo/b.html]] 해시를 구하라');
    const m = await waitMission(svc, m0.id, ['waiting_user', 'done', 'failed']);
    expect(m.status).toBe('waiting_user');
    expect(m.cycle).toBe(1); // 다음 사이클을 돌지 않았다
    const ds = m.denials ?? [];
    const cmd = ds.find((d) => d.kind === 'command')!;
    expect(cmd.tool).toBe('Bash');
    expect(cmd.target).toBe('shasum -a 256 /Users/someone/repo/a.html');
    expect(cmd.suggestion).toBe('shasum -a 256');
    expect(ds.some((d) => d.kind === 'path' && d.target === '/Users/someone/repo/b.html')).toBe(true);
    expect(m.question).toContain('권한은 지시문으로 바뀌지 않으므로');
    // 사용자가 허용한 뒤 다시 시도하면 거부 목록을 지우고 다음 사이클을 계획한다
    const next = svc.missions.answer(m.id, '', 'continue');
    expect(next.denials ?? null).toBeNull();
    await svc.missions.stop(m.id);
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
