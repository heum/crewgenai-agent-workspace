// 자동 처리(사람 손 줄이기): 작업 브랜치 자동 생성, 저장소 시험 명령 허용, 프로젝트 스킬, 문서 저장소 최신화
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { docReposFor, isDocRepo, levelAllows, materializeLink, projectSkillDirs, repoTestCommands, scrubSecretEnv, workBranchName } from '../src/main/autopilot';
import { buildClaudeArgs } from '../src/main/cli/claudeCli';
import { cleanupIsolated, isolatedDir, prepareIsolated } from '../src/main/engine/fsutil';
import { commitPaths, ignoredPaths, syncRepoFastForward } from '../src/main/git';
import { agentFields, e, gitInit, mkService, n, plan, tmpProject, waitRun } from './helpers';

const g = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'core.quotePath=false', ...a], { stdio: 'pipe' }).toString().trim();
const who = { name: 'CREWGENAI 10 작성', email: 'agent-10@crewgenai.local' };

function repo(root: string, name: string, branch = 'dev') {
  const d = join(root, name); mkdirSync(d, { recursive: true }); gitInit(d);
  if (branch !== 'main') g(d, 'switch', '-q', '-c', branch);
  return d;
}

describe('자동 처리: 작업 브랜치', () => {
  it('dev·main에 있으면 작업 브랜치를 만들어 커밋하고, 같은 미션은 같은 브랜치를 쓴다. dev는 그대로다', async () => {
    const d = repo(tmpProject(), 'r');
    const devHead = g(d, 'rev-parse', 'dev');
    writeFileSync(join(d, 'a.md'), 'A');
    const b = workBranchName('7f3a9c21-aaaa');
    expect(b).toBe('feat/crewgenai-7f3a9c21');
    const r1 = await commitPaths(d, ['a.md'], who, '시험 1', {}, new Set(), b);
    expect(r1.error).toBeNull();
    expect(r1.skipped).toContain(`작업 브랜치 ${b}`);
    expect(g(d, 'branch', '--show-current')).toBe(b);
    expect(g(d, 'rev-parse', 'dev')).toBe(devHead);
    writeFileSync(join(d, 'b.md'), 'B');
    const r2 = await commitPaths(d, ['b.md'], who, '시험 2', {}, new Set(), b);
    expect(r2.skipped).toBeNull(); // 이미 작업 브랜치: 옮기지 않음
    expect(g(d, 'rev-list', '--count', `dev..${b}`)).toBe('2');
  });

  it('사용자가 dev로 돌아가 있으면: 병합되지 않은 작업 브랜치와 섞지 않고 번호 붙은 새 브랜치에 커밋한다. 미커밋 사용자 변경은 그대로 따라간다', async () => {
    const d = repo(tmpProject(), 'r');
    const b = workBranchName('m1');
    writeFileSync(join(d, 'a.md'), 'A');
    await commitPaths(d, ['a.md'], who, '시험 1', {}, new Set(), b);
    g(d, 'switch', '-q', 'dev');
    writeFileSync(join(d, 'user.txt'), '사용자 작업');
    writeFileSync(join(d, 'c.md'), 'C');
    const r = await commitPaths(d, ['c.md'], who, '시험 3', {}, new Set(['user.txt']), b);
    expect(r.error).toBeNull();
    expect(g(d, 'branch', '--show-current')).toBe(`${b}-2`);
    expect(g(d, 'status', '--porcelain')).toContain('?? user.txt');
    expect(g(d, 'log', '-1', '--name-only', '--format=')).toBe('c.md');
  });

  it('작업 브랜치가 이미 dev에 병합됐으면 같은 이름을 지금 커밋으로 다시 맞춘다. 보호 브랜치가 아니거나 지정이 없으면 그대로 커밋한다', async () => {
    const d = repo(tmpProject(), 'r');
    const b = workBranchName('m2');
    writeFileSync(join(d, 'a.md'), 'A');
    await commitPaths(d, ['a.md'], who, '시험 1', {}, new Set(), b);
    g(d, 'switch', '-q', 'dev'); g(d, 'merge', '-q', '--ff-only', b);
    writeFileSync(join(d, 'b.md'), 'B');
    await commitPaths(d, ['b.md'], who, '시험 2', {}, new Set(), b);
    expect(g(d, 'branch', '--show-current')).toBe(b);
    expect(g(d, 'rev-list', '--count', `dev..${b}`)).toBe('1');
    // 사용자 작업 브랜치
    g(d, 'switch', '-q', '-c', 'feat/user-own');
    writeFileSync(join(d, 'c.md'), 'C');
    await commitPaths(d, ['c.md'], who, '시험 3', {}, new Set(), b);
    expect(g(d, 'branch', '--show-current')).toBe('feat/user-own');
    // 지정 없음(자동 처리 끔): 보호 브랜치에도 그대로
    g(d, 'switch', '-q', 'dev');
    writeFileSync(join(d, 'e.md'), 'E');
    await commitPaths(d, ['e.md'], who, '시험 4', {}, new Set());
    expect(g(d, 'branch', '--show-current')).toBe('dev');
    expect(g(d, 'log', '-1', '--format=%s')).toBe('시험 4');
  });
});

