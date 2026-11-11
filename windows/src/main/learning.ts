// 배운 것 — 사용자의 지시·답변·추가 지시·권한 허용에서 배운 사실을 이 PC에만 저장하고, 다음 지시와 다른 프로젝트에 쓴다.
// - 배운 것은 바로 반영한다(자동). 새로 배운 것은 '검토 필요'로 표시해 사용자가 나중에 고치거나 끄거나 지운다.
// - 범위: global(모든 프로젝트) / project(그 프로젝트만)
// - 비밀값은 저장하지 않는다(가림 처리 후 저장).
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Learning, LearningFields } from '../shared/types';
import { redact } from './cli/claudeCli';

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const KINDS = new Set(['preference', 'environment', 'rule', 'fact']);

export class LearningStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS learnings (id TEXT PRIMARY KEY, scope TEXT, project_id TEXT, kind TEXT, text TEXT, source TEXT, reviewed INTEGER, active INTEGER, created_at TEXT, updated_at TEXT);`);
  }
  private toItem(r: Row): Learning {
    return { id: String(r.id), scope: r.scope === 'project' ? 'project' : 'global', projectId: (r.project_id as string) || null, kind: (KINDS.has(String(r.kind)) ? r.kind : 'fact') as Learning['kind'],
      text: String(r.text ?? ''), source: String(r.source ?? ''), reviewed: !!r.reviewed, active: !!r.active, createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
  }
  /** 전체 목록. 검토 필요(새로 배운 것)를 먼저, 그다음 최근 순 */
  list(): Learning[] {
    return (this.db.prepare('SELECT * FROM learnings ORDER BY reviewed ASC, updated_at DESC').all() as Row[]).map((r) => this.toItem(r));
  }
  /** 이 프로젝트에 적용되는 것(모든 프로젝트 + 이 프로젝트, 켜진 것만) */
  applicable(projectId: string): Learning[] {
    return this.list().filter((l) => l.active && (l.scope === 'global' || l.projectId === projectId));
  }
  toReview(): number {
    return Number((this.db.prepare('SELECT COUNT(*) c FROM learnings WHERE reviewed=0 AND active=1').get() as Row).c);
  }
  /** 같은 범위에 같은 문장이 있으면 새로 넣지 않는다 */
  add(f: LearningFields, opts: { source: string; reviewed: boolean }): Learning | null {
    const text = redact(f.text.trim()).slice(0, 400);
    if (!text) return null;
    const projectId = f.scope === 'project' ? f.projectId : null;
    const dup = this.list().find((l) => l.scope === f.scope && (l.projectId ?? null) === projectId && norm(l.text) === norm(text));
    if (dup) return null;
    const id = randomUUID(); const t = now();
    this.db.prepare('INSERT INTO learnings VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, f.scope, projectId, KINDS.has(f.kind) ? f.kind : 'fact', text, redact(opts.source).slice(0, 200), opts.reviewed ? 1 : 0, 1, t, t);
    return this.get(id);
  }
  get(id: string): Learning {
    const r = this.db.prepare('SELECT * FROM learnings WHERE id=?').get(id) as Row | undefined;
    if (!r) throw new Error('배운 것을 찾을 수 없습니다.');
    return this.toItem(r);
  }
  /** 사용자가 고치면 검토한 것으로 본다 */
  update(id: string, patch: Partial<Pick<Learning, 'text' | 'scope' | 'projectId' | 'kind' | 'active' | 'reviewed'>>): Learning {
    const cur = this.get(id);
    const n = { ...cur, ...patch };
    const text = redact(n.text.trim()).slice(0, 400);
    if (!text) throw new Error('내용을 입력하세요.');
    this.db.prepare('UPDATE learnings SET scope=?, project_id=?, kind=?, text=?, reviewed=?, active=?, updated_at=? WHERE id=?')
      .run(n.scope, n.scope === 'project' ? n.projectId : null, KINDS.has(n.kind) ? n.kind : 'fact', text, patch.reviewed === false ? 0 : 1, n.active ? 1 : 0, now(), id);
    return this.get(id);
  }
  remove(id: string) { this.db.prepare('DELETE FROM learnings WHERE id=?').run(id); }
  markReviewed(ids: string[]) { for (const id of ids) this.db.prepare('UPDATE learnings SET reviewed=1 WHERE id=?').run(id); }

  /** 운영·직원 지시에 붙이는 '배운 것' 문단(글자 수 제한) */
  promptSection(projectId: string, maxChars = 1800): string {
    const items = this.applicable(projectId);
    if (!items.length) return '';
    const label: Record<Learning['kind'], string> = { preference: '선호', environment: '환경', rule: '규칙', fact: '사실' };
    const lines: string[] = [];
    let n = 0;
    for (const l of items) {
      const line = `- [${l.scope === 'global' ? '공통' : '이 프로젝트'}·${label[l.kind]}] ${l.text}`;
      if (n + line.length > maxChars) break;
      lines.push(line); n += line.length + 1;
    }
    return ['## 사용자에 대해 배운 것(이전 지시·답변에서 학습, 사용자가 언제든 고칠 수 있음)', '아래를 기본으로 따른다. 이번 지시와 다르면 이번 지시가 우선이다.', ...lines].join('\n');
  }
}

function norm(s: string) { return s.replace(/\s+/g, ' ').trim().toLowerCase(); }

/** 오퍼레이터가 배운 것을 정리할 때 쓰는 출력 형식 */
export const LEARN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: {
    items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['scope', 'kind', 'text'],
      properties: { scope: { type: 'string', enum: ['global', 'project'] }, kind: { type: 'string', enum: ['preference', 'environment', 'rule', 'fact'] }, text: { type: 'string' } } } },
  },
};
