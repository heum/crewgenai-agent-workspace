// 문서 정리: 앱 기록 파일은 최근 실행만, 사이클별 문서는 HISTORY.md로 요약된 뒤 커밋된 원본만 지운다
import { mkdirSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cycleOf, findCycleDocs, findStaleBuilds, staleRunFiles } from '../src/main/docclean';
import { gitInit, mkService, plan, tmpProject } from './helpers';

const OLD = (Date.now() - 3 * 24 * 3600 * 1000) / 1000;
function put(dir: string, rel: string, text = '# 기록\n') { const a = join(dir, rel); mkdirSync(join(a, '..'), { recursive: true }); writeFileSync(a, text); utimesSync(a, OLD, OLD); }

describe('사이클별 문서 찾기', () => {
  it('이름의 사이클 번호를 읽는다', () => {
    expect(['C100_FRONT.md', 'DEMO_C10_FRONT.md', 'C106A_FRONT.md', 'c98-screens', 'cycle-3.md', 'README.md', 'HISTORY.md', 'CHANGELOG.md'].map(cycleOf)).toEqual([100, 10, 106, 98, 3, null, null, null]);
  });
  it('허용 경로 안 docs 폴더의 오래된 사이클 문서만, 최근 3사이클과 하루 안에 바뀐 것은 빼고 찾는다', () => {
    const dir = tmpProject();
    put(dir, 'app/docs/C10_FRONT.md'); put(dir, 'app/docs/C19_FRONT.md'); put(dir, 'app/docs/STATUS.md'); put(dir, 'app/docs/c11-screens/a.png');
    put(dir, 'app/src/C10_notes.md'); put(dir, 'other/docs/C10_FRONT.md');
    writeFileSync(join(dir, 'app/docs/C12_FRONT.md'), 'new'); // 방금 바뀜
    const found = findCycleDocs(dir, ['app'], 'out', 20).map((d) => [d.rel, d.cycle, d.dir]);
    expect(found).toEqual([['app/docs/C10_FRONT.md', 10, false], ['app/docs/c11-screens', 11, true]]);
  });
  it('앱 기록 파일은 이 프로젝트 실행 중 남길 실행이 아닌 것만 고른다', () => {
    const dir = tmpProject();
    for (const r of ['aaaaaaaa', 'bbbbbbbb', 'cccccccc']) { put(dir, `out/RESULT-${r}.md`); put(dir, `out/reviews/codex-리뷰-A-${r}-v1.md`); }
    put(dir, 'out/RESULT-dddddddd.md'); // 다른 프로젝트 실행
    const stale = staleRunFiles(dir, 'out', new Set(['aaaaaaaa', 'bbbbbbbb', 'cccccccc']), new Set(['cccccccc'])).sort();
    expect(stale).toEqual(['out/RESULT-aaaaaaaa.md', 'out/RESULT-bbbbbbbb.md', 'out/reviews/codex-리뷰-A-aaaaaaaa-v1.md', 'out/reviews/codex-리뷰-A-bbbbbbbb-v1.md']);
  });
});

describe('문서 정리 적용', () => {
  it('md 문서는 지우지 않고 요약 작업도 넣지 않는다(사용자 결정: 빌드 폴더만 정리)', async () => {
    const dir = tmpProject(); const g = gitInit(dir); const svc = mkService(dir);
    const p = svc.createProject(plan(dir, { writablePaths: ['docs', 'web'] }));
    svc.loadAgentTemplates(p.id);
    for (const c of [1, 2, 3, 4, 5]) put(dir, `docs/C${c}_FRONT.md`);
    put(dir, 'docs/c2-screens/a.png'); put(dir, 'crewgenai-output/RESULT-old-0123abcd.md');
    g('add', '-A'); g('commit', '-q', '-m', '문서');
    const m0 = await svc.startMission(p.id, '문서를 정리하라'); await svc.missions.stop(m0.id);
    const mm = svc.missions as unknown as { set(id: string, patch: object): void };
    // 예전 버전이 걸어 둔 요약·삭제 예약이 있어도 지우지 않고 예약만 버린다
    mm.set(m0.id, { cycle: 20, docTidyCycle: 0, docTidy: { cycle: 20, at: new Date(0).toISOString(), groups: [{ folder: 'docs', files: ['docs/C1_FRONT.md', 'docs/c2-screens'] }], left: 0 } });
    writeFileSync(join(dir, 'docs/HISTORY.md'), '원본: C1_FRONT.md, c2-screens\n');
    expect((svc.missions as unknown as Record<string, unknown>).docTidySection).toBeUndefined();
    await svc.missions.tidyDocs(m0.id, svc.store.getProject(p.id).plan);
    expect(['C1_FRONT.md', 'C5_FRONT.md', 'c2-screens/a.png'].map((f) => existsSync(join(dir, 'docs', f)))).toEqual([true, true, true]);
    expect(existsSync(join(dir, 'crewgenai-output/RESULT-old-0123abcd.md'))).toBe(true);
    expect(svc.missions.get(m0.id).docTidy).toBeNull();
    svc.close();
  });
});