describe('자동 처리: 저장소 시험 명령·스킬·문서 저장소', () => {
  it('저장소에 실제로 있는 시험 스크립트만 찾는다(링크 스크립트 제외), Gradle 캐시는 쓰기 허용 폴더로 준다', () => {
    const root = tmpProject();
    const be = repo(root, 'backend');
    mkdirSync(join(be, 'scripts')); writeFileSync(join(be, 'scripts', 'gradle.sh'), '#!/bin/sh\n'); mkdirSync(join(be, '.gradle'));
    const df = repo(root, 'dataflow'); mkdirSync(join(df, 'scripts')); writeFileSync(join(df, 'scripts', 'check.sh'), '#!/bin/sh\n');
    const fe = repo(root, 'front'); mkdirSync(join(fe, 'scripts')); writeFileSync(join(fe, 'scripts', 'npm.sh'), '#!/bin/sh\n');
    writeFileSync(join(fe, 'package.json'), JSON.stringify({ scripts: { check: 'tsc' } })); mkdirSync(join(fe, 'node_modules'));
    const fe2 = repo(root, 'front2'); writeFileSync(join(fe2, 'package.json'), JSON.stringify({ scripts: { test: 'x' } })); // check 없음
    const ev = repo(root, 'evil'); mkdirSync(join(ev, 'scripts')); symlinkSync('/bin/sh', join(ev, 'scripts', 'check.sh'));
    const docs = repo(root, 'docs'); mkdirSync(join(docs, 'skills', 'a'), { recursive: true }); writeFileSync(join(docs, 'skills', 'a', 'SKILL.md'), '---\nname: a\n---\n');
    mkdirSync(join(be, 'skills', 'empty'), { recursive: true }); // SKILL.md 없는 폴더는 스킬 폴더 아님
    const cmds = repoTestCommands(root);
    expect(cmds.map((c) => c.prefix).sort()).toEqual(['./backend/scripts/gradle.sh', './dataflow/scripts/check.sh', './front/scripts/npm.sh run check']);
    expect(cmds.find((c) => c.repo === 'backend')!.writeDirs).toEqual([]); // 실제 캐시에는 쓰지 않는다
    expect(cmds.find((c) => c.repo === 'backend')!.cloneDirs).toEqual(['backend/.gradle']);
    expect(cmds.find((c) => c.repo === 'front')!.cloneDirs).toEqual(['front/node_modules']);
    expect(repoTestCommands(fe).map((c) => c.prefix)).toEqual(['./scripts/npm.sh run check']); // 저장소 하나를 연결
    expect(projectSkillDirs(root)).toEqual([join(docs, 'skills', 'a')]);
    // 저장소 밖을 가리키는 스킬 링크는 받지 않는다(같은 폴더의 다른 스킬은 하나씩 받음)
    const priv = join(root, '..', 'private-skill'); mkdirSync(priv); writeFileSync(join(priv, 'SKILL.md'), '---\nname: p\n---\n');
    symlinkSync(priv, join(docs, 'skills', 'leak'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(projectSkillDirs(root)).toEqual([join(docs, 'skills', 'a')]);
    // 스킬 폴더 안의 플러그인(그 안의 링크)도 받지 않는다
    mkdirSync(join(docs, 'skills', 'plug', '.claude-plugin'), { recursive: true }); mkdirSync(join(docs, 'skills', 'plug', 'skills'));
    symlinkSync(priv, join(docs, 'skills', 'plug', 'skills', 'leak2'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(projectSkillDirs(root)).toEqual([join(docs, 'skills', 'a')]);
    // 'SKILL.md'라는 이름의 폴더·링크는 스킬 표시로 보지 않는다
    mkdirSync(join(docs, 'skills', 'plug', 'SKILL.md', 'placeholder'), { recursive: true });
    mkdirSync(join(docs, 'skills', 'lnk')); try { symlinkSync(join(priv, 'SKILL.md'), join(docs, 'skills', 'lnk', 'SKILL.md')); } catch { /* Windows 권한 없음: 파일 링크 시험 생략 */ }
    expect(projectSkillDirs(root)).toEqual([join(docs, 'skills', 'a')]);
    expect(scrubSecretEnv({ PATH: '/bin', AWS_SECRET_ACCESS_KEY: 'x', GITHUB_TOKEN: 'y', ANTHROPIC_API_KEY: 'k', DATABASE_URL: 'pg://', HOME: '/h' })).toEqual({ PATH: '/bin', ANTHROPIC_API_KEY: 'k', HOME: '/h' });
    expect(isDocRepo(docs)).toBe(true);
    expect(isDocRepo(fe)).toBe(false);
    // 최신화 대상: 프로젝트가 가리키는(또는 스킬을 가져오는) 문서 저장소만. 연결 폴더 전체 같은 상위 경로는 근거가 아니다
    const notes = repo(root, 'notes'); repo(root, 'unrelated');
    expect(docReposFor(root, [root, join(notes, 'a.md'), 'front']).map((r) => r.rel)).toEqual(['docs', 'notes']);
  });

  it('CLI 인자: 쓰기 허용 폴더와 로컬 소켓 허용은 지정했을 때만 격리 설정에 들어간다(외부 네트워크는 계속 막음)', () => {
    const base = { prompt: 'p', appendSystemPrompt: 's', cwd: '/w', editScopes: [], allowedCommands: ['./r/scripts/gradle.sh'], readDirs: [], sessionId: null, resumeSessionId: null, jsonSchema: null, model: '', maxBudgetUsd: null, tools: ['Read', 'Bash'] as ('Read' | 'Bash')[] };
    const on = JSON.parse(buildClaudeArgs({ ...base, writeDirs: ['/tmp/x', '/c/.gradle'], localBinding: true }).find((x, i, a) => a[i - 1] === '--settings')!);
    expect(on.sandbox.filesystem.allowWrite).toEqual(['/tmp/x', '/c/.gradle']);
    expect(on.sandbox.network).toEqual({ allowedDomains: [], allowLocalBinding: true });
    expect(on.sandbox.credentials.envVars.map((x: { name: string; mode: string }) => `${x.name}:${x.mode}`)).toEqual(['ANTHROPIC_API_KEY:deny', 'ANTHROPIC_AUTH_TOKEN:deny', 'CLAUDE_CODE_OAUTH_TOKEN:deny']);
    expect(on.permissions.allow).toContain('Bash(./r/scripts/gradle.sh *)');
    const off = JSON.parse(buildClaudeArgs(base).find((x, i, a) => a[i - 1] === '--settings')!);
    expect(off.sandbox.filesystem.allowWrite).toBeUndefined();
    expect(off.sandbox.network).toEqual({ allowedDomains: [] });
  });

  it('격리 복사본: 상위 폴더의 숨김 도구 폴더(공용 JDK 등)와 저장소의 .gradle·.venv는 복사하지 않고 링크한다', () => {
    const root = tmpProject();
    const be = repo(root, 'backend'); mkdirSync(join(be, '.gradle', 'user-home'), { recursive: true }); mkdirSync(join(be, '.venv'));
    mkdirSync(join(root, '.tools', 'jdk21'), { recursive: true }); writeFileSync(join(root, '.tools', 'jdk21', 'java'), 'x');
    const dir = isolatedDir(`autopilot-${Date.now()}`);
    prepareIsolated(root, dir, () => true, false, new Set(['backend']));
    expect(lstatSync(join(dir, '.tools')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(dir, 'backend', '.gradle')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(dir, 'backend', '.venv')).isSymbolicLink()).toBe(true);
    cleanupIsolated(dir);
    // 연결 폴더 자신이 저장소면 숨김 폴더(.github 등)는 저장소 내용이므로 그대로 복사한다
    mkdirSync(join(be, '.github')); writeFileSync(join(be, '.github', 'ci.yml'), 'x');
    const dir2 = isolatedDir(`autopilot2-${Date.now()}`);
    prepareIsolated(be, dir2, () => true, false);
    expect(lstatSync(join(dir2, '.github')).isDirectory()).toBe(true);
    cleanupIsolated(dir2);
  });

  it.runIf(process.platform === 'darwin')('의존성 복제: 앱이 만든 링크만 복제하고, 직원이 다른 곳으로 바꾼 링크는 복제하지 않는다', async () => {
    const root = tmpProject();
    const src = join(root, 'proj', 'node_modules'); mkdirSync(join(src, 'pkg'), { recursive: true }); writeFileSync(join(src, 'pkg', 'i.js'), 'x');
    const secret = join(root, 'secret'); mkdirSync(secret); writeFileSync(join(secret, 'id_rsa'), 'KEY');
    const iso = join(root, 'iso'); mkdirSync(join(iso, 'a'), { recursive: true }); mkdirSync(join(iso, 'b'));
    symlinkSync(src, join(iso, 'a', 'node_modules'));
    expect(await materializeLink(iso, 'a/node_modules', src)).toBe(true);
    expect(lstatSync(join(iso, 'a', 'node_modules')).isDirectory()).toBe(true);
    expect(readFileSync(join(iso, 'a', 'node_modules', 'pkg', 'i.js'), 'utf8')).toBe('x');
    symlinkSync(secret, join(iso, 'b', 'node_modules')); // 바꿔치기한 링크
    expect(await materializeLink(iso, 'b/node_modules', src)).toBe(false);
    expect(lstatSync(join(iso, 'b', 'node_modules')).isSymbolicLink()).toBe(true);
  });

  it('CLI 인자: 추론 강도는 허용 값만 --effort로 넘긴다', () => {
    const base = { prompt: 'p', appendSystemPrompt: 's', cwd: '/w', editScopes: [], allowedCommands: [], readDirs: [], sessionId: null, resumeSessionId: null, jsonSchema: null, model: 'claude-opus-5-5', maxBudgetUsd: null, tools: ['Read'] as 'Read'[] };
    const on = buildClaudeArgs({ ...base, effort: 'medium' });
    expect(on[on.indexOf('--effort') + 1]).toBe('medium');
    expect(on[on.indexOf('--model') + 1]).toBe('claude-opus-5-5');
    expect(buildClaudeArgs({ ...base, effort: 'medium; rm -rf' })).not.toContain('--effort');
    expect(buildClaudeArgs(base)).not.toContain('--effort');
  });

  it('명령 허용 범위: 중간은 조회·파일 정리·빌드·시험, 높음은 위험 명령 외 전부, 낮음은 없음', () => {
    for (const c of ['ls -la docs', 'cd backend', 'git log -1', 'npx tsc --noEmit', 'npm run check', './gradlew test', 'find . -name x', 'shasum -a 256 a']) expect(levelAllows('medium', c)).toBe(true);
    for (const c of ['rm -rf build', 'python3 x.py', 'curl http://x', 'git push origin dev', 'npx some-pkg', 'git commit -m x']) expect(levelAllows('medium', c)).toBe(false);
    for (const c of ['rm -rf build', 'python3 x.py', 'node a.js', 'sed -i s/a/b/ f']) expect(levelAllows('high', c)).toBe(true);
    for (const c of ['git push origin dev', 'sudo ls', 'open .', 'curl http://x', 'ssh host', 'kill 1', 'osascript -e x', 'security find-generic-password']) expect(levelAllows('high', c)).toBe(false);
    expect(levelAllows('low', 'ls')).toBe(false);
    // 묶은 명령은 부분마다 본다
    expect(levelAllows('medium', 'ls -la | head -3')).toBe(true);
    expect(levelAllows('medium', 'ls | curl https://example.com')).toBe(false);
    expect(levelAllows('medium', 'cd backend && npm test')).toBe(false); // CLI가 거부하는 형태
    expect(levelAllows('medium', 'ls $(whoami)')).toBe(false);
    expect(levelAllows('high', 'cd backend && npm test')).toBe(true);
    expect(levelAllows('high', 'ls; git push origin dev')).toBe(false);
    expect(levelAllows('medium', "rg 'foo|bar' src")).toBe(true); // 따옴표 안의 | 는 나누지 않는다
    expect(levelAllows('medium', 'ls & curl https://example.com')).toBe(false);
    expect(levelAllows('low', 'npm test && curl https://x', ['npm test'])).toBe(false); // 직원 허용 명령도 부분마다
    expect(levelAllows('low', 'npm test -- --run', ['npm test'])).toBe(true);
    expect(levelAllows('medium', 'echo "$(id)"')).toBe(false);
    expect(levelAllows('medium', 'npm test 2>&1')).toBe(true); // 리디렉션은 구분자가 아니다
    for (const c of ['/bin/kill 123', 'command kill 123', 'env kill 123', 'env FOO=1 git push origin', 'xargs kill']) expect(levelAllows('high', c)).toBe(false);
    expect(levelAllows('medium', 'rg "foo\\"|bar" src')).toBe(true); // 큰따옴표 안의 \" 는 닫는 따옴표가 아니다
  });

  it('CLI 인자: 범위에 따라 Bash 허용 규칙을 넣고, 높음은 위험 명령을 거부 규칙으로 막는다', () => {
    const base = { prompt: 'p', appendSystemPrompt: 's', cwd: '/w', editScopes: [], allowedCommands: [], readDirs: [], sessionId: null, resumeSessionId: null, jsonSchema: null, model: '', maxBudgetUsd: null, tools: ['Read', 'Bash'] as ('Read' | 'Bash')[] };
    const perms = (lv: 'low' | 'medium' | 'high') => { const a = buildClaudeArgs({ ...base, commandLevel: lv }); return JSON.parse(a[a.indexOf('--settings') + 1]).permissions as { allow: string[]; deny: string[] }; };
    expect(perms('low').allow.some((x) => x.startsWith('Bash'))).toBe(false);
    expect(perms('medium').allow).toContain('Bash(ls *)');
    expect(perms('medium').allow).not.toContain('Bash');
    expect(perms('high').allow).toContain('Bash');
    expect(perms('high').deny).toEqual(expect.arrayContaining(['Bash(git push *)', 'Bash(sudo *)', 'Bash(open *)', 'Bash(/bin/kill *)', 'Bash(env kill *)']));
    const noBash = buildClaudeArgs({ ...base, tools: ['Read'], commandLevel: 'high' });
    expect(JSON.parse(noBash[noBash.indexOf('--settings') + 1]).permissions.allow).not.toContain('Bash');
  });

  it('실행: 범위 중간이면 쓰기 직원이 Bash(격리 실행)를 받고 실제 폴더는 읽기 전용으로 열리며, 범위 밖 변경은 실제 폴더에 반영되지 않는다', async () => {
    const root = tmpProject();
    const be = repo(root, 'backend');
    const argvDir = join(root, '..', 'argv-lv'); mkdirSync(argvDir);
    process.env.CREWGENAI_MOCK_ARGV_DIR = argvDir;
    const svc = mkService(root);
    const p = svc.createProject(plan(root, { writablePaths: ['backend/docs'] }));
    const w = svc.saveAgent(p.id, null, agentFields('01', '작성자', { tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'] }));
    const inp = n('input', '입력');
    const work = n('agent', '작성', { agentId: w.id, instructions: '[[mock:write-outside:backend/leak.txt]]', writeScope: ['backend/docs'], outputs: [{ path: 'backend/docs/결과.md', format: 'markdown', required: true }] });
    const m = n('merge', '취합');
    const saved = svc.saveGraph(p.id, { nodes: [inp, work, m], edges: [e(inp, work), e(work, m)] }, '시험');
    const run = await svc.startRun(p.id, saved.version!.id);
    await waitRun(svc, run.id, ['review_wait', 'failed', 'succeeded']);
    const a = svc.store.runAttempts(run.id).find((x) => x.role === 'author')!;
    const rec = JSON.parse(readFileSync(join(argvDir, `${a.sessionId}.json`), 'utf8')) as { argv: string[]; cwd: string };
    expect(rec.argv[rec.argv.indexOf('--tools') + 1].split(',')).toContain('Bash');
    expect(JSON.parse(rec.argv[rec.argv.indexOf('--settings') + 1]).permissions.allow).toContain('Bash(git log *)');
    expect(rec.argv.some((x, i) => rec.argv[i - 1] === '--add-dir' && x === root)).toBe(true); // 실제 폴더는 읽기 전용
    expect(rec.cwd).not.toBe(root); // 격리 복사본에서 실행
    expect(existsSync(join(be, 'leak.txt'))).toBe(false); // 범위 밖 변경은 반영 안 함
    expect(a.outOfScopeChanges.join(' ')).toContain('backend/leak.txt');
    delete process.env.CREWGENAI_MOCK_ARGV_DIR;
    svc.close();
  });

  it('git이 무시하는 파일(빌드 산출물)을 찾는다', async () => {
    const root = tmpProject();
    const d = repo(root, 'r'); writeFileSync(join(d, '.gitignore'), 'build/\n');
    expect([...await ignoredPaths(root, ['r/build/x.class', 'r/src/A.java', 'other/build/y'])]).toEqual(['r/build/x.class']);
  });

  it('문서 저장소 최신화: 추적 브랜치를 fast-forward로만 받아 오고, 사용자 변경과 겹치거나 작업 브랜치면 그대로 둔다', async () => {
    const root = tmpProject();
    const origin = join(root, 'origin.git'); execFileSync('git', ['init', '-q', '--bare', '-b', 'dev', origin]);
    const up = repo(root, 'up'); g(up, 'remote', 'add', 'origin', origin); g(up, 'push', '-q', '-u', 'origin', 'dev');
    const local = join(root, 'local'); execFileSync('git', ['clone', '-q', '-b', 'dev', origin, local]);
    writeFileSync(join(up, 'doc.md'), '새 문서'); g(up, 'add', '-A'); g(up, 'commit', '-q', '-m', '문서'); g(up, 'push', '-q');
    writeFileSync(join(local, 'mine.md'), '사용자 작업 중'); // 겹치지 않는 사용자 변경은 그대로 두고 최신화
    const r1 = await syncRepoFastForward(local);
    expect(r1.moved).toBe(true);
    expect(readFileSync(join(local, 'doc.md'), 'utf8')).toBe('새 문서');
    expect(readFileSync(join(local, 'mine.md'), 'utf8')).toBe('사용자 작업 중');
    // 겹치는 사용자 변경: git이 거부 → 그대로
    writeFileSync(join(up, 'doc.md'), '원격 수정'); g(up, 'commit', '-qam', '수정'); g(up, 'push', '-q');
    writeFileSync(join(local, 'doc.md'), '로컬 수정');
    const r2 = await syncRepoFastForward(local);
    expect(r2.moved).toBe(false);
    expect(readFileSync(join(local, 'doc.md'), 'utf8')).toBe('로컬 수정');
    // 작업 브랜치에서는 하지 않음
    g(local, 'checkout', '-q', 'doc.md'); g(local, 'switch', '-q', '-c', 'feat/x');
    expect(await syncRepoFastForward(local)).toEqual({ moved: false, note: null });
  });
});

describe('자동 처리: 실행', () => {
  it('Bash 직원은 저장소 시험 명령·임시 폴더·캐시 쓰기를 받고, 쓰기 직원은 Skill을 받으며, 결과는 작업 브랜치에 커밋된다', async () => {
    const root = tmpProject();
    const be = repo(root, 'backend');
    mkdirSync(join(be, 'scripts')); writeFileSync(join(be, 'scripts', 'gradle.sh'), '#!/bin/sh\n'); mkdirSync(join(be, '.gradle'));
    writeFileSync(join(be, '.gitignore'), '.gradle/\n'); g(be, 'add', '-A'); g(be, 'commit', '-qm', '스크립트');
    const argvDir = join(root, '..', 'argv'); mkdirSync(argvDir);
    process.env.CREWGENAI_MOCK_ARGV_DIR = argvDir;
    process.env.AWS_SECRET_ACCESS_KEY = '시험용 비밀';
    const svc = mkService(root);
    const p = svc.createProject(plan(root, { writablePaths: ['backend/docs'] }));
    const w = svc.saveAgent(p.id, null, agentFields('01', '작성자', { tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'], allowedCommands: [] }));
    const inp = n('input', '입력');
    const work = n('agent', '작성', { agentId: w.id, writeScope: ['backend/docs'], outputs: [{ path: 'backend/docs/결과.md', format: 'markdown', required: true }] });
    const m = n('merge', '취합');
    const saved = svc.saveGraph(p.id, { nodes: [inp, work, m], edges: [e(inp, work), e(work, m)] }, '시험');
    const run = await svc.startRun(p.id, saved.version!.id);
    await waitRun(svc, run.id, ['review_wait', 'failed', 'succeeded']);
    const a = svc.store.runAttempts(run.id).find((x) => x.role === 'author')!;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    const rec = JSON.parse(readFileSync(join(argvDir, `${a.sessionId}.json`), 'utf8')) as { argv: string[]; env: Record<string, string> };
    const argv = rec.argv;
    expect(argv[argv.indexOf('--tools') + 1].split(',')).toContain('Skill');
    const st = JSON.parse(argv[argv.indexOf('--settings') + 1]);
    expect(rec.env.TMPDIR).toMatch(/\.tmp\/$/);
    expect(rec.env.JAVA_TOOL_OPTIONS).toContain('-Djava.io.tmpdir=');
    expect(st.permissions.allow).toContain('Bash(./backend/scripts/gradle.sh *)');
    expect(st.sandbox.network.allowLocalBinding).toBeUndefined(); // 로컬 소켓은 설정에서 켜야 연다
    expect(st.sandbox.filesystem.allowWrite).toEqual([expect.stringMatching(/\.tmp$/)]); // 실행별 임시 폴더만(실제 캐시 아님)
    expect(rec.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(g(be, 'branch', '--show-current')).toBe(workBranchName(run.id));
    expect(g(be, 'log', '-1', '--name-only', '--format=')).toContain('docs/결과.md');
    expect(g(be, 'log', '-1', '--format=%s', 'dev')).toBe('스크립트');
    // 로컬 소켓을 켜면 Gradle 시험용으로 연다
    svc.saveSettings({ testLocalSockets: true });
    const run3 = await svc.startRun(p.id, saved.version!.id);
    await waitRun(svc, run3.id, ['review_wait', 'failed', 'succeeded']);
    const a3 = svc.store.runAttempts(run3.id).find((x) => x.role === 'author')!;
    const r3 = JSON.parse(readFileSync(join(argvDir, `${a3.sessionId}.json`), 'utf8')) as { argv: string[] };
    expect(JSON.parse(r3.argv[r3.argv.indexOf('--settings') + 1]).sandbox.network.allowLocalBinding).toBe(true);
    // 자동 처리를 끄면 예전처럼: 시험 명령·Skill 없음
    svc.saveSettings({ autoAssist: false });
    const run2 = await svc.startRun(p.id, saved.version!.id);
    await waitRun(svc, run2.id, ['review_wait', 'failed', 'succeeded']);
    const a2 = svc.store.runAttempts(run2.id).find((x) => x.role === 'author')!.argvRedacted;
    expect(a2[a2.indexOf('--tools') + 1].split(',')).not.toContain('Skill');
    expect(a2[a2.indexOf('--settings') + 1]).not.toContain('gradle.sh');
    delete process.env.CREWGENAI_MOCK_ARGV_DIR;
    svc.close();
  });
});
