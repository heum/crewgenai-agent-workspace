// 내 PC에 남는 기록 시험: 앱을 닫았다 다시 열어도(업데이트로 새 판을 설치해도 같은 데이터 파일을 쓴다) 프로젝트·직원·설정·이력이 그대로 남는다.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Service } from '../src/main/service';
import { MOCK, plan, tmpProject } from './helpers';

describe('로컬 기록 유지', () => {
  it('앱을 다시 열면 같은 데이터 파일에서 프로젝트·기획 이력·직원(휴가·해고)·설정을 그대로 불러온다', () => {
    const dir = tmpProject();
    const dbFile = join(dir, '..', 'persist.sqlite');
    const a = new Service({ dbFile, mockScript: MOCK, emit: () => {} });
    a.saveSettings({ executor: 'mock', maxConcurrent: 2, missionMaxCycles: 7, codexModel: 'gpt-6.1-sol' });
    const p = a.createProject(plan(dir, { name: '내 프로젝트' }));
    a.updatePlan(p.id, { ...p.plan, goal: '바뀐 목표' });
    const agents = a.loadAgentTemplates(p.id, 'general');
    const onLeave = agents.find((x) => x.code === '02')!;
    a.setAgentActive(onLeave.id, false);
    const fired = agents.find((x) => x.code === '05')!;
    a.fireAgent(fired.id);
    a.close();

    const b = new Service({ dbFile, mockScript: MOCK, emit: () => {} });
    const s = b.settings();
    expect([s.executor, s.maxConcurrent, s.missionMaxCycles, s.codexModel]).toEqual(['mock', 2, 7, 'gpt-6.1-sol']);
    const p2 = b.store.listProjects().find((x) => x.id === p.id)!;
    expect(p2.plan.name).toBe('내 프로젝트');
    expect(p2.plan.goal).toBe('바뀐 목표');
    expect(p2.planVersion).toBe(2);
    const list = b.store.listAgents(p.id);
    expect(list.length).toBe(6); // 7명 중 1명 해고
    expect(list.find((x) => x.id === onLeave.id)!.active).toBe(false); // 휴가 유지
    expect(b.store.listAgents(p.id, true).find((x) => x.id === fired.id)!.fired).toBe(true); // 해고 기록 유지
    b.close();
  });
});
