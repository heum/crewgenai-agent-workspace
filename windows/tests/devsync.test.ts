// 매일 dev 반영 시험 — 임시 원격(bare) 저장소로 커밋·병합·push와 비밀값 제외를 확인한다
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { syncRepoToDev } from '../src/main/git';

const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }).trim();
function setup(branch = 'dev') {
  const root = mkdtempSync(join(tmpdir(), 'devsync-'));
  const remote = join(root, 'remote.git'); execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const repo = join(root, 'repo'); execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  g(repo, 'config', 'user.name', 't'); g(repo, 'config', 'user.email', 't@x'); g(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# r\n'); g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'init');
  g(repo, 'remote', 'add', 'origin', remote); g(repo, 'push', '-q', 'origin', 'main');
  g(repo, 'checkout', '-qb', 'dev'); g(repo, 'push', '-q', '-u', 'origin', 'dev');
  if (branch !== 'dev') g(repo, 'checkout', '-qb', branch);
  return { root, remote, repo };
}
const remoteFiles = (remote: string, ref = 'dev') => execFileSync('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', ref], { encoding: 'utf8' }).trim().split('\n');

describe('매일 dev 반영', () => {
  it('dev에서: 비밀값 파일·내용은 빼고 커밋해 원격 dev로 push하고, .gitignore에 비밀값 제외 규칙을 더한다', async () => {
    const { remote, repo } = setup();
    writeFileSync(join(repo, 'app.ts'), 'export const x = 1;\n');
    writeFileSync(join(repo, '.env'), 'DB_PASSWORD=supersecret123\n');
    writeFileSync(join(repo, 'config.ts'), 'export const api_key = "abcd1234efgh5678";\n');
    writeFileSync(join(repo, '.env.example'), 'DB_PASSWORD=\n');
    const r = await syncRepoToDev(repo, 'repo', '2026-11-19');
    expect(r.status).toBe('pushed');
    const files = remoteFiles(remote);
    expect(files).toEqual(expect.arrayContaining(['app.ts', '.gitignore', '.env.example', 'README.md']));
    expect(files).not.toContain('.env');
    expect(files).not.toContain('config.ts');
    expect(r.excluded.some((x) => x.startsWith('config.ts'))).toBe(true);
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toContain('.env.*');
    expect(existsSync(join(repo, 'config.ts'))).toBe(true); // 사용자 파일은 그대로 둔다
    // 다시 돌리면 바뀐 것 없음
    expect((await syncRepoToDev(repo, 'repo', '2026-11-19')).status).toBe('nothing');
  });

  it('앱 작업 브랜치에서: 커밋하고 dev로 fast-forward push, 로컬 dev도 같이 옮기고 지금 브랜치는 그대로', async () => {
    const { remote, repo } = setup('feat/crewgenai-abc');
    writeFileSync(join(repo, 'a.ts'), 'export {};\n');
    const r = await syncRepoToDev(repo, 'repo', '2026-11-19');
    expect(r.status).toBe('pushed');
    expect(remoteFiles(remote)).toContain('a.ts');
    expect(g(repo, 'branch', '--show-current')).toBe('feat/crewgenai-abc');
    expect(g(repo, 'rev-parse', 'dev')).toBe(g(repo, 'rev-parse', 'HEAD'));
  });

  it('원격 dev가 앞서 갈라졌으면 작업 트리를 건드리지 않고 임시 폴더에서 병합해 push한다', async () => {
    const { root, remote, repo } = setup('feat/crewgenai-abc');
    // 다른 곳에서 dev에 커밋
    const other = join(root, 'other'); execFileSync('git', ['clone', '-q', '-b', 'dev', remote, other]);
    g(other, 'config', 'user.name', 'o'); g(other, 'config', 'user.email', 'o@x');
    writeFileSync(join(other, 'b.ts'), 'export {};\n'); g(other, 'add', '-A'); g(other, 'commit', '-qm', 'b'); g(other, 'push', '-q', 'origin', 'dev');
    writeFileSync(join(repo, 'a.ts'), 'export {};\n');
    const before = g(repo, 'status', '--porcelain');
    const r = await syncRepoToDev(repo, 'repo', '2026-11-19');
    expect(r.status).toBe('pushed');
    expect(remoteFiles(remote)).toEqual(expect.arrayContaining(['a.ts', 'b.ts']));
    expect(existsSync(join(repo, 'b.ts'))).toBe(false); // 작업 트리는 그대로(병합은 임시 폴더에서)
    expect(before).toContain('a.ts');
    expect(g(repo, 'worktree', 'list').split('\n').length).toBe(1);
  });

  it('dev가 있는데 사용자 브랜치에 있으면 건너뛰고, dev가 없으면 만들어 커밋·push한다', async () => {
    const a = setup('codex/work');
    writeFileSync(join(a.repo, 'x.ts'), '1\n');
    const r1 = await syncRepoToDev(a.repo, 'a', '2026-11-19');
    expect(r1.status).toBe('skipped'); expect(r1.note).toContain('codex/work');
    expect(g(a.repo, 'status', '--porcelain')).toContain('x.ts'); // 커밋하지 않음
    // dev가 없으면 지금 브랜치에서 dev를 만들어 커밋·push한다
    const b = setup(); g(b.repo, 'checkout', '-qb', 'codex/setup'); g(b.repo, 'branch', '-D', 'dev'); g(b.repo, 'push', '-q', 'origin', '--delete', 'dev'); g(b.repo, 'fetch', '-q', '--prune');
    writeFileSync(join(b.repo, 'y.ts'), '2\n');
    const rb = await syncRepoToDev(b.repo, 'b', '2026-11-19');
    expect(rb.status).toBe('pushed'); expect(rb.note).toContain('dev 브랜치를 새로 만듦(codex/setup에서)');
    expect(g(b.repo, 'branch', '--show-current')).toBe('dev');
    expect(remoteFiles(b.remote)).toContain('y.ts');
  });
});

