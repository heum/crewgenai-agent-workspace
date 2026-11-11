// 프로젝트 완성 문서 세트 — 표준 세트·상태·경로 검증·검토 표시
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Mission } from '../src/shared/types';
import { gitInit, mkService, plan, sleep, tmpProject } from './helpers';

const PROMPTS = resolve(__dirname, '../resources/docs/prompts');
function setup() {
  const dir = tmpProject(); const svc = mkService(dir, [], { promptsDir: PROMPTS });
  const p = svc.createProject(plan(dir));
  return { dir, svc, p };
}
const put = (dir: string, rel: string, text: string) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); };

describe('프로젝트 완성 문서', () => {
  it('표준 8종을 순서대로 주고, 파일 상태에 따라 없음 → 작성됨 → 검토 완료 → 검토 후 바뀜으로 바뀐다', () => {
    const { dir, svc, p } = setup();
    const docs = svc.projectDocs(p.id);
    expect(docs.length).toBe(8);
    expect(docs.map((d) => d.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(docs.every((d) => d.status === 'missing')).toBe(true);
    const req = docs.find((d) => d.templateId === '03-customer-requirements')!;
    expect(req.missingBefore.length).toBe(2); // 앞 순서 문서 2개가 아직 없음
    expect(req.resolvedInstruction).toContain(req.path);
    put(dir, req.path, '# 요구사항');
    expect(svc.projectDocs(p.id).find((d) => d.id === req.id)!.status).toBe('draft');
    expect(svc.reviewProjectDoc(p.id, req.id, true).find((d) => d.id === req.id)!.status).toBe('reviewed');
    put(dir, req.path, '# 요구사항 v2');
    expect(svc.projectDocs(p.id).find((d) => d.id === req.id)!.status).toBe('changed');
    svc.close();
  });

  it('빼기·추가·경로 변경을 저장하고, 경로가 바뀌면 지시문 경로도 바뀌며 검토 표시는 풀린다', () => {
    const { dir, svc, p } = setup();
    const base = svc.projectDocs(p.id).map(({ id, title, path, templateId, instruction, excluded, reviewedSha, reviewedAt }) => ({ id, title, path, templateId, instruction, excluded, reviewedSha, reviewedAt }));
    const rnd = base.find((d) => d.templateId === '02-rnd-business')!;
    const req = base.find((d) => d.templateId === '03-customer-requirements')!;
    put(dir, req.path, '# 요구사항');
    svc.reviewProjectDoc(p.id, req.id, true);
    const reviewed = svc.projectDocs(p.id).find((d) => d.id === req.id)!;
    const next = base.map((d) => (d.id === rnd.id ? { ...d, excluded: true } : d.id === req.id ? { ...d, path: 'docs/requirements.md', reviewedSha: reviewed.reviewedSha } : d));
    const saved = svc.saveProjectDocs(p.id, [...next, { id: '', title: '운영 정책서', path: 'docs/ops.md', templateId: null, instruction: '', excluded: false, reviewedSha: null, reviewedAt: null }]);
    expect(saved.length).toBe(9);
    expect(saved.find((d) => d.id === rnd.id)!.status).toBe('excluded');
    const r2 = saved.find((d) => d.id === req.id)!;
    expect(r2.status).toBe('missing'); // 새 경로에는 파일이 없음
    expect(r2.reviewedSha).toBeNull();
    expect(r2.resolvedInstruction).toContain('docs/requirements.md');
    expect(r2.missingBefore).not.toContain(saved.find((d) => d.id === rnd.id)!.title); // 뺀 문서는 앞 문서로 보지 않음
    expect(saved.at(-1)!.resolvedInstruction).toContain('docs/ops.md');
    expect(svc.resetProjectDocs(p.id).length).toBe(8);
    svc.close();
  });

  it('프로젝트 폴더 밖 경로·중복 경로는 저장하지 않는다', () => {
    const { svc, p } = setup();
    const one = (path: string) => [{ id: 'x', title: '문서', path, templateId: null, instruction: '', excluded: false, reviewedSha: null, reviewedAt: null }];
    expect(() => svc.saveProjectDocs(p.id, one('../밖.md'))).toThrow(/상대 경로/);
    expect(() => svc.saveProjectDocs(p.id, one('/etc/hosts'))).toThrow(/상대 경로/);
    expect(() => svc.saveProjectDocs(p.id, [...one('docs/a.md'), { ...one('docs/a.md')[0], id: 'y' }])).toThrow(/같은 경로/);
    expect(() => svc.reviewProjectDoc(p.id, svc.projectDocs(p.id)[0].id, true)).toThrow(/파일이 없어/);
    svc.close();
  });

  it('파일 올리기는 프로젝트 폴더의 문서 경로로 복사하고, 확장자가 다르면 경로를 맞춘다', () => {
    const { dir, svc, p } = setup();
    const src = join(dir, '..', '내 요구사항.pdf'); writeFileSync(src, '%PDF-1.4 시험');
    const req = svc.projectDocs(p.id).find((d) => d.templateId === '03-customer-requirements')!;
    const after = svc.uploadProjectDoc(p.id, req.id, src).find((d) => d.id === req.id)!;
    expect(after.path).toBe(req.path.replace(/\.md$/, '.pdf'));
    expect(after.status).toBe('draft');
    expect(readFileSync(join(dir, after.path), 'utf8')).toContain('시험');
    const bad = join(dir, '..', '문서.docx'); writeFileSync(bad, 'x');
    expect(() => svc.uploadProjectDoc(p.id, req.id, bad)).toThrow(/Markdown/);
    svc.close();
  });
});

describe('근거 문서 확인(운영)', () => {
  it('근거가 빈약하면 오퍼레이터가 채울 부분을 알려 주고 멈추며, 보완 후 다시 확인하면 이어서 진행한다', async () => {
    const dir = tmpProject(); gitInit(dir); const svc = mkService(dir, [], { promptsDir: PROMPTS });
    const p = svc.createProject(plan(dir, { writablePaths: ['docs'] })); svc.loadAgentTemplates(p.id);
    const wait = async (id: string, sts: Mission['status'][]) => { for (let i = 0; i < 1200; i++) { const m = svc.missions.get(id); if (sts.includes(m.status)) return m; await sleep(50); } throw new Error('시간 초과'); };
    const m0 = await svc.startMission(p.id, `[[mock:gaps-once:${randomUUID().slice(0, 8)}]] 요구사항을 정리하라`);
    const w = await wait(m0.id, ['waiting_user', 'done', 'failed']);
    expect(w.status).toBe('waiting_user');
    expect(w.gaps?.length).toBe(2);
    expect(w.gaps![0].doc).toMatch(/crewgenai-output\/docs\/0\d-.+\.md/); // 계획 프롬프트에 등록 문서·경로가 들어감
    expect(w.question).toContain('근거 문서를 보완해 주세요');
    expect(svc.missions.detail(w.id).cycles.length).toBe(0); // 멈춘 동안 실행하지 않음
    svc.missions.answer(w.id, '', 'continue'); // 문서를 올린 뒤 비워 두고 다시 확인
    const m = await wait(w.id, ['done', 'failed']);
    expect(m.status).toBe('done');
    expect(m.gaps ?? null).toBeNull();
    svc.close();
  });
});
