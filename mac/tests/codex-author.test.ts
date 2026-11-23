// 직원별 실행 도구: 작성자를 Codex로 돌려도 격리 복사본·범위 검사·원본 반영·검증 절차는 그대로다
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexAuthorArgs, codexAuthorModel, interpretCodexLine } from '../src/main/cli/codexCli';
import { codexSkillNote } from '../src/main/engine/engine';
import { gitInit, mkService, plan, tmpProject } from './helpers';

async function waitMission(svc: ReturnType<typeof mkService>, id: string, statuses: string[], ms = 60000) {
  const t0 = Date.now();
  for (;;) {
    const m = svc.missions.get(id);
    if (statuses.includes(m.status)) return m;
    if (Date.now() - t0 > ms) throw new Error(`시간 초과: ${m.status}/${m.stage}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Codex 작성자', () => {
  it('실행 인자: 작업 폴더에서만 쓰기, 네트워크 끔, 기본 환경 변수만, 세션 안 남김', () => {
    const a = codexAuthorArgs('gpt-6.2-astra', 'high', '/w', '/o.txt');
    expect(a).toEqual(expect.arrayContaining(['-s', 'workspace-write', '-C', '/w', '--ephemeral', '--json', '-o', '/o.txt', 'sandbox_workspace_write.network_access=false', 'shell_environment_policy.inherit="core"']));
    expect(a).not.toContain('danger-full-access');
    expect(codexAuthorModel('claude-opus-5-5', 'gpt-6.2-sol')).toBe('gpt-6.2-sol'); // Claude 모델이 남아 있으면 설정의 Codex 모델
    expect(codexAuthorModel('gpt-6.2-astra', 'gpt-6.2-sol')).toBe('gpt-6.2-astra');
    const sink = { thread: null, usage: null, last: '', failed: '' };
    interpretCodexLine('{"type":"item.completed","item":{"type":"agent_message","text":"끝"}}', sink);
    interpretCodexLine('{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":2}}', sink);
    expect(codexSkillNote(['superpowers:test-driven-development'], '/b')).toContain('/b/superpowers/skills/test-driven-development/SKILL.md'); // 스킬 파일 경로를 정확히 준다
    expect(sink.last).toBe('끝'); expect(sink.usage).toEqual({ input_tokens: 5, output_tokens: 2 });
  });

  it('저장 검사: Codex 직원은 Codex 모델만, Claude 직원은 Codex 모델을 쓸 수 없다', () => {
    const dir = tmpProject(); gitInit(dir); const svc = mkService(dir);
    const p = svc.createProject(plan(dir, { writablePaths: ['docs'] }));
    svc.loadAgentTemplates(p.id);
    const a = svc.store.listAgents(p.id).find((x) => x.tools.includes('Edit') || x.tools.includes('Write'))!;
    const { id: _i, projectId: _p, version: _v, updatedAt: _u, ...f } = a;
    expect(() => svc.saveAgent(p.id, a.id, { ...f, runner: 'codex', model: 'claude-opus-5-5' })).toThrow('Codex 모델');
    expect(() => svc.saveAgent(p.id, a.id, { ...f, runner: 'claude', model: 'gpt-6.2-astra' })).toThrow('실행 도구를 Codex');
    expect(svc.saveAgent(p.id, a.id, { ...f, runner: 'codex', model: 'gpt-6.2-astra' }).runner).toBe('codex');
    svc.close();
  });

  it('미션 작업을 Codex 작성자가 하면 격리 복사본에서 쓰고, 검사를 거쳐 원본에 반영된다', async () => {
    const dir = tmpProject(); gitInit(dir); const svc = mkService(dir);
    const p = svc.createProject(plan(dir, { writablePaths: ['docs'] }));
    svc.loadAgentTemplates(p.id);
    svc.saveSettings({ missionMaxCycles: 1 });
    for (const a of svc.store.listAgents(p.id).filter((x) => x.tools.includes('Edit') || x.tools.includes('Write'))) {
      const { id: _i, projectId: _p, version: _v, updatedAt: _u, ...f } = a;
      svc.saveAgent(p.id, a.id, { ...f, runner: 'codex', model: 'gpt-6.2-astra', effort: 'high' });
    }
    const m0 = await svc.startMission(p.id, '[[mock:code]] 문서를 정리하라');
    const m = await waitMission(svc, m0.id, ['done', 'waiting_user', 'failed']);
    const r1 = svc.engine.detail(svc.missions.detail(m.id).cycles[0].runId);
    const authors = r1.attempts.filter((a) => a.role === 'author');
    expect(authors.length).toBeGreaterThan(0);
    for (const a of authors) {
      expect(a.argvRedacted.join(' ')).toContain('workspace-write');
      expect(a.argvRedacted.join(' ')).toContain('gpt-6.2-astra');
    }
    const ok = authors.find((a) => a.status === 'succeeded')!;
    expect(ok).toBeTruthy();
    expect(ok.changedFiles.length).toBeGreaterThan(0);
    expect(ok.usage).toMatchObject({ input_tokens: 100 });
    const f = ok.changedFiles[0];
    expect(existsSync(join(dir, f))).toBe(true);
    expect(readFileSync(join(dir, f), 'utf8')).toContain('codex(모의)'); // 복사본에서 쓴 것이 원본에 반영됨
    const gates = r1.graph.nodes.filter((n) => (n.kind === 'review' || n.kind === 'codexReview') && !n.cycleReview).map((n) => n.id);
    expect(gates.length).toBeGreaterThan(0); // 검증 단계는 실행 도구와 상관없이 그대로 있다
    expect(r1.nodes.filter((n) => gates.includes(n.nodeId)).every((n) => n.status === 'succeeded')).toBe(true);
    expect(m.status).toBe('done');
    svc.close();
  });
});