describe('지난 사이클 시연 빌드 정리', () => {
  it('종류별 최신, 시연 목록이 가리키는 것, 하루 안에 바뀐 것은 후보에서 뺀다', () => {
    const dir = tmpProject();
    for (const c of [31, 48, 51, 98]) put(dir, `web/.next-demo-c${c}/BUILD_ID`);
    put(dir, 'web/.demo-data-c31/db.txt'); put(dir, 'api/.next-demo-c10/x');
    writeFileSync(join(dir, 'web/.next-demo-c51/BUILD_ID'), 'new'); // 방금 바뀜
    const cur = '"DEMO_DIST_DIR": ".next-demo-c98", "x": "../web/.next-demo-c48/a"';
    const c = findStaleBuilds(dir, ['.'], cur, Date.now(), new Set(['web/.next-demo-c31', 'web/.next-demo-c51', 'web/.next-demo-c48', 'other/.next-demo-c10'])).map((b) => b.rel);
    expect(c).toEqual(['web/.next-demo-c31']);
    // 시연 목록에 등록된 적 없는 같은 모양의 폴더(사용자 백업 등)는 건드리지 않는다
    expect(findStaleBuilds(dir, ['.'], cur)).toEqual([]);
    // 다른 저장소의 같은 이름 폴더도 등록된 것으로 보지 않는다
    expect(findStaleBuilds(dir, ['.'], cur, Date.now(), new Set(['other/.next-demo-c31']))).toEqual([]);
  });
  it.skipIf(process.platform === 'win32')('git이 무시하고 추적하지 않는 빌드만, 실제 정리 단계에서 지운다(Windows는 열린 파일을 확인할 수 없어 지우지 않음)', async () => {
    const dir = tmpProject(); const g = gitInit(dir); const svc = mkService(dir);
    writeFileSync(join(dir, '.gitignore'), '.next-demo-*\n');
    const repoName = dir.split('/').filter(Boolean).pop();
    put(dir, 'out/demo/demo-services.old.json', JSON.stringify({ services: [{ id: 'w', repo: repoName, env: { DEMO_DIST_DIR: '.next-demo-c1' } }, { id: 'w2', repo: repoName, env: { DEMO_DIST_DIR: '.next-demo-c2' } }, { id: 'w3', repo: repoName, env: { DEMO_DIST_DIR: '.next-demo-c3' } }] }));
    for (const c of [1, 2, 3]) put(dir, `.next-demo-c${c}/BUILD_ID`);
    for (const c of [1, 2]) put(dir, `.cache-c${c}/kept.txt`);
    g('add', '-A'); g('commit', '-q', '-m', '빌드');
    const p = svc.createProject(plan(dir, { writablePaths: ['.'] }));
    svc.loadAgentTemplates(p.id);
    const m0 = await svc.startMission(p.id, '문서를 정리하라'); await svc.missions.stop(m0.id);
    await svc.missions.tidyDocs(m0.id, svc.store.getProject(p.id).plan);
    expect(['.next-demo-c1', '.next-demo-c2', '.next-demo-c3', '.cache-c1', '.cache-c2'].map((f) => existsSync(join(dir, f)))).toEqual([false, false, true, true, true]);
    expect(svc.missions.detail(m0.id).events.some((e) => e.text.includes('시연 빌드 2개'))).toBe(true);
    svc.close();
  });
});

describe('삭제 안전 검사', () => {
  it('커밋된 폴더라도 .gitignore로 제외된 파일이 들어 있으면 되살릴 수 없으니 지우지 않는다', async () => {
    const { trackedClean } = await import('../src/main/git');
    const dir = tmpProject(); const g = gitInit(dir);
    writeFileSync(join(dir, '.gitignore'), '*.local\n'); put(dir, 'docs/c1-screens/a.png');
    g('add', '-A'); g('commit', '-q', '-m', '사진');
    expect(await trackedClean(join(dir, 'docs/c1-screens'))).toBe(true);
    put(dir, 'docs/c1-screens/memo.local');
    expect(await trackedClean(join(dir, 'docs/c1-screens'))).toBe(false);
  });
  it.skipIf(process.platform === 'win32')('연결 폴더 밖을 가리키는 링크 경로는 찾지 않는다', async () => {
    const { symlinkSync } = await import('node:fs');
    const out = tmpProject(); put(out, 'docs/C1_FRONT.md'); put(out, '.next-demo-c1/x'); put(out, '.next-demo-c2/x');
    const dir = tmpProject(); symlinkSync(out, join(dir, 'web'));
    expect(findCycleDocs(dir, ['web'], 'out', 20)).toEqual([]);
    expect(findStaleBuilds(dir, ['web'], '', Date.now(), new Set(['web/.next-demo-c1', 'web/.next-demo-c2']))).toEqual([]);
  });
});

describe('시연 빌드 등록 확인', () => {
  it('서비스의 repo와 폴더 이름, 또는 저장소/폴더 경로로만 등록을 인정한다', async () => {
    const { registeredBuilds } = await import('../src/main/docclean');
    const dir = tmpProject();
    put(dir, 'demo/demo-services.json', JSON.stringify({ services: [{ repo: 'web', env: { DEMO_DIST_DIR: '.next-demo-c98', X: 'c31' } }, { repo: 'api', needs: ['../api/.demo-data-c31/token'] }] }));
    put(dir, 'demo/old.json', 'not json ../web/.next-demo-c51/BUILD_ID');
    expect([...registeredBuilds(join(dir, 'demo/demo-services.json'))].sort()).toEqual(['api/.demo-data-c31', 'web/.next-demo-c51', 'web/.next-demo-c98']);
  });
  it('사이클 번호가 붙은 일반 자료 폴더는 문서 정리 대상이 아니다', () => {
    const dir = tmpProject();
    put(dir, 'app/docs/c1-customers/data.csv'); put(dir, 'app/docs/c2-review/a.png'); put(dir, 'app/docs/c3-shots/x.bin');
    expect(findCycleDocs(dir, ['app'], 'out', 20).map((d) => d.rel)).toEqual(['app/docs/c2-review', 'app/docs/c3-shots']);
  });
});
