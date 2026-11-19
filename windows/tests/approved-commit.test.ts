// 사용자 승인 커밋: 보여 준 파일만, 보여 준 내용 그대로일 때만 커밋한다. 비밀값·저장소 밖·바뀐 내용 없음은 막는다. push하지 않는다.
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Mission, MissionCommitRequest } from '../src/shared/types';
import { commitApproved, previewApprovedCommit } from '../src/main/git';
import { cleanCommitRequests } from '../src/main/mission';
import { gitInit, mkService, plan, sleep, tmpProject } from './helpers';

function repo() {
  const dir = tmpProject(); const g = gitInit(dir);
  writeFileSync(join(dir, 'a.txt'), '하나\n둘\n'); g('add', 'a.txt'); g('commit', '-q', '-m', 'a 추가');
  writeFileSync(join(dir, 'a.txt'), '하나\n둘\n셋\n'); // 수정
  writeFileSync(join(dir, 'b.txt'), '새 파일\n'); // 새 파일
  writeFileSync(join(dir, 'c.txt'), '사용자 작업 중\n'); // 요청에 없는 다른 변경
  return { dir, g };
}

describe('승인 커밋', () => {
  it('보여 준 파일만 커밋하고 다른 변경은 그대로 둔다. dev·main이면 작업 브랜치로, 작성자는 사용자 git 설정', async () => {
    const { dir, g } = repo();
    const p = await previewApprovedCommit(dir, '', ['a.txt', 'b.txt'], '두 파일 커밋', 'feat/crewgenai-test1');
    expect(p.error).toBeNull();
    expect(p.blocked).toEqual([]);
    expect(p.branch).toBe('main'); expect(p.target).toBe('feat/crewgenai-test1');
    expect(p.files.map((f) => [f.path, f.status.trim(), f.added, f.removed])).toEqual([['a.txt', 'M', 1, 0], ['b.txt', '??', 1, 0]]);
    const r = await commitApproved(dir, '', ['a.txt', 'b.txt'], '두 파일 커밋', p.hash, { 'Crewgenai-Mission': 'm1', 'Crewgenai-Approved': 'user' }, 'feat/crewgenai-test1');
    expect(r.branch).toBe('feat/crewgenai-test1');
    expect(g('show', '--name-only', '--format=%an|%s', 'HEAD').trim().split('\n').filter(Boolean)).toEqual(['시험 사용자|두 파일 커밋', 'a.txt', 'b.txt']);
    expect(g('log', '-1', '--format=%b')).toContain('Crewgenai-Approved: user');
    expect(g('status', '--porcelain')).toContain('?? c.txt'); // 다른 변경은 커밋하지 않음
    expect(g('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feat/crewgenai-test1');
  });

  it('승인 화면을 연 뒤 파일이 바뀌면 커밋하지 않는다', async () => {
    const { dir, g } = repo();
    const p = await previewApprovedCommit(dir, '', ['a.txt'], '수정 커밋');
    writeFileSync(join(dir, 'a.txt'), '하나\n둘\n셋\n넷\n');
    await expect(commitApproved(dir, '', ['a.txt'], '수정 커밋', p.hash, {})).rejects.toThrow(/바뀌었습니다/);
    await expect(commitApproved(dir, '', ['a.txt'], '수정 커밋', 'made-up', {})).rejects.toThrow(/바뀌었습니다/);
    expect(g('log', '-1', '--format=%s').trim()).toBe('a 추가');
  });

  it('비밀값 파일·비밀값 내용·바뀐 내용 없음·없는 파일·저장소 밖·잘못된 경로는 막는다', async () => {
    const { dir, g } = repo();
    writeFileSync(join(dir, '.env'), 'X=1\n');
    writeFileSync(join(dir, '.env.example'), 'X=\n');
    writeFileSync(join(dir, 'conf.yml'), "db:\n  password: 'not-a-real-pass-123'\n");
    const outside = join(dirname(dir), 'outside.txt'); writeFileSync(outside, '밖\n');
    let linked = true; try { symlinkSync(outside, join(dir, 'link.txt')); } catch { linked = false; /* 링크를 만들 수 없는 환경 */ }
    const p = await previewApprovedCommit(dir, '', ['.env', '.env.example', 'conf.yml', 'README.md', 'nope.txt', 'link.txt', '../x.txt', '/etc/hosts', 'a\nb.txt'], '막힘 확인');
    const flags = Object.fromEntries(p.files.map((f) => [f.path, f.flags]));
    expect(flags['.env']).toContain('secret-name');
    expect(flags['.env.example']).toEqual([]);
    expect(flags['conf.yml']).toContain('secret-content');
    expect(flags['README.md']).toEqual(['unchanged']);
    expect(flags['nope.txt']).toEqual(['missing']);
    if (linked) expect(flags['link.txt']).toContain('symlink'); // 링크 파일은 모두 막는다
    expect(flags['../x.txt']).toEqual(['invalid']);
    expect(flags['/etc/hosts']).toEqual(['invalid']);
    expect(flags['a\nb.txt']).toEqual(['invalid']); // 제어 문자 경로
    await expect(commitApproved(dir, '', ['.env'], '비밀값', (await previewApprovedCommit(dir, '', ['.env'], '비밀값')).hash, {})).rejects.toThrow(/커밋할 수 없는 파일/);
    expect(g('log', '-1', '--format=%s').trim()).toBe('a 추가');
  });

  it('커밋은 보여 준 내용만: hook을 실행하지 않고, 폴더·링크·강제 추가한 무시 대상·검사할 수 없는 파일은 막는다', async () => {
    const { dir, g } = repo();
    // hook: 실행되면 표시 파일을 남기고 다른 파일을 스테이징하려 한다
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho ran > "${join(dir, 'hook-ran')}"\ngit add c.txt\n`, { mode: 0o755 });
    const p = await previewApprovedCommit(dir, '', ['a.txt'], 'hook 없이');
    const r = await commitApproved(dir, '', ['a.txt'], 'hook 없이', p.hash, {});
    expect(g('show', '--name-only', '--format=', r.sha).trim()).toBe('a.txt');
    expect(existsSync(join(dir, 'hook-ran'))).toBe(false);
    expect(g('status', '--porcelain', '--', 'a.txt').trim()).toBe(''); // 커밋한 파일은 깨끗한 상태
    // 추적 중인 파일 자리에 폴더(그 안에 다른 파일) → 막음
    writeFileSync(join(dir, 'd.txt'), 'x\n'); g('add', 'd.txt'); g('commit', '-q', '-m', 'd');
    rmSync(join(dir, 'd.txt')); mkdirSync(join(dir, 'd.txt')); writeFileSync(join(dir, 'd.txt', '.env'), 'K=1\n');
    // 강제로 스테이징한 무시 대상, 이진 새 파일
    writeFileSync(join(dir, '.gitignore'), 'ign.txt\n'); writeFileSync(join(dir, 'ign.txt'), 'x\n'); g('add', '-f', 'ign.txt');
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([1, 0, 2, 3]));
    const q = await previewApprovedCommit(dir, '', ['d.txt', 'ign.txt', 'bin.dat'], '막힘');
    const flags = Object.fromEntries(q.files.map((f) => [f.path, f.flags]));
    expect(flags['d.txt']).toContain('directory');
    expect(flags['ign.txt']).toContain('ignored');
    expect(flags['bin.dat']).toContain('unscanned');
  });

  it('git 필터(LFS 등) 대상은 필터 명령을 실행하지 않고 막는다. 추가한 줄이 ++로 시작해도 비밀값을 찾는다', async () => {
    const { dir, g } = repo();
    g('config', 'filter.probe.clean', `sh -c 'echo ran > "${join(dir, 'filter-ran')}"; cat'`);
    writeFileSync(join(dir, '.gitattributes'), 'f.txt filter=probe\n'); writeFileSync(join(dir, 'f.txt'), 'x\n');
    const p = await previewApprovedCommit(dir, '', ['f.txt'], '필터');
    expect(p.files[0].flags).toEqual(['filtered']);
    expect(existsSync(join(dir, 'filter-ran'))).toBe(false);
    writeFileSync(join(dir, 'a.txt'), '하나\n둘\n++api_key=abcdefgh12345\n');
    expect((await previewApprovedCommit(dir, '', ['a.txt'], '비밀')).files[0].flags).toContain('secret-content');
  });

  it('승인 직전 HEAD가 바뀌면(다른 커밋이 생김) 커밋하지 않는다', async () => {
    const { dir, g } = repo();
    const p = await previewApprovedCommit(dir, '', ['b.txt'], '새 파일');
    g('commit', '-q', '--allow-empty', '-m', '그 사이 다른 커밋');
    await expect(commitApproved(dir, '', ['b.txt'], '새 파일', p.hash, {})).rejects.toThrow(/바뀌었습니다/);
    expect(g('log', '-1', '--format=%s').trim()).toBe('그 사이 다른 커밋');
  });

  it('여러 저장소 폴더: 하위 저장소만, 연결 폴더 밖·저장소가 아닌 폴더는 거부', async () => {
    const root = tmpProject();
    const sub = join(root, 'svc'); mkdirSync(sub); const g = gitInit(sub);
    writeFileSync(join(sub, 'x.txt'), 'x\n');
    mkdirSync(join(root, 'plain'));
    expect((await previewApprovedCommit(root, 'plain', ['a'], 'm')).error).toMatch(/최상위/);
    expect((await previewApprovedCommit(root, '../', ['a'], 'm')).error).toMatch(/올바르지/);
    const p = await previewApprovedCommit(root, 'svc', ['x.txt'], '하위 저장소 커밋');
    expect(p.error).toBeNull();
    await commitApproved(root, 'svc', ['x.txt'], '하위 저장소 커밋', p.hash, {});
    expect(g('log', '-1', '--format=%s').trim()).toBe('하위 저장소 커밋');
  });

  it('요청 정리: 형식이 맞는 것만, 대기·승인된 같은 요청은 다시 받지 않고, 대기 요청은 5개까지', () => {
    const ex: MissionCommitRequest[] = [{ id: '1', cycle: 1, repo: 'svc', files: ['b', 'a'], message: 'm', why: '', task: '', status: 'pending', at: '' }];
    const out = cleanCommitRequests([
      { repo: './svc/', files: ['a', 'b'], message: 'm', why: '' }, // 같은 요청(순서·표기만 다름)
      { repo: 'svc', files: [], message: 'x', why: '' }, // 파일 없음
      { repo: 'svc', files: ['c'], message: '', why: '' }, // 메시지 없음
      ...Array.from({ length: 6 }, (_, i) => ({ repo: 'svc', files: [`f${i}`], message: `n${i}`, why: 'w' })),
    ], ex, 3);
    expect(out.map((r) => r.message)).toEqual(['n0', 'n1', 'n2', 'n3']);
    expect(out[0]).toMatchObject({ status: 'pending', cycle: 3, repo: 'svc', files: ['f0'] });
  });

  it('결정 팝업 목록에 나오고, 거절하면 기록을 남기고 목록에서 빠진다(커밋하지 않음)', async () => {
    const dir = tmpProject(); const g = gitInit(dir); const svc = mkService(dir);
    const p = svc.createProject(plan(dir, { writablePaths: ['docs'] }));
    svc.loadAgentTemplates(p.id);
    const m0 = await svc.startMission(p.id, '[[mock:gaps-options-only]] 기능표를 정리하라');
    for (let t = Date.now(); !['waiting_user', 'done', 'failed'].includes(svc.missions.get(m0.id).status) && Date.now() - t < 60000;) await sleep(50);
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    const req: MissionCommitRequest = { id: 'r1', cycle: 1, repo: '', files: ['a.txt'], message: '대기 커밋', why: '다음 작업에 필요', task: '', status: 'pending', at: '' };
    (svc.missions as unknown as { set(id: string, p: Partial<Mission>): Mission }).set(m0.id, { commitRequests: [req] });
    const item = (await svc.pendingDecisions()).find((d) => d.kind === 'commit');
    expect(item?.commit?.id).toBe('r1');
    const pv = await svc.commitPreview(m0.id, 'r1');
    expect(pv.files[0]).toMatchObject({ path: 'a.txt', flags: [] });
    expect(svc.commitDecline(m0.id, 'r1').status).toBe('declined');
    expect((await svc.pendingDecisions()).some((d) => d.kind === 'commit')).toBe(false);
    await expect(svc.commitApprove(m0.id, 'r1', pv.hash)).rejects.toThrow(/이미 처리/);
    expect(g('log', '-1', '--format=%s').trim()).toBe('초기');
    expect(svc.missions.detail(m0.id).events.some((e) => e.text.includes('커밋하지 않음(사용자 결정)'))).toBe(true);
    svc.close?.();
  }, 90000);
});

describe('오퍼레이터 판단 → 승인 커밋 요청', () => {
  it('판단의 commitRequests가 미션에 대기 요청으로 쌓이고 기록이 남으며, 다음 판단에는 목록으로 알려 같은 요청을 다시 내지 않는다. 승인 전에는 커밋하지 않는다', async () => {
    const dir = tmpProject(); const g = gitInit(dir); const svc = mkService(dir); svc.saveSettings({ devSync: false }); // 커밋 승인 요청은 매일 dev 반영을 끈 경우에만
    writeFileSync(join(dir, 'pending.txt'), '사용자 미커밋 변경\n');
    const p = svc.createProject(plan(dir, { writablePaths: ['docs'] }));
    svc.loadAgentTemplates(p.id);
    const m0 = await svc.startMission(p.id, '[[mock:commit-request]] 문서를 정리하라');
    for (let t = Date.now(); !['waiting_user', 'done', 'failed'].includes(svc.missions.get(m0.id).status) && Date.now() - t < 60000;) await sleep(50);
    const m = svc.missions.get(m0.id);
    expect(m.commitRequests?.map((r) => [r.files, r.message, r.status])).toEqual([[['pending.txt'], '대기 변경 커밋', 'pending']]);
    expect(svc.missions.detail(m0.id).events.some((e) => e.text.startsWith('커밋 승인 요청:'))).toBe(true);
    expect(g('log', '--all', '--format=%H', '--', 'pending.txt').trim()).toBe(''); // 승인 전에는 커밋하지 않음(직원 자동 커밋에도 섞이지 않음)
    const item = (await svc.pendingDecisions()).find((d) => d.kind === 'commit')!;
    const pv = await svc.commitPreview(m0.id, item.commit!.id);
    const done = await svc.commitApprove(m0.id, item.commit!.id, pv.hash);
    expect(done.status).toBe('approved');
    expect(g('show', '--name-only', '--format=%s', done.sha!).trim().split('\n').filter(Boolean)).toEqual(['대기 변경 커밋', 'pending.txt']);
    svc.close();
  }, 90000);
});
