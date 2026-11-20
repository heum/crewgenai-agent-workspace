// 꼭 필요한 권한 허용 요청은 확인함 팝업으로 묻는다 — 기술 권한을 앱이 처리하는 설정에서도 미션을 멈추지 않고
import { describe, expect, it } from 'vitest';
import type { Mission } from '../src/shared/types';
import { okPermPrefix } from '../src/main/mission';
import { gitInit, mkService, plan, sleep, tmpProject } from './helpers';

async function until<T>(f: () => T | null | undefined | false, ms = 60000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('시간 초과'); await sleep(50); }
}

describe('권한 허용 요청', () => {
  it('일반 프로그램만 묻고, 무엇이든 실행하게 되는 셸·권한 상승은 묻지 않는다', () => {
    expect(okPermPrefix('curl -s')).toBe(true);
    expect(okPermPrefix('npm run')).toBe(true);
    for (const x of ['bash -c', 'sudo', 'sh', 'eval', 'rm -rf', '/usr/bin/curl', 'F=/tmp/x', '', null]) expect(okPermPrefix(x as string | null)).toBe(false);
  });

  it('오퍼레이터가 요청하면 확인함에 올리고, 허용하면 그 직원에게만 열고 오퍼레이터에게 알린다', async () => {
    const dir = tmpProject(); gitInit(dir); const svc = mkService(dir);
    const p = svc.createProject(plan(dir, { writablePaths: ['docs'] }));
    svc.loadAgentTemplates(p.id);
    const m0 = await svc.startMission(p.id, '[[mock:perm-request]] 문서를 정리하라');
    const it = await until(() => svc.pendingDecisions().find((x) => x.missionId === m0.id && x.key.includes('|pa|')));
    expect(it.kind).toBe('permission');
    expect(it.urgent).toBe(false);
    expect(it.question).toContain("'curl -s'");
    expect(svc.pendingDecisions().filter((x) => x.key.includes('|pa|'))).toHaveLength(1); // bash -c 요청은 걸렀다
    const allow = it.choices[0].label;
    expect(svc.applyDecisions([{ key: it.key, choice: allow }]).applied).toBe(1);
    const a = svc.store.listAgents(p.id).find((x) => x.code === '09')!;
    expect(a.allowedCommands).toContain('curl -s');
    const m: Mission = svc.missions.get(m0.id);
    expect(m.permAsks ?? []).toHaveLength(0);
    expect((m.techNotes ?? []).some((x) => x.includes("'curl -s'") && x.includes('허용'))).toBe(true);
    expect(svc.pendingDecisions().some((x) => x.key === it.key)).toBe(false);
    await svc.missions.stop(m0.id); svc.close();
  });
});
