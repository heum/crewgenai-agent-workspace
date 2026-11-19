// 직원 기본 템플릿 시험 — 두 세트(개발팀 표준·범용 소규모)
import { describe, expect, it } from 'vitest';
import { mkService, plan, tmpProject } from './helpers';

const RO = ['Read', 'Grep', 'Glob', 'Skill']; // 읽기 전용(수정·명령 없음), 스킬은 사용

describe('직원 기본 템플릿', () => {
  it('세트 목록은 개발팀 표준(14명)과 범용 소규모(7명)이고, 특정 업무(조달 등)에 묶인 직원이 없다', () => {
    const dir = tmpProject(); const svc = mkService(dir);
    const sets = svc.agentTemplateSets();
    expect(sets.map((s) => [s.id, s.agents.length])).toEqual([['dev', 14], ['general', 7]]);
    const text = JSON.stringify(sets);
    for (const w of ['공고', '조달', '회사정보', '가입·무료']) expect(text).not.toContain(w);
    svc.close();
  });

  for (const [setId, count, ro] of [['dev', 14, ['07', '08']], ['general', 7, ['05']]] as const) {
    it(`${setId}: 직원마다 역할·맡는 일·하지 않는 일·공통 규칙·보고 형식이 있고, 검토자는 읽기 전용이며 검토 담당이 배정된다`, () => {
      const dir = tmpProject(); const svc = mkService(dir);
      const p = svc.createProject(plan(dir));
      const agents = svc.loadAgentTemplates(p.id, setId);
      expect(agents.length).toBe(count);
      for (const a of agents) {
        for (const k of ['[역할]', '[목적]', '[맡는 일]', '[좋은 결과]', '[하지 않는 일]', '[공통 규칙]', '[스킬]', '[보고 형식]']) expect(a.instructions, `${a.code} ${k}`).toContain(k);
        expect(`당신은 CREWGENAI 개발팀의 ${a.code} ${a.name}(${a.role}). ${a.instructions}`.length).toBeLessThan(4000);
        expect(a.reviewerAgentId, `${a.code} 검토 담당`).not.toBeNull();
        expect(a.reviewerAgentId).not.toBe(a.id);
      }
      for (const c of ro) expect(agents.find((a) => a.code === c)!.tools).toEqual(RO);
      // 사용량이 많은 Fable 5.2는 설계 자리 하나만, 총괄·구현·리뷰·보안은 Opus 5.5, 정리·실행은 Sonnet 5.5. 모든 직원이 스킬 사용
      const MODELS = ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5'];
      for (const a of agents) { expect(MODELS).toContain(a.model); expect(['medium', 'high']).toContain(a.effort); expect(a.tools).toContain('Skill'); }
      expect(agents.find((a) => a.code === '00')!.model).toBe('claude-opus-5-5');
      expect(agents.filter((a) => a.model === 'claude-fable-5-2').map((a) => a.code)).toEqual(['02']);
      expect(agents.find((a) => a.code === '00')!.instructions).toContain('스킬 이름');
      expect(new Set(agents.map((a) => a.model)).size).toBeGreaterThan(1);
      // 기본 흐름이 이 세트로도 오류 없이 만들어진다
      const saved = svc.saveGraph(p.id, svc.defaultGraph(p.id), '기본');
      expect(saved.issues.filter((i) => i.level === 'error')).toEqual([]);
      svc.close();
    });
  }

  it('다시 불러오거나 다른 세트를 불러와도 같은 코드의 기존 직원은 바꾸지 않는다', () => {
    const dir = tmpProject(); const svc = mkService(dir);
    const p = svc.createProject(plan(dir));
    const first = svc.loadAgentTemplates(p.id, 'general');
    const lead = first.find((a) => a.code === '00')!;
    svc.saveAgent(p.id, lead.id, { ...lead, instructions: '사용자가 고친 지시' });
    const after = svc.loadAgentTemplates(p.id, 'dev');
    expect(after.find((a) => a.code === '00')!.instructions).toBe('사용자가 고친 지시');
    expect(after.find((a) => a.code === '03')!.name).toBe('작성·구현'); // 범용 세트의 03 유지
    expect(after.length).toBe(14); // 개발팀 세트의 07~13만 추가
    svc.close();
  });
});
