// 여러 저장소(상위 폴더) 연결 시험 — 저장소별 커밋·스냅샷·되돌리기
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Mission } from '../src/shared/types';
import { commitWorkspace, workspaceDirtyPaths, workspaceRepos } from '../src/main/git';
import { isolatedDir, prepareIsolated, cleanupIsolated, snapshot } from '../src/main/engine/fsutil';
import { gitInit, mkService, plan, sleep, tmpProject } from './helpers';

const g = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString();

/** 상위 폴더(저장소 아님) 아래 저장소 repoA·repoB, 커밋 없는 저장소 emptyRepo, 일반 폴더 notes, 저장소를 가리키는 링크 linkA */
function parent() {
  const root = tmpProject();
  for (const r of ['repoA', 'repoB']) { mkdirSync(join(root, r)); gitInit(join(root, r)); }
  mkdirSync(join(root, 'emptyRepo')); g(join(root, 'emptyRepo'), 'init', '-q');
  mkdirSync(join(root, 'notes')); writeFileSync(join(root, 'notes', 'a.md'), 'x');
  symlinkSync(join(root, 'repoA'), join(root, 'linkA'));
  return root;
}

async function waitMission(svc: ReturnType<typeof mkService>, id: string, statuses: Mission['status'][], ms = 60000) {
  const t0 = Date.now();
  for (;;) {
    const m = svc.missions.get(id);
    if (statuses.includes(m.status)) return m;
    if (Date.now() - t0 > ms) throw new Error(`시간 초과: ${m.status}/${m.stage} ${m.question ?? ''}`);
    await sleep(50);
  }
}

describe('여러 저장소: 탐지와 커밋', () => {
  it('바로 아래의 git 저장소만 찾고 링크·일반 폴더는 제외한다. 저장소 안 폴더는 한 저장소로 본다', async () => {
    const root = parent();
    const w = await workspaceRepos(root);
    expect(w.mode).toBe('multi');
    expect(w.repos.map((r) => [r.rel, r.hasCommit])).toEqual([['emptyRepo', false], ['repoA', true], ['repoB', true]]);
    expect((await workspaceRepos(join(root, 'repoA'))).mode).toBe('single');
    expect((await workspaceRepos(join(root, 'notes'))).mode).toBe('none');
    expect(existsSync(join(root, '.git'))).toBe(false); // 상위 폴더에 git init 하지 않음
  });

  it('바뀐 파일을 저장소별로 나눠 각 저장소에 커밋하고, 사용자 변경·저장소 밖·커밋 없는 저장소는 커밋하지 않는다', async () => {
    const root = parent();
    writeFileSync(join(root, 'repoA', 'user.txt'), '사용자 작업 중');
    const dirty = await workspaceDirtyPaths(root);
    expect([...dirty]).toContain('repoA/user.txt');
    writeFileSync(join(root, 'repoA', 'a.md'), 'A'); writeFileSync(join(root, 'repoB', 'b.md'), 'B');
    writeFileSync(join(root, 'emptyRepo', 'e.md'), 'E'); writeFileSync(join(root, 'notes', 'n.md'), 'N');
    const r = await commitWorkspace(root, ['repoA/a.md', 'repoA/user.txt', 'repoB/b.md', 'emptyRepo/e.md', 'notes/n.md'],
      { name: 'CREWGENAI 10 작성', email: 'agent-10@crewgenai.local' }, '[CREWGENAI] 시험', { 'Crewgenai-Mission': 'm1' }, dirty);
    expect(r.error).toBeNull();
    expect(r.commits.map((c) => c.repo).sort()).toEqual(['repoA', 'repoB']);
    expect(r.sha).toMatch(/repoA@\w{8}/);
    expect(r.skipped).toContain('emptyRepo');
    expect(r.skipped).toContain('notes/n.md');
    expect(g(join(root, 'repoA'), 'log', '-1', '--format=%an', '--name-only')).toContain('a.md');
    expect(g(join(root, 'repoA'), 'status', '--porcelain')).toContain('?? user.txt'); // 사용자 파일은 그대로
    expect(g(join(root, 'repoB'), 'log', '-1', '--format=%an')).toContain('CREWGENAI 10 작성');
  });

  it('변경 비교와 격리 복사는 .claude/worktrees 사본을 건너뛰고, 범위 저장소만 복사할 수 있다', () => {
    const root = parent();
    mkdirSync(join(root, 'repoA', '.claude', 'worktrees', 'w1'), { recursive: true });
    writeFileSync(join(root, 'repoA', '.claude', 'worktrees', 'w1', 'copy.md'), 'x');
    writeFileSync(join(root, 'repoA', '.claude', 'settings.json'), '{}');
    const snap = snapshot(root);
    expect([...snap.keys()].some((k) => k.includes('worktrees'))).toBe(false);
    expect(snap.has('repoA/.claude/settings.json')).toBe(true);
    mkdirSync(join(root, 'repoA', 'node_modules', 'tool'), { recursive: true });
    const dir = isolatedDir(`multi:${root}`);
    const st = prepareIsolated(root, dir, (f) => f.startsWith('repoA/'), false, new Set(['repoA']));
    const files = st.before.map(([k]) => k);
    expect(files.some((f) => f.startsWith('repoA/'))).toBe(true);
    expect(files.some((f) => f.startsWith('repoB/') || f.startsWith('notes/'))).toBe(false);
    expect(existsSync(join(dir, 'repoA', 'node_modules', 'tool'))).toBe(true); // 저장소의 의존성 폴더는 링크로 쓸 수 있다
    cleanupIsolated(dir);
  });
});

