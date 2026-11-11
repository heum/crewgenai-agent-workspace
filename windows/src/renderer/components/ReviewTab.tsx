import { useEffect, useMemo, useState } from 'react';
import type { Agent, Artifact, Project, RunDetail } from '../../shared/types';
import { NODE_STATUS_LABEL, RUN_STATUS_LABEL } from '../../shared/types';
import { fmtDate, isComposingEnter, useAction, useLoad, ws } from '../api';
import { Markdown } from '../markdown';
import { Badge, Banner, Empty, Field, Loading } from './common';
import { ArtifactList, ExecutorBadge, ReviewList, runTone } from './RunTab';
import { useRunDetail, useRunList } from './useRunDetail';

export default function ReviewTab({ project, initialRunId, onOpenRun }: { project: Project; initialRunId: string | null; onOpenRun: (id: string) => void }) {
  const runs = useRunList(project.id);
  const agents = useLoad(() => ws().listAgents(project.id, true), [project.id]);
  const [runId, setRunId] = useState<string | null>(initialRunId);

  useEffect(() => {
    if (!runId && runs.data?.length) {
      const waiting = runs.data.find((r) => r.status === 'review_wait' || r.status === 'on_hold');
      setRunId((waiting ?? runs.data[0]).id);
    }
  }, [runs.data, runId]);

  return (
    <div className="review-layout">
      <div className="row gap wrap review-pick">
        <Field label="검토할 실행">
          <select className="input" value={runId ?? ''} onChange={(e) => setRunId(e.target.value || null)}>
            {!runs.data?.length && <option value="">실행 없음</option>}
            {runs.data?.map((r) => (
              <option key={r.id} value={r.id}>
                {fmtDate(r.createdAt)} · {RUN_STATUS_LABEL[r.status]} · 흐름 v{r.graphVersion}
                {r.executor === 'mock' ? ' · 모의 실행' : ''}
              </option>
            ))}
          </select>
        </Field>
        {runId && (
          <button className="btn" onClick={() => onOpenRun(runId)}>
            실행 화면에서 보기
          </button>
        )}
      </div>
      {runs.error && <Banner>{runs.error}</Banner>}
      {runs.loading && !runs.data && <Loading />}
      {runs.data && runs.data.length === 0 && <Empty title="검토할 실행이 없습니다">“실행” 탭에서 업무를 시작하세요.</Empty>}
      {runId && <ReviewBody runId={runId} agents={agents.data ?? []} />}
    </div>
  );
}

const ART_GROUPS: { kind: Artifact['kind']; label: string }[] = [
  { kind: 'code', label: '코드 변경' },
  { kind: 'document', label: '문서' },
  { kind: 'image', label: '이미지' },
  { kind: 'report', label: '검사 보고서' },
  { kind: 'executable', label: '실행 가능한 결과' },
  { kind: 'data', label: '데이터' },
  { kind: 'other', label: '기타' },
];

function ReviewBody({ runId, agents }: { runId: string; agents: Agent[] }) {
  const detail = useRunDetail(runId);
  const d = detail.data;
  if (detail.loading && !d) return <Loading />;
  if (detail.error) return <Banner>{detail.error}</Banner>;
  if (!d) return <Empty title="실행 정보를 찾을 수 없습니다" />;
  return <ReviewContent d={d} agents={agents} />;
}

function ReviewContent({ d, agents }: { d: RunDetail; agents: Agent[] }) {
  const waitingNode = useMemo(() => {
    const st = d.nodes.find((n) => n.status === 'review_wait' && d.graph.nodes.find((g) => g.id === n.nodeId)?.kind === 'userReview');
    return st ? d.graph.nodes.find((g) => g.id === st.nodeId) ?? null : null;
  }, [d]);
  const holdNode = useMemo(() => {
    if (waitingNode || d.run.status !== 'on_hold') return null;
    return d.graph.nodes.find((g) => g.kind === 'userReview') ?? null;
  }, [d, waitingNode]);
  const reviewNode = waitingNode ?? holdNode;
  // 이전 팀장 결정의 대상이 현재 결과물과 다르면(결과물 변경) 새 검토가 필요하다
  const stale = !!d.currentSubjectHash && d.reviews.some((r) => r.kind === 'user' && (r.stale || r.subjectHash !== d.currentSubjectHash)) && d.run.status !== 'succeeded';

  return (
    <div className="split">
      <section className="panel grow">
        <div className="row gap wrap">
          <Badge tone={runTone(d.run.status)}>{RUN_STATUS_LABEL[d.run.status]}</Badge>
          <ExecutorBadge run={d.run} />
          <span className="small muted">
            흐름 v{d.run.graphVersion} · 기획 v{d.run.planVersion}
          </span>
        </div>
        {d.run.executor === 'mock' && <Banner kind="warn">모의 실행 결과입니다. 실제 Claude 작업이 아니므로 실제 Agent 실행 완료 근거로 쓰지 마세요.</Banner>}
        {stale && <Banner kind="warn">결과물이 바뀌어 새 검토가 필요합니다. 이전 검토는 새 결과에 적용되지 않습니다.</Banner>}
        {d.deliverable ? (
          <>
            <div className="row between">
              <h2>최종 결과물</h2>
              <div className="row gap">
                <span className="small muted mono" title={d.deliverable.hash}>
                  버전 {d.deliverable.hash.slice(0, 12)}
                </span>
                <button className="btn-link" onClick={() => void ws().revealInFinder(d.deliverable!.reportPath)}>
                  탐색기에서 보기
                </button>
              </div>
            </div>
            <div className="paper">
              <Markdown text={d.deliverable.markdown} />
            </div>
          </>
        ) : (
          <Empty title="아직 최종 결과물이 없습니다">결과물 취합 단계가 끝나면 이곳에 모입니다.</Empty>
        )}
        <h3>산출물</h3>
        {d.artifacts.length === 0 && <div className="muted small">없음</div>}
        {ART_GROUPS.map((g) => {
          const items = d.artifacts.filter((a) => a.kind === g.kind);
          if (!items.length) return null;
          return (
            <div key={g.kind} className="art-group">
              <h4>
                {g.label} ({items.length})
              </h4>
              <ArtifactList items={items} />
            </div>
          );
        })}
      </section>
      <aside className="panel side-panel wide-side">
        <h3>팀장 검토</h3>
        {reviewNode ? (
          <ReviewActions d={d} nodeId={reviewNode.id} label={reviewNode.label} onHold={!!holdNode} />
        ) : (
          <div className="muted small">
            현재 검토 대기 중인 단계가 없습니다.
            {d.graph.nodes
              .filter((g) => g.kind === 'userReview')
              .map((g) => {
                const st = d.nodes.find((n) => n.nodeId === g.id);
                return (
                  <div key={g.id}>
                    {g.label}: {NODE_STATUS_LABEL[st?.status ?? 'waiting']}
                  </div>
                );
              })}
          </div>
        )}
        <h3>검토 이력</h3>
        {d.reviews.length === 0 ? (
          <div className="muted small">없음</div>
        ) : (
          <ReviewList reviews={[...d.reviews].sort((a, b) => b.createdAt.localeCompare(a.createdAt))} agents={agents} />
        )}
      </aside>
    </div>
  );
}

