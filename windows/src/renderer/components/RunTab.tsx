import { autoLayout, needsLayout } from '../../shared/layout';
import { useEffect, useMemo, useState } from 'react';
import { Background, Controls, ReactFlow, ReactFlowProvider } from '@xyflow/react';
import type { Agent, AppSettings, Artifact, Attempt, AttemptEvent, CliStatus, GraphNode, Project, Run, RunDetail, RunStatus } from '../../shared/types';
import { NODE_KIND_LABEL, NODE_STATUS_LABEL, RUN_STATUS_LABEL, billingLabel } from '../../shared/types';
import { fmtDate, useAction, useLoad, ws } from '../api';
import type { QueueInfo } from '../App';
import { Badge, Banner, Collapsible, Empty, Loading } from './common';
import { nodeTypes, toFlowEdges, toFlowNodes } from './flowShared';
import { useRunDetail, useRunList } from './useRunDetail';

export function runTone(s: RunStatus): 'ok' | 'bad' | 'warn' | 'info' | 'neutral' {
  if (s === 'succeeded') return 'ok';
  if (s === 'failed') return 'bad';
  if (s === 'cancelled') return 'neutral';
  if (s === 'running' || s === 'queued') return 'info';
  return 'warn';
}

export function ExecutorBadge({ run }: { run: Run }) {
  return run.executor === 'mock' ? (
    <Badge tone="mock" title="가짜 CLI로 실행한 시험 결과입니다. 실제 Claude 작업이 아닙니다.">
      모의 실행
    </Badge>
  ) : (
    <Badge tone="info">Claude CLI</Badge>
  );
}

export default function RunTab({
  project,
  cli,
  settings,
  queue,
  focusRunId,
  onOpenReview,
}: {
  project: Project;
  cli: CliStatus | null;
  settings: AppSettings | null;
  queue: QueueInfo | null;
  focusRunId: string | null;
  onOpenReview: (runId: string) => void;
}) {
  const runs = useRunList(project.id);
  const graph = useLoad(() => ws().latestGraph(project.id), [project.id]);
  const agents = useLoad(() => ws().listAgents(project.id, true), [project.id]);
  const [selRun, setSelRun] = useState<string | null>(focusRunId);
  useEffect(() => { if (focusRunId) setSelRun(focusRunId); }, [focusRunId]); // '확인 필요'에서 넘어오면 그 실행을 연다
  const act = useAction();

  useEffect(() => {
    if (!selRun && runs.data?.length) setSelRun(runs.data[0].id);
  }, [runs.data, selRun]);

  const executor = settings?.executor ?? 'claude';
  let blockReason: string | null = null;
  if (!graph.data) blockReason = '저장된 업무 흐름이 없습니다. “업무 흐름”에서 저장하세요.';
  else if (executor === 'claude' && !cli?.ready) blockReason = `Claude CLI가 준비되지 않았습니다${cli?.problem ? `: ${cli.problem}` : ''}. 왼쪽 아래 CLI 상태에서 확인하세요.`;

  const start = () =>
    act.run(async () => {
      if (!graph.data) return;
      const r = await ws().startRun(project.id, graph.data.id);
      await runs.reload();
      setSelRun(r.id);
    });

  return (
    <div className="split">
      <section className="panel list-panel">
        <div className="start-box">
          <button className="btn btn-primary block" disabled={!!blockReason || act.busy} onClick={start}>
            {act.busy ? '시작 중…' : '전체 업무 시작'}
          </button>
          <div className="small muted">
            {graph.data ? `흐름 v${graph.data.version} · 기획 v${project.planVersion}` : '흐름 없음'} · {executor === 'mock' ? '모의 실행(시험용)' : 'Claude CLI'}
          </div>
          {blockReason && <div className="small error-text">{blockReason}</div>}
          {executor === 'mock' && !blockReason && <div className="small warn-text">설정이 모의 실행입니다. 결과는 실제 Agent 작업이 아닙니다.</div>}
        </div>
        {queue && (
          <div className="small muted">
            동시 실행 {queue.running}/{queue.max} · 대기 {queue.waiting}
          </div>
        )}
        {act.error && <Banner>{act.error}</Banner>}
        {runs.error && <Banner>{runs.error}</Banner>}
        {runs.loading && !runs.data && <Loading />}
        {runs.data && runs.data.length === 0 && <Empty title="실행 기록이 없습니다" />}
        <div className="run-list">
          {runs.data?.map((r) => (
            <button key={r.id} className={`run-item ${selRun === r.id ? 'active' : ''}`} onClick={() => setSelRun(r.id)}>
              <div className="row between">
                <Badge tone={runTone(r.status)}>{RUN_STATUS_LABEL[r.status]}</Badge>
                <ExecutorBadge run={r} />
              </div>
              <div className="small">
                흐름 v{r.graphVersion} · 기획 v{r.planVersion}
                {r.parentRunId ? ' · 재실행' : ''}
              </div>
              <div className="small muted">{fmtDate(r.createdAt)}</div>
            </button>
          ))}
        </div>
      </section>
      <section className="panel grow no-pad">
        {selRun ? (
          <ReactFlowProvider>
            <RunDetailView runId={selRun} agents={agents.data ?? []} onOpenReview={onOpenReview} onNewRun={(id) => { void runs.reload(); setSelRun(id); }} />
          </ReactFlowProvider>
        ) : (
          <Empty title="실행을 선택하세요" />
        )}
      </section>
    </div>
  );
}

