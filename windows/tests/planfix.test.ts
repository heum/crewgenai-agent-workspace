// 계획 검사 실패 처리 — 사용자에게 바로 묻지 않고, 기계적으로 고칠 수 있으면 앱이 고치고, 아니면 오퍼레이터가 다시 계획한다
import { describe, expect, it } from 'vitest';
import { gitInit, mkService, plan, sleep, tmpProject } from './helpers';

async function until<T>(f: () => T | null | undefined | false, ms = 60000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('시간 초과'); await sleep(50); }
}
function setup() {
  const dir = tmpProject(); gitInit(dir); const svc = mkService(dir);
  const p = svc.createProject(plan(dir, { writablePaths: ['docs'] }));
  svc.loadAgentTemplates(p.id);
  return { svc, p };
}
const texts = (svc: ReturnType<typeof mkService>, id: string) => svc.missions.detail(id).events.map((e) => `${e.kind}:${e.text}`);

describe('계획 검사 실패', () => {
  it('산출물이 작업 수정 경로 밖이어도 기획의 허용 경로 안이면 그 파일만 수정 경로에 더해 그대로 실행한다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:out-sibling]] 문서를 정리하라');
    const m = await until(() => { const x = svc.missions.get(m0.id); return x.currentRunId || x.status === 'waiting_user' ? x : null; });
    expect(m.question ?? '').not.toContain('계획');
    expect(m.currentRunId).toBeTruthy();
    const node = svc.engine.detail(m.currentRunId!).graph.nodes.find((n) => n.kind === 'agent')!;
    expect(node.writeScope).toEqual(expect.arrayContaining(['docs/mission', 'docs/tests/cycle-1.md']));
    await svc.missions.stop(m0.id); svc.close();
  });

  it('고칠 수 없는 계획은 이유를 알려 오퍼레이터가 다시 계획하게 하고, 사용자에게 묻지 않는다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:bad-plan-once]] 문서를 정리하라');
    const m = await until(() => { const x = svc.missions.get(m0.id); return x.currentRunId || x.status === 'waiting_user' ? x : null; });
    expect(m.status).not.toBe('waiting_user');
    expect(m.currentRunId).toBeTruthy();
    expect(texts(svc, m0.id).some((t) => t.includes('오퍼레이터에게 고쳐서 다시 계획하게 합니다(1/2)'))).toBe(true);
    await svc.missions.stop(m0.id); svc.close();
  });
});
