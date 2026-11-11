// 배운 것·검토 필요 시험: 대화에서 배운 것을 저장해 다음 지시에 반영, 환경 문제·반복 실패는 멈추고 검토 목록 맨 앞에
import { describe, expect, it } from 'vitest';
import type { Mission } from '../src/shared/types';
import { ENV_FAILURE, failureSig } from '../src/main/mission';
import { gitInit, mkService, plan, sleep, tmpProject } from './helpers';

async function waitFor<T>(fn: () => T | undefined | null | false, ms = 60000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v as T; if (Date.now() - t0 > ms) throw new Error('시간 초과'); await sleep(50); }
}
function setup() {
  const dir = tmpProject(); gitInit(dir); const svc = mkService(dir);
  const p = svc.createProject(plan(dir, { writablePaths: ['docs'] }));
  svc.loadAgentTemplates(p.id);
  return { dir, svc, p };
}

describe('배운 것', () => {
  it('미션이 끝나면 대화에서 배운 것을 저장하고(검토 필요 표시), 다음 지시의 오퍼레이터·직원 지시에 붙인다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:learn:global:preference:표보다 목록으로 정리한다]] [[mock:learn:project:environment:해시 계산은 shasum -a 256을 쓴다]] 문서를 정리하라');
    await waitFor(() => ['done', 'waiting_user', 'failed'].includes(svc.missions.get(m0.id).status));
    const learned = await waitFor(() => (svc.learnings.list().length >= 2 ? svc.learnings.list() : null));
    const g = learned.find((l) => l.scope === 'global')!;
    expect(g.text).toBe('표보다 목록으로 정리한다');
    expect(g.reviewed).toBe(false);
    expect(learned.find((l) => l.scope === 'project')!.projectId).toBe(p.id);
    expect(svc.attention().learningsToReview).toBe(2);
    // 다른 프로젝트에는 공통 항목만 반영
    const other = tmpProject();
    const p2 = svc.createProject(plan(other, { name: '다른 프로젝트' }));
    expect(svc.learnings.promptSection(p2.id)).toContain('표보다 목록으로 정리한다');
    expect(svc.learnings.promptSection(p2.id)).not.toContain('shasum');
    expect(svc.learnings.promptSection(p.id)).toContain('shasum');
    // 같은 내용은 다시 저장하지 않고, 사용자가 끄면 반영하지 않는다
    expect(svc.learnings.add({ scope: 'global', projectId: null, kind: 'preference', text: '표보다  목록으로 정리한다' }, { source: 'x', reviewed: false })).toBeNull();
    svc.learnings.update(g.id, { active: false });
    expect(svc.learnings.promptSection(p2.id)).toBe('');
    expect(svc.learnings.get(g.id).reviewed).toBe(true); // 사용자가 손대면 검토한 것으로
    // 설정에서 학습을 끄면 정리하지 않는다
    svc.saveSettings({ learning: false });
    svc.missions.answer(m0.id, '', 'stop');
    const before = svc.learnings.list().length;
    const m1 = await svc.startMission(p.id, '[[mock:learn:global:rule:배포하지 않는다]] 다시 정리하라');
    await waitFor(() => ['done', 'waiting_user', 'failed'].includes(svc.missions.get(m1.id).status));
    await sleep(500);
    expect(svc.learnings.list().length).toBe(before);
    svc.close();
  });

  it('비밀값은 가려서 저장한다', () => {
    const { svc } = setup();
    const r = svc.learnings.add({ scope: 'global', projectId: null, kind: 'environment', text: 'API 키는 sk-ant-api03-FAKEFAKEFAKE1234 를 쓴다' }, { source: 'x', reviewed: false })!;
    expect(r.text).not.toContain('FAKEFAKEFAKE1234');
    const r2 = svc.learnings.add({ scope: 'global', projectId: null, kind: 'fact', text: '출처 가림 시험' }, { source: '미션: token=sk-ant-api03-SOURCEFAKE12345 정리', reviewed: false })!;
    expect(r2.source).not.toContain('SOURCEFAKE12345');
    svc.close();
  });
});

describe('에이전트가 풀 수 없는 실패', () => {
  it('내 PC 환경 문제로 보이는 실패와 같은 원인의 반복을 알아본다', () => {
    for (const r of ['spawn shasum ENOENT', 'zsh: command not found: playwright', "'npx' is not recognized as an internal or external command", '검사를 실행하지 못함: spawn /x ENOENT', 'getaddrinfo ENOTFOUND registry.npmjs.org']) expect(ENV_FAILURE.test(r), r).toBe(true);
    expect(ENV_FAILURE.test('검사 실패(종료 코드 1)')).toBe(false);
    expect(ENV_FAILURE.test('Codex 지적: authentication route returns 500 instead of 401')).toBe(false); // 앱 기능 설명은 PC 환경 문제가 아님
    expect(ENV_FAILURE.test('certificate 검증 로직 누락')).toBe(false);
    // 같은 단계·같은 종료 코드면 경로·해시가 달라도 같은 원인, 단계나 종료 코드가 다르면 다른 원인
    expect(failureSig('검사 실패(종료 코드 1) /Users/a/b/c.md 3f2a9c1d', '검사: 문서 작성 1')).toBe(failureSig('검사 실패(종료 코드 1) /tmp/x.md 9e8d7c6b5', '검사: 문서 작성 2'));
    expect(failureSig('검사 실패(종료 코드 1)', '검사: 문서 작성')).not.toBe(failureSig('검사 실패(종료 코드 2)', '검사: 문서 작성'));
    expect(failureSig('검사 실패(종료 코드 1)', '검사: 문서 작성')).not.toBe(failureSig('검사 실패(종료 코드 1)', '검사: 화면 연결'));
  });

  it('검토가 필요한 항목을 모아 권한·환경 문제를 맨 앞에 둔다', async () => {
    const { svc, p } = setup();
    const m0 = await svc.startMission(p.id, '[[mock:deny:bash:shasum -a 256 /x/a.html]] 해시를 구하라');
    await waitFor(() => svc.missions.get(m0.id).status === 'waiting_user');
    const a = svc.attention();
    expect(a.items[0]).toMatchObject({ projectId: p.id, kind: 'denied', missionId: m0.id });
    svc.missions.answer(m0.id, '', 'stop');
    await sleep(200);
    expect(svc.attention().items.some((x) => x.missionId === m0.id)).toBe(false);
    svc.close();
  });
});
