// 프로젝트 완성 문서 — '이 프로젝트를 완성하려면 필요한 문서' 목록.
// 프롬프트를 복사해 각자 환경에서 산출물을 만들고, 파일을 올려(프로젝트 폴더로 복사) 등록한다. 운영 오퍼레이터는 이 문서들을 근거로 읽는다.
import { useState } from 'react';
import type { DocItem, ProjectDoc, Project } from '../../shared/types';
import { useAction, useLoad, ws } from '../api';
import { Badge, Banner, Loading, Modal } from './common';
import { TemplateModal } from './TemplatesPanel';

const STATUS: Record<ProjectDoc['status'], { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' | 'info' }> = {
  missing: { label: '없음', tone: 'bad' },
  draft: { label: '작성됨 · 검토 전', tone: 'warn' },
  changed: { label: '검토 후 바뀜', tone: 'warn' },
  reviewed: { label: '검토 완료', tone: 'ok' },
  excluded: { label: '이 프로젝트에 불필요', tone: 'neutral' },
};
const toItem = (d: ProjectDoc): DocItem => ({ id: d.id, title: d.title, path: d.path, templateId: d.templateId, instruction: d.instruction, excluded: d.excluded, reviewedSha: d.reviewedSha, reviewedAt: d.reviewedAt });

export function docProgress(docs: ProjectDoc[]) {
  const need = docs.filter((d) => d.status !== 'excluded');
  const done = need.filter((d) => d.status === 'reviewed').length;
  const next = need.find((d) => d.status !== 'reviewed') ?? null;
  return { need: need.length, done, next };
}

/** 기획 탭: 진행 요약 한 줄 + '완성 문서 목록' 팝업 */
export function DocSetLauncher({ project }: { project: Project }) {
  const docs = useLoad(() => ws().projectDocs(project.id), [project.id, project.planVersion]);
  const [open, setOpen] = useState(false);
  const pr = docs.data ? docProgress(docs.data) : null;
  return (
    <span className="docset-launch">
      <button className="btn" onClick={() => setOpen(true)} title="이 프로젝트를 완성하려면 필요한 문서">
        완성 문서 목록…
      </button>
      {pr && (
        <span className="small muted">
          검토 완료 <strong>{pr.done}/{pr.need}</strong>
          {pr.next ? <> · 다음: {pr.next.title}</> : pr.need ? ' · 모두 검토 완료' : ''}
        </span>
      )}
      {open && <DocSetModal project={project} onClose={() => { setOpen(false); void docs.reload(); }} />}
    </span>
  );
}

function DocSetModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const docs = useLoad(() => ws().projectDocs(project.id), [project.id]);
  const act = useAction();
  const [preview, setPreview] = useState<ProjectDoc | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [editPath, setEditPath] = useState<{ id: string; value: string } | null>(null);
  const [adding, setAdding] = useState<{ title: string; path: string; instruction: string } | null>(null);
  const list = docs.data ?? [];
  const save = (items: DocItem[]) => act.run(async () => { await ws().saveProjectDocs(project.id, items); await docs.reload(); });
  const items = () => list.map(toItem);
  const patch = (id: string, p: Partial<DocItem>) => save(items().map((d) => (d.id === id ? { ...d, ...p } : d)));
  const move = (i: number, dir: -1 | 1) => { const a = items(); const j = i + dir; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; void save(a); };
  const pr = docProgress(list);

  if (preview) {
    const t = { id: preview.id, title: preview.title, summary: preview.summary, output: preview.path, body: preview.body || preview.resolvedInstruction };
    return <TemplateModal t={t} onBack={() => setPreview(null)} onClose={onClose} />;
  }
  return (
    <Modal title="프로젝트 완성 문서" onClose={onClose} wide>
      <p className="muted small">
        이 프로젝트를 완성하려면 아래 문서가 필요합니다. <strong>프롬프트 복사</strong>로 가져가 각자 환경에 맞춰 문서를 만든 뒤 <strong>파일 올리기</strong>로 등록하세요(프로젝트 폴더의 문서 경로로 복사).
        운영에서 지시하면 오퍼레이터가 등록된 문서를 근거로 읽고, 근거가 빈약하거나 애매하면 채울 부분을 알려 주고 멈춥니다. 모든 문서가 다 있어야 하는 것은 아닙니다.
      </p>
      <div className="row gap wrap">
        <Badge tone="ok">검토 완료 {pr.done}/{pr.need}</Badge>
        {pr.next && <span className="small">다음 할 문서: <strong>{pr.next.title}</strong></span>}
      </div>
      {act.error && <Banner>{act.error}</Banner>}
      {docs.loading && !docs.data && <Loading />}
      {docs.error && <Banner>{docs.error}</Banner>}
      <ol className="docset-list">
        {list.map((d, i) => {
          const st = STATUS[d.status];
          return (
            <li key={d.id} className={`docset-row st-${d.status}`}>
              <div className="docset-main">
                <span className="docset-order">{d.order}</span>
                <div className="grow">
                  <div className="row gap wrap">
                    <strong>{d.title}</strong>
                    <Badge tone={st.tone}>{st.label}</Badge>
                    {!d.templateId && <span className="muted small">추가한 문서</span>}
                  </div>
                  {d.summary && <div className="small muted">{d.summary}</div>}
                  {editPath?.id === d.id ? (
                    <div className="row gap">
                      <input className="input mono small grow" value={editPath.value} onChange={(e) => setEditPath({ id: d.id, value: e.target.value })} aria-label="문서 경로" />
                      <button className="btn" disabled={act.busy} onClick={() => { void patch(d.id, { path: editPath.value }); setEditPath(null); }}>저장</button>
                      <button className="btn" onClick={() => setEditPath(null)}>취소</button>
                    </div>
                  ) : (
                    <div className="row gap">
                      {d.exists ? (
                        <button className="file-path" title={`${d.absPath}\n누르면 기본 앱으로 엽니다`} onClick={() => void act.run(async () => { const err = await ws().openPath(d.absPath); if (err) throw new Error(err); })}>{d.path}</button>
                      ) : (
                        <span className="mono small muted">{d.path}</span>
                      )}
                      <button className="btn-link small" onClick={() => setEditPath({ id: d.id, value: d.path })}>경로 바꾸기</button>
                    </div>
                  )}
                  {d.status !== 'excluded' && d.status !== 'reviewed' && d.missingBefore.length > 0 && (
                    <div className="small warn-line">먼저 있으면 좋은 문서: {d.missingBefore.join(', ')}</div>
                  )}
                </div>
              </div>
              <div className="docset-actions">
                {d.status !== 'excluded' && (
                  <>
                    <button className="btn" onClick={() => void act.run(async () => { await navigator.clipboard.writeText(d.body); setCopied(d.id); })} title="이 문서를 만드는 프롬프트(경로 반영)를 복사합니다">
                      {copied === d.id ? '복사됨' : '프롬프트 복사'}
                    </button>
                    <button className={`btn ${d.status === 'missing' && pr.next?.id === d.id ? 'btn-primary' : ''}`} disabled={act.busy} onClick={() => void act.run(async () => { await ws().uploadProjectDoc(project.id, d.id); await docs.reload(); })} title="만든 문서 파일을 골라 프로젝트 폴더의 이 경로로 복사합니다">
                      {d.exists ? '파일 바꾸기' : '파일 올리기'}
                    </button>
                  </>
                )}
                {d.exists && d.status !== 'excluded' && (
                  d.status === 'reviewed'
                    ? <button className="btn" disabled={act.busy} onClick={() => void act.run(async () => { await ws().reviewProjectDoc(project.id, d.id, false); await docs.reload(); })}>검토 취소</button>
                    : <button className="btn" disabled={act.busy} onClick={() => void act.run(async () => { await ws().reviewProjectDoc(project.id, d.id, true); await docs.reload(); })}>검토 완료</button>
                )}
                <button className="btn-link small" onClick={() => setPreview(d)}>프롬프트 보기</button>
                <button className="btn-link small" disabled={act.busy} onClick={() => void patch(d.id, { excluded: !d.excluded })}>{d.excluded ? '다시 포함' : '빼기'}</button>
                <span className="docset-move">
                  <button className="btn-link small" disabled={act.busy || i === 0} onClick={() => move(i, -1)} aria-label="위로">↑</button>
                  <button className="btn-link small" disabled={act.busy || i === list.length - 1} onClick={() => move(i, 1)} aria-label="아래로">↓</button>
                </span>
                {!d.templateId && <button className="btn-link small danger" disabled={act.busy} onClick={() => { if (confirm(`'${d.title}'을(를) 목록에서 지울까요? 파일은 지우지 않습니다.`)) void save(items().filter((x) => x.id !== d.id)); }}>목록에서 삭제</button>}
              </div>
            </li>
          );
        })}
      </ol>
      {adding ? (
        <div className="card docset-add">
          <strong>문서 추가</strong>
          <input className="input" placeholder="문서 이름(예: 운영 정책서)" value={adding.title} onChange={(e) => setAdding({ ...adding, title: e.target.value })} />
          <input className="input mono" placeholder="경로(프로젝트 폴더 기준, 예: crewgenai-output/docs/09-ops-policy.md)" value={adding.path} onChange={(e) => setAdding({ ...adding, path: e.target.value })} />
          <textarea className="input" rows={3} placeholder="이 문서를 만드는 프롬프트(비우면 기본 프롬프트를 씁니다)" value={adding.instruction} onChange={(e) => setAdding({ ...adding, instruction: e.target.value })} />
          <div className="row gap end">
            <button className="btn" onClick={() => setAdding(null)}>취소</button>
            <button className="btn btn-primary" disabled={act.busy} onClick={() => void act.run(async () => {
              await ws().saveProjectDocs(project.id, [...items(), { id: '', title: adding.title, path: adding.path, templateId: null, instruction: adding.instruction, excluded: false, reviewedSha: null, reviewedAt: null }]);
              await docs.reload(); setAdding(null);
            })}>추가</button>
          </div>
        </div>
      ) : (
        <div className="row gap between">
          <button className="btn" onClick={() => setAdding({ title: '', path: '', instruction: '' })}>+ 문서 추가</button>
          <button className="btn-link small" disabled={act.busy} onClick={() => { if (confirm('표준 문서 세트로 되돌릴까요? 추가한 문서·경로 변경·검토 표시가 지워집니다(파일은 그대로).')) void act.run(async () => { await ws().resetProjectDocs(project.id); await docs.reload(); }); }}>표준 세트로 되돌리기</button>
        </div>
      )}
    </Modal>
  );
}
