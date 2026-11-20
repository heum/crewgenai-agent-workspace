// 문서 정리: 앱 기록 파일은 최근 실행만, 사이클별 문서는 HISTORY.md로 요약된 뒤 커밋된 원본만 지운다
import { mkdirSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cycleOf, findCycleDocs, staleRunFiles } from '../src/main/docclean';
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
  it('HISTORY.md가 써진 폴더만, git에 커밋되고 바뀌지 않은 원본만 지운다', async () => {
    const dir = tmpProject(); const g = gitInit(dir); const svc = mkService(dir);
    const p = svc.createProject(plan(dir, { writablePaths: ['docs', 'web'] }));
    svc.loadAgentTemplates(p.id);
    for (const c of [1, 2, 3, 4, 5]) put(dir, `docs/C${c}_FRONT.md`);
    put(dir, 'docs/c2-screens/a.png'); put(dir, 'web/docs/C1_WEB.md');
    g('add', '-A'); g('commit', '-q', '-m', '문서');
    put(dir, 'docs/C6_FRONT.md'); // 커밋 안 됨
    writeFileSync(join(dir, 'docs/C5_FRONT.md'), '고침'); // 커밋 뒤 바뀜
    const m0 = await svc.startMission(p.id, '문서를 정리하라'); await svc.missions.stop(m0.id);
    const mm = svc.missions as unknown as { set(id: string, patch: object): void };
    mm.set(m0.id, { cycle: 20, docTidyCycle: 0 });
    const section = (svc.missions as unknown as { docTidySection(m: object, plan: object): string[] }).docTidySection(svc.missions.get(m0.id), svc.store.getProject(p.id).plan).join('\n');
    expect(section).toContain('## 문서 정리');
    expect(section).toContain('docs/HISTORY.md');
    const t = svc.missions.get(m0.id).docTidy!;
    expect(t.groups.flatMap((x) => x.files)).toEqual(expect.arrayContaining(['docs/C1_FRONT.md', 'docs/c2-screens', 'docs/C6_FRONT.md', 'web/docs/C1_WEB.md']));
    writeFileSync(join(dir, 'docs/HISTORY.md'), '# 기록 요약\n- 사이클 1: 목록 화면\n'); // web/docs에는 쓰지 않음
    await svc.missions.tidyDocs(m0.id, svc.store.getProject(p.id).plan);
    expect(['C1_FRONT.md', 'C2_FRONT.md', 'C3_FRONT.md', 'C4_FRONT.md', 'c2-screens'].map((f) => existsSync(join(dir, 'docs', f)))).toEqual([false, false, false, false, false]);
    expect(existsSync(join(dir, 'docs/C5_FRONT.md'))).toBe(true); // 바뀐 것
    expect(existsSync(join(dir, 'docs/C6_FRONT.md'))).toBe(true); // 커밋 안 됨
    expect(existsSync(join(dir, 'web/docs/C1_WEB.md'))).toBe(true); // 요약 안 됨
    const m = svc.missions.get(m0.id);
    expect(m.docTidy).toBeNull(); expect(m.docTidyCycle).toBe(20);
    expect(svc.missions.detail(m0.id).events.some((e) => e.text.includes('문서 정리 끝: 원본 5개'))).toBe(true);
    svc.close();
  });
});
