// 사이클 줄이기: cd 후에도 맞는 수정 권한 규칙, 시험 대상 저장소 복사, 수작업 요청 금지 규칙
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { referencedRepos } from '../src/main/autopilot';
import { absRules, buildClaudeArgs } from '../src/main/cli/claudeCli';
import { gitInit, tmpProject } from './helpers';

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
