// 사이클 줄이기: cd 후에도 맞는 수정 권한 규칙, 시험 대상 저장소 복사, 수작업 요청 금지 규칙
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { referencedRepos } from '../src/main/autopilot';
import { absRules, buildClaudeArgs } from '../src/main/cli/claudeCli';
import { gitInit, mkService, plan, tmpProject } from './helpers';

describe('사이클 줄이기', () => {
  it('수정 범위 규칙은 작업 폴더 절대 경로로도 만든다(Bash에서 cd 해도 범위 안 쓰기가 거부되지 않게)', () => {
    const d = tmpProject();
    const real = realpathSync(d);
    expect(absRules('Edit(./out/**)', d)).toEqual(expect.arrayContaining(['Edit(./out/**)', `Edit(/${d}/out/**)`, `Edit(/${real}/out/**)`]));
    expect(absRules('Read(~/.ssh/**)', d)).toEqual(['Read(~/.ssh/**)']);
    // 아직 만들지 않은 격리 폴더도 실제 경로 규칙을 받는다
    expect(absRules('Edit(./docs/**)', join(d, 'not-yet', 'iso'))).toContain(`Edit(/${real}/not-yet/iso/docs/**)`);
    const args = buildClaudeArgs({ prompt: 'x', appendSystemPrompt: '', cwd: d, tools: ['Read', 'Edit', 'Bash'], editScopes: ['docs'], allowedCommands: [], readDirs: [], sessionId: null, resumeSessionId: null, jsonSchema: null, model: '', maxBudgetUsd: null, commandLevel: 'medium' });
    const s = JSON.parse(args[args.indexOf('--settings') + 1]);
    expect(s.permissions.allow).toContain(`Edit(/${real}/docs/**)`);
    expect(s.permissions.deny).toContain(`Edit(/${real}/.git/**)`);
  });

  it('입력·지시에 이름이 나온 저장소를 찾는다(시험 대상 저장소를 격리 복사본에 넣기 위해)', () => {
    const root = tmpProject();
    for (const n of ['api-server', 'web', 'docs-repo']) { mkdirSync(join(root, n)); gitInit(join(root, n)); }
    expect(referencedRepos(root, ['docs-repo/stage01/out.md', 'api-server/scripts/gradle.sh test 를 실행한다'])).toEqual(['api-server', 'docs-repo']);
    expect(referencedRepos(root, ['my-web/x 와 webapp 은 다른 이름'])).toEqual([]);
  });
});

describe('작업별 결과물', () => {
  it('판단이 적은 결과물 중 프로젝트 안 파일과 이 컴퓨터 화면 주소만 남긴다', async () => {
    const { resolveResults } = await import('../src/main/mission');
    const { writeFileSync, symlinkSync } = await import('node:fs');
    const d = tmpProject();
    mkdirSync(join(d, 'docs'), { recursive: true }); writeFileSync(join(d, 'docs', 'a.md'), 'A');
    const outside = tmpProject(); writeFileSync(join(outside, 'secret.txt'), 'S');
    symlinkSync(join(outside, 'secret.txt'), join(d, 'docs', 'link.txt'));
    const rs = resolveResults(d, [
      { task: 'T1', title: '문서', path: 'docs/a.md', changed: '추가', check: '표 확인' },
      { task: 'T1', title: '아직 없음', path: 'docs/none.png', changed: '', check: '' },
      { task: 'T2', title: '화면', path: 'http://localhost:3211/review/login', changed: '', check: '' },
      { task: 'T2', title: '외부', path: 'https://example.com/x', changed: '', check: '' },
      { task: 'T3', title: '밖', path: '../etc/passwd', changed: '', check: '' },
      { task: 'T3', title: '링크로 밖', path: 'docs/link.txt', changed: '', check: '' },
    ]);
    expect(rs.map((r) => [r.title, r.kind, r.exists])).toEqual([['문서', 'file', true], ['아직 없음', 'file', false], ['화면', 'url', true]]);
    expect(rs[0].relPath).toBe('docs/a.md');
    expect(rs[0].check).toBe('표 확인');
  });
});

