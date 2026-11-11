// 프로젝트 완성 문서 세트 — '이 프로젝트를 완성하려면 필요한 문서' 목록과 각 문서의 상태.
// 표준 세트(권장 문서 템플릿 8종, 순서 있음)를 기본으로 두고 프로젝트마다 빼거나 추가할 수 있다.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { DocItem, ProjectDoc, PromptTemplate } from '../shared/types';
import { instructionPart } from '../shared/prompt';
import { fileSha } from './engine/fsutil';

/** resources/docs/prompts/*.md (첫 줄 제목, '> 요약:' 줄, '> 산출물:' 줄) */
export function loadTemplates(dir: string): PromptTemplate[] {
  try {
    return readdirSync(dir).filter((f) => /^[\w.-]+\.md$/.test(f) && f !== 'README.md').sort().map((f) => {
      const body = readFileSync(join(dir, f), 'utf8');
      const title = (body.match(/^#\s+(.+)$/m)?.[1] ?? f).trim();
      const summary = (body.match(/^>\s*요약:\s*(.+)$/m)?.[1] ?? '').trim();
      const output = (body.match(/^>\s*산출물:\s*(.+)$/m)?.[1] ?? '').trim();
      return { id: f.replace(/\.md$/, ''), title, summary, output, body };
    });
  } catch { return []; }
}

export function defaultDocSet(templates: PromptTemplate[]): DocItem[] {
  return templates.map((t) => ({ id: t.id, title: t.title, path: t.output, templateId: t.id, instruction: '', excluded: false, reviewedSha: null, reviewedAt: null }));
}

/** 프로젝트 폴더 기준 상대 경로만 허용(절대 경로·상위 폴더 이동 금지) */
export function safeRel(p: string): string | null {
  const s = p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!s || isAbsolute(s) || s.split('/').some((x) => x === '..' || x === '') || s.length > 300) return null;
  return s;
}

function inside(folder: string, abs: string): boolean {
  try { const r = relative(realpathSync(folder), realpathSync(abs)); return !!r && !r.startsWith('..') && !isAbsolute(r); } catch { return false; }
}

/** 문서 지시문: 직접 쓴 지시문이 있으면 그것, 아니면 템플릿 지시문(산출물 경로를 이 프로젝트 경로로 바꿈) */
export function docInstruction(d: DocItem, t: PromptTemplate | undefined): string {
  if (d.instruction.trim()) return d.instruction.trim();
  if (t) { const ins = instructionPart(t.body); return t.output && t.output !== d.path ? ins.split(t.output).join(d.path) : ins; }
  return `목표: '${d.title}' 문서를 작성한다. 결과는 ${d.path} 한 파일이다.\n읽을 자료: 이 프로젝트의 기획(목표·완료 조건)과 앞 순서의 완성 문서.\n원칙: 근거가 없는 내용은 "근거 없음"으로 표시하고, 실행하지 않은 검증을 통과로 쓰지 않는다.`;
}

export function computeDocs(folder: string, items: DocItem[], templates: PromptTemplate[]): ProjectDoc[] {
  const byId = new Map(templates.map((t) => [t.id, t]));
  const out: ProjectDoc[] = [];
  items.forEach((d, i) => {
    const t = d.templateId ? byId.get(d.templateId) : undefined;
    const abs = folder ? join(folder, ...d.path.split('/')) : '';
    let exists = false; let sha: string | null = null;
    try { exists = !!folder && existsSync(abs) && statSync(abs).isFile() && inside(folder, abs); if (exists) sha = fileSha(abs); } catch { exists = false; }
    const status: ProjectDoc['status'] = d.excluded ? 'excluded' : !exists ? 'missing' : !d.reviewedSha ? 'draft' : d.reviewedSha === sha ? 'reviewed' : 'changed';
    out.push({ ...d, order: i + 1, status, exists, absPath: abs, summary: t?.summary ?? '', body: t ? (t.output && t.output !== d.path ? t.body.split(t.output).join(d.path) : t.body) : docInstruction(d, undefined), resolvedInstruction: docInstruction(d, t), missingBefore: [] });
  });
  // 앞 순서에서 아직 없는 문서(제외한 문서는 보지 않는다) — 만들 때 참고로 알려 준다
  for (const d of out) d.missingBefore = out.filter((x) => x.order < d.order && x.status === 'missing').map((x) => x.title);
  return out;
}