describe('main 병합', () => {
  it('dev를 main에 fast-forward 또는 임시 폴더 병합으로 push하고, 이미 들어 있으면 건너뛴다', async () => {
    const { mergeDevToMain } = await import('../src/main/git');
    const { remote, repo } = setup();
    writeFileSync(join(repo, 'f.ts'), '1\n'); g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'f'); g(repo, 'push', '-q', 'origin', 'dev');
    const r = await mergeDevToMain(repo, 'repo', '2026-11-19');
    expect(r.status).toBe('pushed');
    expect(remoteFiles(remote, 'main')).toContain('f.ts');
    expect((await mergeDevToMain(repo, 'repo', '2026-11-19')).status).toBe('nothing');
    expect(g(repo, 'branch', '--show-current')).toBe('dev'); // 작업 트리 그대로
  });

  it('큰 단원이 끝났다고 판단하면 확인함에 main 병합을 묻고, 고른 대로만 처리한다(아직 아님 → 병합 안 함)', async () => {
    const { gitInit, mkService, plan, sleep, tmpProject } = await import('./helpers');
    const dir = tmpProject(); gitInit(dir); const svc = mkService(dir);
    const p = svc.createProject(plan(dir, { writablePaths: ['docs'] })); svc.loadAgentTemplates(p.id);
    const m0 = await svc.startMission(p.id, '[[mock:milestone]] 문서를 정리하라');
    const t0 = Date.now(); let it;
    while (!(it = svc.pendingDecisions().find((d) => d.missionId === m0.id && d.kind === 'merge')) && Date.now() - t0 < 60000) await sleep(100);
    expect(it).toBeTruthy();
    expect(it!.choices.map((c) => c.label)).toEqual(['main에 병합', '아직 아님']);
    expect(svc.applyDecisions([{ key: it!.key, choice: '마음대로' }]).applied).toBe(0); // 보여 준 선택지만
    const r = svc.applyDecisions([{ key: it!.key, choice: '아직 아님' }]);
    expect(r.applied).toBe(1);
    expect(svc.missions.get(m0.id).mergeRequest?.status).toBe('declined');
    expect(svc.pendingDecisions().some((d) => d.kind === 'merge' && d.missionId === m0.id)).toBe(false);
    await svc.missions.stop(m0.id); svc.close();
  });
});