function RunDetailView({ runId, agents, onOpenReview, onNewRun }: { runId: string; agents: Agent[]; onOpenReview: (id: string) => void; onNewRun: (id: string) => void }) {
  const detail = useRunDetail(runId);
  const [selNode, setSelNode] = useState<string | null>(null);
  const act = useAction();
  const d = detail.data;

  const stateById = useMemo(() => new Map((d?.nodes ?? []).map((n) => [n.nodeId, n])), [d]);
  const flowNodes = useMemo(
    () =>
      d
        ? toFlowNodes((needsLayout(d.graph) ? autoLayout(d.graph) : d.graph).nodes, agents, (n) => ({ status: stateById.get(n.id)?.status ?? 'waiting', visits: stateById.get(n.id)?.visits ?? 0 })).map((n) => ({
            ...n,
            selected: n.id === selNode,
            draggable: false,
            connectable: false,
          }))
        : [],
    [d, agents, stateById, selNode],
  );
  const flowEdges = useMemo(() => (d ? toFlowEdges(d.graph.edges) : []), [d]);

  if (detail.loading && !d) return <Loading />;
  if (detail.error) return <Banner>{detail.error}</Banner>;
  if (!d) return <Empty title="실행 정보를 찾을 수 없습니다" />;
  const run = d.run;
  const active = ['queued', 'running', 'paused', 'review_wait', 'on_hold', 'needs_resume'].includes(run.status);
  const needsResume = run.status === 'needs_resume' || d.nodes.some((n) => n.status === 'needs_resume');
  const reviewWait = d.nodes.find((n) => n.status === 'review_wait' && d.graph.nodes.find((g) => g.id === n.nodeId)?.kind === 'userReview');
  const node = selNode ? d.graph.nodes.find((n) => n.id === selNode) ?? null : null;

  return (
    <div className="run-detail">
      <div className="run-head">
        <div className="row gap wrap">
          <Badge tone={runTone(run.status)}>{RUN_STATUS_LABEL[run.status]}</Badge>
          <ExecutorBadge run={run} />
          <span className="small muted">
            실행 {run.id.slice(0, 8)} · 흐름 v{run.graphVersion} · 기획 v{run.planVersion} · 시작 {fmtDate(run.createdAt)}
            {run.finishedAt ? ` · 종료 ${fmtDate(run.finishedAt)}` : ''}
          </span>
        </div>
        {run.reason && <div className="small">사유: {run.reason}</div>}
        <div className="row gap wrap">
          {run.status === 'paused' ? (
            <button className="btn" disabled={act.busy} onClick={() => act.run(() => ws().resumeRun(run.id))}>
              새 배정 재개
            </button>
          ) : (
            <button className="btn" disabled={act.busy || !['running', 'queued'].includes(run.status)} onClick={() => act.run(() => ws().pauseRun(run.id))} title="진행 중인 작업은 계속하고, 새 작업 배정만 멈춥니다.">
              새 배정 일시정지
            </button>
          )}
          <button
            className="btn danger"
            disabled={act.busy || !active}
            onClick={() => {
              if (confirm('이 실행을 취소합니다. 진행 중인 Claude 프로세스를 실제로 종료합니다. 계속할까요?')) void act.run(() => ws().cancelRun(run.id));
            }}
          >
            실행 취소
          </button>
          <button
            className="btn"
            disabled={act.busy || !selNode || active}
            title={active ? '진행 중인 실행에서는 사용할 수 없습니다.' : !selNode ? '그림에서 단계를 선택하세요.' : '완료된 다른 단계는 다시 실행하지 않습니다.'}
            onClick={() =>
              act.run(async () => {
                const r = await ws().rerunFrom(run.id, selNode!);
                onNewRun(r.id);
              })
            }
          >
            선택 단계부터 재실행
          </button>
          {(d.deliverable || reviewWait) && (
            <button className="btn btn-primary" onClick={() => onOpenReview(run.id)}>
              결과물·검토 열기
            </button>
          )}
        </div>
        {act.error && <Banner>{act.error}</Banner>}
        {needsResume && (
          <Banner kind="warn">
            {run.reason.startsWith('사용 한도 도달')
              ? `${run.reason}. 기다리지 않으려면 단계별 처리 방법을 고른 뒤 “재개”를 누르세요(한도가 풀리지 않았으면 다시 멈춥니다).`
              : '앱 종료 등으로 중단된 단계가 있습니다. 각 단계의 처리 방법을 고른 뒤 “재개”를 누르세요. 완료된 단계는 다시 실행하지 않습니다.'}
            <div className="resume-list">
              {d.nodes
                .filter((n) => n.status === 'needs_resume')
                .map((n) => {
                  const g = d.graph.nodes.find((x) => x.id === n.nodeId);
                  return (
                    <div key={n.nodeId} className="row gap wrap">
                      <strong>{g?.label ?? n.nodeId}</strong>
                      <button className="btn" disabled={act.busy} onClick={() => act.run(() => ws().resolveInterrupted(run.id, n.nodeId, 'verify_only'))} title="이미 만든 결과를 검사만 하고, 통과하면 완료로 처리">
                        결과만 검사
                      </button>
                      <button className="btn" disabled={act.busy} onClick={() => act.run(() => ws().resolveInterrupted(run.id, n.nodeId, 'continue_session'))} title="같은 Claude 세션을 이어서 작업">
                        세션 이어서 작업
                      </button>
                      <button className="btn" disabled={act.busy} onClick={() => act.run(() => ws().resolveInterrupted(run.id, n.nodeId, 'retry'))} title="새 시도로 처음부터">
                        새 시도로 재실행
                      </button>
                    </div>
                  );
                })}
            </div>
            <button className="btn btn-primary" disabled={act.busy} onClick={() => act.run(() => ws().resumeRun(run.id))}>
              재개
            </button>
          </Banner>
        )}
      </div>
      <div className="run-body">
        <div className="run-canvas">
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            onNodeClick={(_, n) => setSelNode(n.id)}
            onPaneClick={() => setSelNode(null)}
            fitView
            fitViewOptions={{ padding: 0.08, maxZoom: 1.1 }}
            minZoom={0.2}
          >
            <Background gap={20} />
            <Controls showInteractive={false} />
          </ReactFlow>
          <StatusLegend detail={d} />
        </div>
        <aside className="run-side">
          {node ? <NodeDetail detail={d} node={node} agents={agents} /> : <RunSummary detail={d} onPick={setSelNode} />}
        </aside>
      </div>
    </div>
  );
}