function ReviewActions({ d, nodeId, label, onHold }: { d: RunDetail; nodeId: string; label: string; onHold: boolean }) {
  const [mode, setMode] = useState<null | 'changes_requested'>(null);
  const [comments, setComments] = useState('');
  const agentNodes = d.graph.nodes.filter((n) => n.kind === 'agent');
  const [target, setTarget] = useState<string>(agentNodes[0]?.id ?? '');
  const act = useAction();
  const [done, setDone] = useState<string | null>(null);
  const subject = d.currentSubjectHash;

  const submit = (verdict: 'approve' | 'changes_requested' | 'hold') =>
    act.run(async () => {
      if (!subject) throw new Error('검토 대상 버전을 확인할 수 없습니다. 결과물이 아직 없습니다.');
      if (verdict === 'changes_requested' && (!comments.trim() || !target)) throw new Error('수정 요청에는 대상 담당과 의견이 필요합니다.');
      await ws().submitReview(d.run.id, nodeId, verdict, comments.trim(), verdict === 'changes_requested' ? target : null, subject);
      setDone(verdict === 'approve' ? '검토 완료로 기록했습니다. 다음 단계 진행을 허용합니다.' : verdict === 'hold' ? '보류로 기록했습니다. 현재 결과와 상태를 보존합니다.' : '수정 요청을 담당의 후속 작업으로 배정했습니다.');
      setMode(null);
      setComments('');
    });

  return (
    <div className="form">
      <div className="small">
        <strong>{label}</strong> {onHold ? '— 보류 중' : '— 검토 대기'}
      </div>
      <div className="small muted mono">검토 대상 {subject ? subject.slice(0, 12) : '없음'}</div>
      {act.error && <Banner>{act.error}</Banner>}
      {done && <Banner kind="ok">{done}</Banner>}
      {mode === 'changes_requested' ? (
        <div className="subform">
          <Field label="수정할 담당 단계">
            <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
              {agentNodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="수정 의견 *">
            <textarea
              className="input"
              rows={5}
              value={comments}
              onChange={(e) => setComments(e.target.value)}
              onKeyDown={(e) => {
                if (isComposingEnter(e)) e.stopPropagation();
              }}
            />
          </Field>
          <div className="row gap end">
            <button className="btn" onClick={() => setMode(null)}>
              취소
            </button>
            <button className="btn btn-primary" disabled={act.busy || !comments.trim() || !target} onClick={() => submit('changes_requested')}>
              수정 요청 보내기
            </button>
          </div>
        </div>
      ) : (
        <>
          <Field label="의견(선택)">
            <textarea className="input" rows={3} value={comments} onChange={(e) => setComments(e.target.value)} />
          </Field>
          <div className="review-buttons">
            <button className="btn" disabled={act.busy || agentNodes.length === 0} onClick={() => setMode('changes_requested')}>
              수정 요청
            </button>
            <button className="btn" disabled={act.busy || onHold} onClick={() => submit('hold')}>
              보류
            </button>
            <button className="btn btn-primary" disabled={act.busy || !subject} onClick={() => submit('approve')}>
              검토 완료
            </button>
          </div>
          <p className="muted small">결정은 현재 결과물·흐름 버전에 연결됩니다. 결과물이 바뀌면 이전 결정은 적용되지 않습니다.</p>
        </>
      )}
    </div>
  );
}
