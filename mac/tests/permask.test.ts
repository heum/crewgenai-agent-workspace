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
  it('내려받기 주소 요청: 정확한 주소 하나만 확인함에 올리고, 허용하면 그 직원에게만 그 주소를 더한다(넓게 여는 표기는 버린다)', async () => {
    const dir = tmpProject(); gitInit(dir); const svc = mkService(dir);
    const p = svc.createProject(plan(dir, { writablePaths: ['docs'] }));
    svc.loadAgentTemplates(p.id);
    expect(svc.store.listAgents(p.id).every((x) => !(x.allowedDomains ?? []).length)).toBe(true); // 기본은 아무 주소도 열려 있지 않다
    const m0 = await svc.startMission(p.id, '[[mock:net-request]] 문서를 정리하라');
    const it = await until(() => svc.pendingDecisions().find((x) => x.missionId === m0.id && x.key.includes('|pa|')));
    expect(svc.pendingDecisions().filter((x) => x.key.includes('|pa|'))).toHaveLength(1); // *.npmjs.org · 경로 · IP · localhost 는 걸렀다
    expect(it.question).toContain("'registry.npmjs.org'에서 내려받기");
    expect(it.choices[0].effect).toContain('한 곳으로 나가는 접속만');
    expect(svc.applyDecisions([{ key: it.key, choice: it.choices[0].label }]).applied).toBe(1);
    const agents = svc.store.listAgents(p.id);
    expect(agents.find((x) => x.code === '09')!.allowedDomains).toEqual(['registry.npmjs.org']);
    expect(agents.filter((x) => x.code !== '09').every((x) => !(x.allowedDomains ?? []).length)).toBe(true); // 다른 직원은 그대로
    expect((svc.missions.get(m0.id).techNotes ?? []).some((x) => x.includes('registry.npmjs.org') && x.includes('허용'))).toBe(true);
    // 직원 설정에서 직접 넣을 때도 틀린 표기는 저장하지 않고 거절한다(값을 오류 글에 되풀이하지 않는다)
    const a09 = svc.store.listAgents(p.id).find((x) => x.code === '09')!;
    const { id: _i, projectId: _p, version: _v, updatedAt: _u, ...fields } = a09 as typeof a09 & { fired?: unknown };
    let err = '';
    try { svc.saveAgent(p.id, a09.id, { ...fields, allowedDomains: ['registry.npmjs.org', 'https://user:tok3n@evil.example.org/x?k=1'] } as never); } catch (e) { err = (e as Error).message; }
    expect(err).toContain('표기가 틀렸습니다'); expect(err).not.toContain('tok3n');
    expect(svc.store.listAgents(p.id).find((x) => x.code === '09')!.allowedDomains).toEqual(['registry.npmjs.org']);
    expect(svc.saveAgent(p.id, a09.id, { ...fields, allowedDomains: [' Registry.NPMJS.org ', 'registry.npmjs.org'] } as never).allowedDomains).toEqual(['registry.npmjs.org']);
    await svc.missions.stop(m0.id); svc.close();
  });

  it('주소 검사: 정확한 호스트 이름만 받고 와일드카드·IP·포트·경로·내부망 이름은 버린다', async () => {
    const { cleanDomain, cleanDomains, MAX_DOMAINS } = await import('../src/main/netallow');
    expect(cleanDomain(' Registry.NPMJS.org ')).toBe('registry.npmjs.org');
    for (const bad of ['*', '*.npmjs.org', 'npmjs.org:443', 'https://npmjs.org', 'npmjs.org/x', '10.0.0.5', '[::1]', 'localhost', 'db.internal', 'printer.local', 'a', 'a b.com', 'user@host.com', '', null, undefined, 'x'.repeat(260) + '.com'])
      expect(cleanDomain(bad), String(bad)).toBeNull();
    expect(cleanDomains(['db.internal', 'registry.npmjs.org', 'REGISTRY.npmjs.org', '*'])).toEqual(['registry.npmjs.org']);
    expect(cleanDomains(Array.from({ length: 30 }, (_, i) => `h${i}.npmjs.org`)).length).toBe(MAX_DOMAINS);
    expect(cleanDomains('registry.npmjs.org')).toEqual([]);
  });
});