function StatusLegend({ detail }: { detail: RunDetail }) {
  const counts = new Map<string, number>();
  for (const n of detail.graph.nodes) {
    const s = detail.nodes.find((x) => x.nodeId === n.id)?.status ?? 'waiting';
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return (
    <div className="legend-bar">
      {[...counts.entries()].map(([s, c]) => (
        <span key={s} className={`legend-pill st-${s}`}>
          {NODE_STATUS_LABEL[s as keyof typeof NODE_STATUS_LABEL]} {c}
        </span>
      ))}
    </div>
  );
}

function RunSummary({ detail, onPick }: { detail: RunDetail; onPick: (id: string) => void }) {
  const failed = detail.nodes.filter((n) => n.status === 'failed' || n.failureReason);
  const reported = detail.attempts.filter((a) => a.costUsd !== null);
  const cost = reported.reduce((s, a) => s + (a.costUsd ?? 0), 0);
  return (
    <div className="form">
      <h3>실행 요약</h3>
      <p className="small muted">그림에서 단계를 선택하면 상세 정보를 볼 수 있습니다.</p>
      <dl className="kv">
        <dt>시도</dt>
        <dd>{detail.attempts.length}회</dd>
        <dt>산출물</dt>
        <dd>{detail.artifacts.length}개</dd>
        <dt>검사</dt>
        <dd>
          {detail.checks.filter((c) => c.ok).length} 통과 / {detail.checks.filter((c) => !c.ok).length} 실패
        </dd>
        <dt>사용량</dt>
        <dd>
          {reported.length === 0
            ? `미보고(측정값 없음) · ${billingLabel(detail.billing)}`
            : `$${cost.toFixed(4)} — ${billingLabel(detail.billing)} (CLI 보고 ${reported.length}/${detail.attempts.length}건)`}
        </dd>
      </dl>
      {failed.length > 0 && (
        <>
          <h3>실패·재작업</h3>
          <ul className="small">
            {failed.map((n) => (
              <li key={n.nodeId}>
                <button className="btn-link" onClick={() => onPick(n.nodeId)}>
                  {detail.graph.nodes.find((g) => g.id === n.nodeId)?.label ?? n.nodeId}
                </button>{' '}
                — {n.failureReason || NODE_STATUS_LABEL[n.status]}
                {n.nextAction && <div className="muted">다음: {n.nextAction}</div>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function agentName(agents: Agent[], id: string | null) {
  if (!id) return '-';
  const a = agents.find((x) => x.id === id);
  return a ? `${a.code} ${a.name}${a.fired ? '(해고)' : ''}` : `(없는 담당 ${id.slice(0, 6)})`;
}

function NodeDetail({ detail, node, agents }: { detail: RunDetail; node: GraphNode; agents: Agent[] }) {
  const st = detail.nodes.find((n) => n.nodeId === node.id);
  const attempts = detail.attempts.filter((a) => a.nodeId === node.id).sort((a, b) => a.visit - b.visit || a.attemptNo - b.attemptNo);
  const checks = detail.checks.filter((c) => c.nodeId === node.id);
  const artifacts = detail.artifacts.filter((a) => a.nodeId === node.id);
  const reviews = detail.reviews.filter((r) => r.nodeId === node.id || r.targetNodeId === node.id);
  const changed = [...new Set(attempts.flatMap((a) => a.changedFiles))];
  return (
    <div className="form node-detail">
      <div className="row between">
        <h3>{node.label}</h3>
        <Badge tone="neutral">{NODE_KIND_LABEL[node.kind]}</Badge>
      </div>
      <div className="row gap wrap">
        <span className={`legend-pill st-${st?.status ?? 'waiting'}`}>{NODE_STATUS_LABEL[st?.status ?? 'waiting']}</span>
        <span className="small muted">방문 {st?.visits ?? 0}회</span>
      </div>
      {st?.summary && <p className="small">{st.summary}</p>}
      {st?.failureReason && <Banner kind="error">실패 원인: {st.failureReason}</Banner>}
      {st?.nextAction && <Banner kind="info">다음 처리: {st.nextAction}</Banner>}
      <dl className="kv">
        <dt>담당</dt>
        <dd>{agentName(agents, node.agentId)}</dd>
        <dt>검토자</dt>
        <dd>{agentName(agents, node.reviewerAgentId)}</dd>
        {node.kind === 'check' && (
          <>
            <dt>명령</dt>
            <dd className="mono">{node.command.join(' ') || '-'}</dd>
          </>
        )}
        <dt>입력</dt>
        <dd>
          {node.inputs.length ? node.inputs.join(', ') : '-'}
          {node.useUpstreamOutputs ? ' (+ 앞 단계 산출물)' : ''}
        </dd>
        <dt>출력</dt>
        <dd>{node.outputs.length ? node.outputs.map((o) => `${o.path} (${o.format}${o.required ? ', 필수' : ''})`).join(', ') : '-'}</dd>
      </dl>
      {node.instructions && (
        <Collapsible title="업무 지시">
          <pre className="pre-wrap">{node.instructions}</pre>
        </Collapsible>
      )}
      {node.doneCriteria && (
        <Collapsible title="완료 조건">
          <pre className="pre-wrap">{node.doneCriteria}</pre>
        </Collapsible>
      )}

      <h4>실행 이력 ({attempts.length})</h4>
      {attempts.length === 0 && <div className="muted small">아직 실행되지 않았습니다.</div>}
      {attempts.map((a) => (
        <AttemptCard key={a.id} a={a} agents={agents} />
      ))}

      <h4>변경 파일 ({changed.length})</h4>
      {changed.length === 0 ? <div className="muted small">없음</div> : <ul className="small mono">{changed.map((f) => <li key={f}>{f}</li>)}</ul>}

      <h4>검사 결과 ({checks.length})</h4>
      {checks.length === 0 && <div className="muted small">없음</div>}
      {checks.map((c) => (
        <Collapsible
          key={c.id}
          title={
            <span>
              <Badge tone={c.ok ? 'ok' : 'bad'}>{c.ok ? '통과' : '실패'}</Badge> {c.name} · 종료 코드 {c.exitCode ?? '없음'} · {(c.durationMs / 1000).toFixed(1)}초
            </span>
          }
        >
          <div className="mono small">{c.argv.join(' ')}</div>
          <pre className="log">{c.output || '(출력 없음)'}</pre>
        </Collapsible>
      ))}

      <h4>산출물 ({artifacts.length})</h4>
      <ArtifactList items={artifacts} />

      {reviews.length > 0 && (
        <>
          <h4>검토 기록</h4>
          <ReviewList reviews={reviews} agents={agents} />
        </>
      )}
    </div>
  );
}

export function ReviewList({ reviews, agents }: { reviews: RunDetail['reviews']; agents: Agent[] }) {
  const label = { approve: '승인', changes_requested: '수정 요청', hold: '보류' } as const;
  return (
    <ul className="review-list">
      {reviews.map((r) => (
        <li key={r.id} className={r.stale ? 'stale' : ''}>
          <div className="row gap wrap">
            <Badge tone={r.verdict === 'approve' ? 'ok' : r.verdict === 'hold' ? 'warn' : 'bad'}>{label[r.verdict]}</Badge>
            <span className="small">{r.kind === 'user' ? '팀장' : `독립 검토 · ${agentName(agents, r.reviewerAgentId)}`}</span>
            {r.stale && <Badge tone="warn">무효(대상 변경됨)</Badge>}
            <span className="small muted">{fmtDate(r.createdAt)}</span>
          </div>
          {r.comments && <pre className="pre-wrap small">{r.comments}</pre>}
          <div className="small muted mono">대상 {r.subjectHash.slice(0, 12)}</div>
        </li>
      ))}
    </ul>
  );
}

const KIND_LABEL: Record<Artifact['kind'], string> = {
  code: '코드',
  document: '문서',
  image: '이미지',
  report: '검사 보고서',
  executable: '실행 결과',
  data: '데이터',
  other: '기타',
};

export function ArtifactList({ items }: { items: Artifact[] }) {
  const act = useAction();
  if (items.length === 0) return <div className="muted small">없음</div>;
  return (
    <div>
      {act.error && <Banner>{act.error}</Banner>}
      <ul className="artifact-list">
        {items.map((a) => (
          <li key={a.id}>
            <Badge tone="neutral">{KIND_LABEL[a.kind]}</Badge>
            <span className="mono small ellipsis grow" title={a.path}>
              {a.relPath}
            </span>
            <span className="small muted">{(a.size / 1024).toFixed(1)}KB</span>
            <button className="btn-link" onClick={() => act.run(() => ws().previewFile(a.path))}>
              미리보기
            </button>
            <button className="btn-link" onClick={() => act.run(() => ws().revealInFinder(a.path))}>
              탐색기
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const ATT_STATUS: Record<Attempt['status'], string> = {
  running: '실행 중',
  succeeded: '성공',
  failed: '실패',
  cancelled: '취소',
  interrupted: '중단됨',
  timeout: '시간 초과',
};

function AttemptCard({ a, agents }: { a: Attempt; agents: Agent[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`attempt att-${a.status}`}>
      <div className="row gap wrap">
        <strong>
          방문 {a.visit} · 시도 {a.attemptNo}
        </strong>
        <Badge tone={a.status === 'succeeded' ? 'ok' : a.status === 'running' ? 'info' : a.status === 'cancelled' ? 'neutral' : 'bad'}>{ATT_STATUS[a.status]}</Badge>
        <span className="small muted">
          {a.role === 'author' ? '작성' : a.role === 'reviewer' ? 'Claude 검토' : a.role === 'check' ? '검사' : a.role === 'codex' ? 'Codex 리뷰' : a.role === 'operator' ? '오퍼레이터' : '시스템'} · {a.role === 'codex' ? 'Codex CLI' : agentName(agents, a.agentId)}
          {a.agentVersion ? ` (정의 v${a.agentVersion})` : ''}
        </span>
      </div>
      {a.summary && <div className="small">{a.summary}</div>}
      {a.error && <div className="small error-text">{a.error}</div>}
      <dl className="kv small">
        <dt>종료 코드</dt>
        <dd>{a.exitCode ?? '-'}</dd>
        <dt>결과 상태</dt>
        <dd>
          {a.resultSubtype ?? '-'}
          {a.isError === true ? ' (오류)' : ''}
        </dd>
        <dt>사용량</dt>
        <dd>{a.costUsd === null ? '미보고' : `$${a.costUsd.toFixed(4)} (CLI 보고값 — 구독 로그인이면 API 환산 추정, 청구 아님)`}</dd>
        <dt>git 커밋</dt>
        <dd>{a.commitSha ? <span className="mono">{a.commitSha.includes('@') ? a.commitSha : a.commitSha.slice(0, 10)}</span> : <span className="muted">{a.commitNote || '-'}</span>}</dd>
        <dt>세션</dt>
        <dd className="mono">
          {a.sessionId ?? '-'}
          {a.resumedFrom ? ` (이어서: ${a.resumedFrom.slice(0, 8)})` : ''}
        </dd>
        <dt>시간</dt>
        <dd>
          {fmtDate(a.startedAt)} → {a.finishedAt ? fmtDate(a.finishedAt) : '진행 중'}
        </dd>
      </dl>
      {a.permissionDenials.length > 0 && (
        <Banner kind="warn">
          차단된 행위 {a.permissionDenials.length}건: {a.permissionDenials.join(' · ')}
        </Banner>
      )}
      {a.outOfScopeChanges.length > 0 && <Banner kind="error">허용 범위 밖 변경: {a.outOfScopeChanges.join(', ')}</Banner>}
      {a.acceptance && (
        <Collapsible
          title={
            <span>
              완료 판정 <Badge tone={a.acceptance.ok ? 'ok' : 'bad'}>{a.acceptance.ok ? '충족' : '미충족'}</Badge>
            </span>
          }
          defaultOpen={!a.acceptance.ok}
        >
          <ul className="small accept-list">
            {a.acceptance.checks.map((c, i) => (
              <li key={i} className={c.ok ? 'ok' : 'bad'}>
                {c.ok ? '✓' : '✗'} {c.name} — {c.detail}
              </li>
            ))}
          </ul>
        </Collapsible>
      )}
      {a.changedFiles.length > 0 && (
        <Collapsible title={`변경 파일 ${a.changedFiles.length}`}>
          <ul className="small mono">
            {a.changedFiles.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </Collapsible>
      )}
      <button className="btn-link" onClick={() => setOpen((o) => !o)}>
        {open ? '상세 로그 닫기' : '상세 로그 보기'}
      </button>
      {open && <AttemptLog attemptId={a.id} live={a.status === 'running'} />}
    </div>
  );
}

function AttemptLog({ attemptId, live }: { attemptId: string; live: boolean }) {
  const ev = useLoad(() => ws().attemptEvents(attemptId), [attemptId]);
  const [extra, setExtra] = useState<AttemptEvent[]>([]);
  useEffect(() => {
    if (!live) return;
    return ws().onLive((e) => {
      if (e.type === 'event' && e.event.attemptId === attemptId) setExtra((x) => [...x, e.event]);
    });
  }, [attemptId, live]);
  if (ev.loading && !ev.data) return <Loading />;
  if (ev.error) return <Banner>{ev.error}</Banner>;
  const seen = new Set((ev.data ?? []).map((e) => e.seq));
  const all = [...(ev.data ?? []), ...extra.filter((e) => !seen.has(e.seq))];
  if (all.length === 0) return <div className="muted small">기록된 이벤트가 없습니다.</div>;
  return (
    <div className="event-log">
      {all.map((e) => (
        <details key={e.seq} className={`ev ev-${e.kind}`}>
          <summary>
            <span className="muted mono">{new Date(e.at).toLocaleTimeString('ko-KR', { hour12: false })}</span> <span className="ev-kind">{e.kind}</span> {e.summary}
          </summary>
          <pre className="log">{e.raw}</pre>
        </details>
      ))}
    </div>
  );
}