describe('격리 복사본 쓰기 막힘(실제 미션에서 발견)', () => {
  it('앱 임시 폴더(격리 복사본 등) 경로는 참고 자료로 저장·사용하지 않는다', async () => {
    const { isAppTempPath, isolatedDir } = await import('../src/main/engine/fsutil');
    const { tmpdir } = await import('node:os');
    const iso = isolatedDir('x:y');
    expect(isAppTempPath(iso)).toBe(true);
    expect(isAppTempPath(join(iso, '..'))).toBe(true); // 격리 복사본 루트
    expect(isAppTempPath(realpathSync(tmpdir()) + '/crewgenai-iso/abc/doc.md')).toBe(true);
    expect(isAppTempPath(join(tmpdir(), 'other', 'a.md'))).toBe(false);
    expect(isAppTempPath(tmpProject())).toBe(false);
  });

  it('작업 폴더를 포함하는 상위 폴더는(링크 경로·실제 경로가 달라도) 참고 폴더로 열지 않는다(쓰기 금지도, 쓰기 허용도 되지 않게)', async () => {
    const { tmpdir } = await import('node:os');
    const parent = join(tmpdir(), `crewgenai-iso-test-${Date.now()}`); mkdirSync(join(parent, 'w'), { recursive: true });
    const cwd = join(parent, 'w'); // /var/… 형태
    const args = buildClaudeArgs({ prompt: 'x', appendSystemPrompt: '', cwd, tools: ['Read', 'Bash'], editScopes: [], allowedCommands: [], readDirs: [realpathSync(parent), '/opt/ref'], sessionId: null, resumeSessionId: null, jsonSchema: null, model: '', maxBudgetUsd: null, commandLevel: 'medium' });
    const s = JSON.parse(args[args.indexOf('--settings') + 1]);
    expect(s.sandbox.filesystem.denyWrite).toEqual(['/opt/ref']);
    expect(args.filter((a, i) => args[i - 1] === '--add-dir')).toEqual(['/opt/ref']);
  });

  it('기획 저장 때 참고 자료에서 앱 임시 폴더 경로를 뺀다(예전에 들어간 경로도 다음 저장 때 정리)', async () => {
    const { isolatedDir } = await import('../src/main/engine/fsutil');
    const dir = tmpProject(); gitInit(dir); const svc = mkService(dir);
    const p = svc.createProject(plan(dir));
    const keep = tmpProject();
    const saved = svc.updatePlan(p.id, { ...p.plan, referenceDocs: [keep, isolatedDir('a:b'), join(isolatedDir('a:b'), '..')], priorOutputs: [join(isolatedDir('c:d'), 'x.md')] });
    expect(saved.plan.referenceDocs).toEqual([keep]);
    expect(saved.plan.priorOutputs).toEqual([]);
    svc.close();
  });
});

describe('결정 팝업 선택지', () => {
  it('선택지는 4개까지, 추천은 하나만 남기고 이유는 추천 안에만 둔다', async () => {
    const { cleanChoices } = await import('../src/main/mission');
    const c = cleanChoices([
      { label: 'A안', effect: 'A로 고친다', recommended: true, why: '근거가 분명' },
      { label: 'B안', effect: 'B로 고친다', recommended: true, why: '이것도' },
      { label: 'A안', effect: '중복', recommended: false, why: '' },
      { label: '', effect: '빈 문구', recommended: false, why: '' },
      { label: 'C안', effect: '', recommended: false, why: '무시' },
      { label: 'D안', effect: '', recommended: false, why: '' },
      { label: 'E안', effect: '', recommended: false, why: '' },
    ]);
    expect(c.map((x) => x.label)).toEqual(['A안', 'B안', 'C안', 'D안']);
    expect(c.filter((x) => x.recommended).map((x) => x.label)).toEqual(['A안']);
    expect(c[1].why).toBe('');
    expect(c[2].why).toBe('');
    expect(cleanChoices('x')).toEqual([]);
  });
});

describe('직원 캐릭터', () => {
  it('기본 템플릿 직원은 직군별 기본 캐릭터를 받고(시안 배정표), 캐릭터 번호는 20종만 저장된다', async () => {
    const { TEMPLATE_SETS } = await import('../src/main/engine/templates');
    const want: Record<string, string> = { '00': 'C01', '01': 'C04', '02': 'C06', '03': 'C03', '04': 'C07', '05': 'C08', '06': 'C12', '07': 'C17', '08': 'C15', '09': 'C20', '10': 'C09', '11': 'C05', '12': 'C11' };
    for (const a of TEMPLATE_SETS.dev.agents) expect([a.code, a.character]).toEqual([a.code, want[a.code]]);
    expect(TEMPLATE_SETS.general.agents.every((a) => /^C(0[1-9]|1\d|20)$/.test(a.character ?? ''))).toBe(true);
    const dir = tmpProject(); gitInit(dir); const svc = mkService(dir);
    const p = svc.createProject(plan(dir));
    const list = svc.loadAgentTemplates(p.id);
    const be = list.find((a) => a.code === '03')!;
    const { id, projectId, version: _v, updatedAt: _u, ...f } = be;
    expect(svc.saveAgent(projectId, id, { ...f, character: 'C05' }).character).toBe('C05');
    expect(svc.saveAgent(projectId, id, { ...f, character: 'C99' }).character).toBeUndefined(); // 없는 번호는 저장하지 않음
    svc.saveAgent(projectId, id, { ...f, character: 'C05' });
    svc.loadAgentTemplates(p.id); // 템플릿을 다시 불러와도 고른 캐릭터 유지
    expect(svc.store.listAgents(p.id).find((a) => a.code === '03')!.character).toBe('C05');
    svc.close();
  });
});

describe('사용자가 직접 허용한 명령', () => {
  it('범위 높음의 차단 목록보다 직원별 허용이 우선한다(그 명령만 차단에서 빠짐)', async () => {
    const { highDenyRules } = await import('../src/main/autopilot');
    const all = highDenyRules();
    const some = highDenyRules(['curl', 'kill -TERM']);
    expect(all).toContain('Bash(curl *)'); expect(all).toContain('Bash(kill *)');
    expect(some).not.toContain('Bash(curl *)'); expect(some).not.toContain('Bash(/usr/bin/curl *)');
    expect(some).toContain('Bash(kill *)'); // 'kill -TERM'은 'kill' 전체를 풀지 않는다
    expect(some).toContain('Bash(sudo *)');
  });
});