describe('여러 저장소: 미션', () => {
  it('상위 폴더 연결: 준비 항목 통과, 직원 커밋은 해당 저장소에만, 스냅샷은 저장소별 기준점, 되돌리기는 그 저장소만', async () => {
    const root = parent();
    const svc = mkService(root);
    const p = svc.createProject(plan(root, { writablePaths: ['repoA/docs'] }));
    svc.loadAgentTemplates(p.id);
    const ready = await svc.missionReadiness(p.id, true);
    const gitItem = ready.items.find((i) => i.key === 'git')!;
    expect(gitItem.ok).toBe(true);
    expect(gitItem.detail).toContain('하위 저장소 2개');
    expect(gitItem.detail).toContain('emptyRepo');
    const headB = g(join(root, 'repoB'), 'rev-parse', 'HEAD');
    const m0 = await svc.startMission(p.id, '[[mock:dir:repoA]] 문서를 정리하라');
    const m = await waitMission(svc, m0.id, ['done', 'waiting_user', 'failed']);
    expect(m.status).not.toBe('failed');
    expect(existsSync(join(root, 'repoA/docs/mission/cycle-1.md'))).toBe(true);
    expect(g(join(root, 'repoA'), 'log', '--format=%an')).toContain('CREWGENAI 00 총괄');
    expect(g(join(root, 'repoB'), 'rev-parse', 'HEAD')).toBe(headB); // 다른 저장소는 그대로
    expect(g(join(root, 'repoA'), 'tag', '--list')).toBe(''); // 여러 저장소 모드는 태그를 만들지 않음
    expect(existsSync(join(root, '.git'))).toBe(false);
    const snaps = await svc.missions.snapshots(m0.id);
    expect(snaps[0].repos).toEqual(['repoA', 'repoB']);
    const start = snaps.find((s) => s.tag.endsWith('/start'))!;
    expect(start.commitsAfter.length).toBeGreaterThan(0);
    expect(start.commitsAfter.every((c) => c.repo === 'repoA')).toBe(true);
    const r = await svc.missions.rollback(m0.id, start.tag);
    expect(r.ok).toBe(true);
    expect(r.reverted.every((s) => s.startsWith('repoA@'))).toBe(true);
    expect(existsSync(join(root, 'repoA/docs/mission/cycle-1.md'))).toBe(false);
    expect(g(join(root, 'repoB'), 'rev-parse', 'HEAD')).toBe(headB);
    // 기록된 저장소가 사라지면 일부만 되돌리지 않고 거부한다
    renameSync(join(root, 'repoB'), join(root, 'repoB-moved'));
    await expect(svc.missions.rollback(m0.id, snaps.find((s) => s.tag.endsWith('/cycle-1'))!.tag)).rejects.toThrow('repoB');
    svc.close();
  });

  it('git 저장소가 하나도 없는 폴더는 준비 항목에서 막고, 상위 폴더에 git init 하지 말라고 안내한다', async () => {
    const root = tmpProject();
    const svc = mkService(root);
    const p = svc.createProject(plan(root));
    const item = (await svc.missionReadiness(p.id, true)).items.find((i) => i.key === 'git')!;
    expect(item.ok).toBe(false);
    expect(item.detail).toContain('git init을 하지 말고');
    svc.close();
  });
});
