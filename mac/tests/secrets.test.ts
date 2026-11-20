// API 키 파일 저장 — 확인함에서 입력한 값은 .env 파일에만 쓰고, 기록·응답에는 남기지 않는다
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Mission } from '../src/shared/types';
import { envFileProblem, envLine, hasEnvVar, setEnvVar } from '../src/main/secrets';
import { parseSecretSpec } from '../src/main/mission';
import { gitInit, mkService, plan, sleep, tmpProject } from './helpers';

async function waitMission(svc: ReturnType<typeof mkService>, id: string, statuses: Mission['status'][], ms = 60000) {
  const t0 = Date.now();
  for (;;) { const m = svc.missions.get(id); if (statuses.includes(m.status)) return m; if (Date.now() - t0 > ms) throw new Error(`시간 초과: ${m.status}`); await sleep(50); }
}

describe('.env 다루기', () => {
  it('.env·.env.<이름>만 허용하고 견본·밖 경로·절대 경로는 거부한다', () => {
    expect(envFileProblem('.env')).toBeNull();
    expect(envFileProblem('api/.env.local')).toBeNull();
    expect(envFileProblem('.env.example')).toMatch('견본');
    expect(envFileProblem('../.env')).toBeTruthy();
    expect(envFileProblem('/etc/.env')).toBeTruthy();
    expect(envFileProblem('config.json')).toBeTruthy();
    expect(parseSecretSpec({ file: './api/.env', name: 'OPENAI_API_KEY' })).toEqual({ file: 'api/.env', name: 'OPENAI_API_KEY' });
    expect(parseSecretSpec({ file: '.env', name: 'bad-name' })).toBeNull();
  });
  it('있는 변수는 바꾸고(중복 줄 정리) 없으면 더하며, 특수 문자는 따옴표로 감싼다', () => {
    expect(setEnvVar('A=1\nKEY=old\n# 주석\nexport KEY=dup\n', 'KEY', 'new')).toBe('A=1\nKEY=new\n# 주석\n');
    expect(setEnvVar('', 'KEY', 'v')).toBe('KEY=v\n');
    expect(envLine('K', 'a b#c')).toBe("K='a b#c'");
    expect(envLine('K', "it's")).toBe('K="it\'s"');
    expect(hasEnvVar('KEY=\nX=1', 'KEY')).toBe(false);
    expect(hasEnvVar("KEY='v'", 'KEY')).toBe(true);
  });
});

describe('확인함 비밀값 저장', () => {
  it('저장하면 .env(0600, 커밋 제외)에만 값을 쓰고, 결정은 넣었음으로 처리하며 기록에는 값이 없다', async () => {
    const dir = tmpProject(); gitInit(dir); const svc = mkService(dir);
    const p = svc.createProject(plan(dir, { writablePaths: ['docs'] }));
    svc.loadAgentTemplates(p.id);
    const m0 = await svc.startMission(p.id, '[[mock:secret-gap]] 외부 연동을 준비하라');
    const w = await waitMission(svc, m0.id, ['waiting_user', 'done', 'failed']);
    const it = svc.pendingDecisions().find((x) => x.missionId === w.id && x.kind === 'gap')!;
    expect(it.secret).toEqual({ file: '.env', name: 'DEMO_API_KEY', source: '예시 서비스 콘솔', saved: false });
    const VALUE = 'sk-test-SECRETVALUE0123456789';
    // 키처럼 보이는 글을 답으로 적으면 받지 않는다
    expect(svc.applyDecisions([{ key: it.key, choice: VALUE }]).applied).toBe(0);
    // 잘못된 위치·이름·값은 저장하지 않는다
    expect(await svc.saveSecret({ key: it.key, file: '../.env', name: 'DEMO_API_KEY', value: VALUE })).toMatchObject({ ok: false });
    expect(await svc.saveSecret({ key: it.key, file: '.env.example', name: 'DEMO_API_KEY', value: VALUE })).toMatchObject({ ok: false });
    expect(await svc.saveSecret({ key: it.key, file: '.env', name: 'DEMO-KEY', value: VALUE })).toMatchObject({ ok: false });
    expect(await svc.saveSecret({ key: it.key, file: '.env', name: 'DEMO_API_KEY', value: 'a\nb' })).toMatchObject({ ok: false });
    writeFileSync(join(dir, '.env'), 'OTHER=1\n');
    const r = await svc.saveSecret({ key: it.key, file: '.env', name: 'DEMO_API_KEY', value: VALUE });
    expect(r).toMatchObject({ ok: true });
    expect(JSON.stringify(r)).not.toContain(VALUE);
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(`OTHER=1\nDEMO_API_KEY=${VALUE}\n`);
    if (process.platform !== 'win32') expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.env');
    const after = svc.missions.get(w.id);
    expect(after.decisions?.some((d) => d.choice.startsWith('넣었음'))).toBe(true);
    expect(JSON.stringify(svc.missions.detail(w.id))).not.toContain(VALUE);
    expect(svc.pendingDecisions().some((x) => x.key === it.key)).toBe(false);
    // 처리된 항목에는 다시 저장하지 않는다
    expect(await svc.saveSecret({ key: it.key, file: '.env', name: 'DEMO_API_KEY', value: VALUE })).toMatchObject({ ok: false });
    await svc.missions.stop(w.id); svc.close();
  });
});
