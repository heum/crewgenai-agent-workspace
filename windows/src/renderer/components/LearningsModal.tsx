// 배운 것 — 지시·답변·권한 허용에서 배운 사실을 보고, 고치고, 끄고, 지운다. 새로 배운 것은 '검토 필요'로 맨 위에 보인다.
import { useState } from 'react';
import type { Learning, LearningFields, Project } from '../../shared/types';
import { fmtDate, useAction, useLoad, ws } from '../api';
import { Badge, Banner, Loading, Modal } from './common';

const KIND_LABEL: Record<Learning['kind'], string> = { preference: '선호', environment: '내 PC 환경', rule: '하지 말 것', fact: '프로젝트 사실' };
const EMPTY: LearningFields = { scope: 'global', projectId: null, kind: 'preference', text: '' };

export default function LearningsModal({ projects, onClose }: { projects: Project[]; onClose: () => void }) {
  const list = useLoad(() => ws().listLearnings(), []);
  const act = useAction();
  const [editing, setEditing] = useState<Record<string, LearningFields & { active: boolean }>>({});
  const [draft, setDraft] = useState<LearningFields | null>(null);
  const name = (pid: string | null) => projects.find((p) => p.id === pid)?.plan.name ?? '(지운 프로젝트)';
  const items = list.data ?? [];
  const toReview = items.filter((l) => !l.reviewed && l.active);

  const save = (id: string | null, f: LearningFields & { active?: boolean }) => act.run(async () => {
    await ws().saveLearning(id, f);
    if (id) setEditing((e) => { const n = { ...e }; delete n[id]; return n; });
    else setDraft(null);
    await list.reload();
  });

  return (
    <Modal title="배운 것" onClose={onClose} wide>
      <p className="muted small">
        지시·답변·추가 지시·권한 허용에서 배운 사실입니다. 이 PC에만 저장되고, 다음 지시와 다른 프로젝트의 오퍼레이터·직원 지시에 자동으로 붙습니다.
        틀린 것은 고치거나 끄거나 지우세요. 이번 지시가 배운 것과 다르면 이번 지시가 우선합니다.
      </p>
      {act.error && <Banner>{act.error}</Banner>}
      {list.loading && !list.data && <Loading />}
      <div className="row gap wrap learn-actions">
        <button className="btn" onClick={() => setDraft({ ...EMPTY })}>+ 직접 추가</button>
        {toReview.length > 0 && (
          <button className="btn btn-primary" disabled={act.busy} onClick={() => void act.run(async () => { await ws().markLearningsReviewed(toReview.map((l) => l.id)); await list.reload(); })}>
            새로 배운 것 {toReview.length}개 모두 확인
          </button>
        )}
      </div>
      {draft && <LearningForm value={draft} projects={projects} onChange={setDraft} onCancel={() => setDraft(null)} onSave={() => void save(null, draft)} busy={act.busy} />}
      {list.data && items.length === 0 && !draft && <div className="muted small pad">아직 배운 것이 없습니다. 미션을 끝내거나 종료하면 그동안의 대화에서 배운 것을 정리합니다.</div>}
      <ul className="learn-list">
        {items.map((l) => {
          const e = editing[l.id];
          return (
            <li key={l.id} className={`learn-item ${!l.reviewed && l.active ? 'new' : ''} ${l.active ? '' : 'off'}`}>
              {e ? (
                <LearningForm value={e} projects={projects} withActive onChange={(v) => setEditing((x) => ({ ...x, [l.id]: { ...e, ...v } }))} onCancel={() => setEditing((x) => { const n = { ...x }; delete n[l.id]; return n; })} onSave={() => void save(l.id, e)} busy={act.busy} />
              ) : (
                <>
                  <div className="row gap wrap learn-head">
                    {!l.reviewed && l.active && <Badge tone="warn">검토 필요</Badge>}
                    {!l.active && <Badge tone="neutral">꺼짐</Badge>}
                    <Badge tone="info">{l.scope === 'global' ? '모든 프로젝트' : name(l.projectId)}</Badge>
                    <span className="muted small">{KIND_LABEL[l.kind]}</span>
                    <span className="muted small grow">{l.source} · {fmtDate(l.updatedAt)}</span>
                  </div>
                  <div className="learn-text">{l.text}</div>
                  <div className="row gap wrap">
                    {!l.reviewed && l.active && <button className="btn btn-sm" disabled={act.busy} onClick={() => void act.run(async () => { await ws().markLearningsReviewed([l.id]); await list.reload(); })}>맞음</button>}
                    <button className="btn btn-sm" onClick={() => setEditing((x) => ({ ...x, [l.id]: { scope: l.scope, projectId: l.projectId, kind: l.kind, text: l.text, active: l.active } }))}>고치기</button>
                    <button className="btn btn-sm" disabled={act.busy} onClick={() => void save(l.id, { scope: l.scope, projectId: l.projectId, kind: l.kind, text: l.text, active: !l.active })}>{l.active ? '끄기' : '다시 켜기'}</button>
                    <button className="btn btn-sm btn-danger" disabled={act.busy} onClick={() => void act.run(async () => { if (!confirm('이 항목을 지울까요?')) return; await ws().deleteLearning(l.id); await list.reload(); })}>지우기</button>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

function LearningForm({ value, projects, withActive, onChange, onCancel, onSave, busy }: {
  value: LearningFields & { active?: boolean }; projects: Project[]; withActive?: boolean; busy: boolean;
  onChange: (v: LearningFields & { active?: boolean }) => void; onCancel: () => void; onSave: () => void;
}) {
  return (
    <div className="learn-form">
      <div className="row gap wrap">
        <select className="input" value={value.scope === 'global' ? 'global' : value.projectId ?? ''} onChange={(e) => onChange(e.target.value === 'global' ? { ...value, scope: 'global', projectId: null } : { ...value, scope: 'project', projectId: e.target.value })} aria-label="적용 범위">
          <option value="global">모든 프로젝트</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.plan.name || '(이름 없음)'}만</option>)}
        </select>
        <select className="input" value={value.kind} onChange={(e) => onChange({ ...value, kind: e.target.value as Learning['kind'] })} aria-label="종류">
          {(Object.keys(KIND_LABEL) as Learning['kind'][]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        {withActive && (
          <label className="check small"><input type="checkbox" checked={value.active !== false} onChange={(e) => onChange({ ...value, active: e.target.checked })} /> 켜기</label>
        )}
      </div>
      <textarea className="input" rows={2} value={value.text} placeholder="예: 문서는 표보다 목록으로 정리한다" onChange={(e) => onChange({ ...value, text: e.target.value })} aria-label="내용" />
      <div className="row gap end">
        <button className="btn" onClick={onCancel}>취소</button>
        <button className="btn btn-primary" disabled={busy || !value.text.trim()} onClick={onSave}>저장</button>
      </div>
    </div>
  );
}
