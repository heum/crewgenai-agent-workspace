import { autoLayout, needsLayout } from '../../shared/layout';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addEdge,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
} from '@xyflow/react';
import type { Agent, BranchCondition, EdgeKind, GraphNode, GraphVersion, NodeKind, OutputSpec, Project, ValidationIssue, WorkGraph } from '../../shared/types';
import { NODE_KIND_LABEL } from '../../shared/types';
import { fmtDate, uid, useAction, useLoad, ws } from '../api';
import { Badge, Banner, Empty, Field, LinesInput, Loading, NumberInput } from './common';
import { EDGE_STYLE, edgeView, KIND_COLOR, nodeTypes, toFlowEdges, toFlowNodes, type FlowNode } from './flowShared';

const KINDS: NodeKind[] = ['input', 'agent', 'check', 'review', 'codexReview', 'branch', 'merge', 'userReview'];

function newNode(kind: NodeKind, pos: { x: number; y: number }): GraphNode {
  return {
    id: uid(kind),
    kind,
    label: NODE_KIND_LABEL[kind],
    position: pos,
    agentId: null,
    reviewerAgentId: null,
    instructions: '',
    inputs: [],
    useUpstreamOutputs: true,
    outputs: [],
    doneCriteria: '',
    command: [],
    writeScope: [],
    maxRetries: 1,
    maxVisits: 3,
    timeoutSec: 900,
    condition: kind === 'branch' ? { sourceNodeId: '', field: 'outcome', equals: 'succeeded' } : null,
    entryCondition: 'all',
  };
}

export default function FlowTab({ project }: { project: Project }) {
  const agents = useLoad(() => ws().listAgents(project.id), [project.id]);
  const latest = useLoad(() => ws().latestGraph(project.id), [project.id]);
  const [initial, setInitial] = useState<{ graph: WorkGraph; version: GraphVersion | null } | null>(null);
  const act = useAction();
  const started = useRef(false);

  useEffect(() => {
    if (latest.loading || initial || started.current) return;
    if (latest.data) setInitial({ graph: latest.data.graph, version: latest.data });
    else if (!latest.error) {
      started.current = true;
      void act.run(async () => {
        const g = await ws().defaultGraph(project.id);
        setInitial({ graph: g, version: null });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest.loading, latest.data, latest.error, initial, project.id]);

  if (latest.error) return <Banner>{latest.error}</Banner>;
  if (act.error && !initial) return <Banner>{act.error}</Banner>;
  if (!initial || !agents.data) return <Loading />;
  return (
    <ReactFlowProvider>
      <FlowEditor
        project={project}
        agents={agents.data}
        initial={initial.graph}
        savedVersion={initial.version}
        onSaved={(v) => setInitial({ graph: v.graph, version: v })}
        onReplace={(g) => setInitial({ graph: g, version: initial.version })}
      />
    </ReactFlowProvider>
  );
}

function FlowEditor({
  project,
  agents,
  initial,
  savedVersion,
  onSaved,
  onReplace,
}: {
  project: Project;
  agents: Agent[];
  initial: WorkGraph;
  savedVersion: GraphVersion | null;
  onSaved: (v: GraphVersion) => void;
  onReplace: (g: WorkGraph) => void;
}) {
  // 카드가 겹쳐 저장된 흐름(위치 정보가 없거나 같은 위치)은 열 때 자동으로 정렬해 보여 준다. 저장하면 정렬된 위치가 남는다.
  const laid = (g: WorkGraph) => (needsLayout(g) ? autoLayout(g) : g);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(toFlowNodes(laid(initial).nodes, agents));
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(toFlowEdges(initial.edges));
  const [selNode, setSelNode] = useState<string | null>(null);
  const [selEdge, setSelEdge] = useState<string | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[] | null>(null);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const act = useAction();
  const rf = useReactFlow();

  // 초기 그래프가 바뀌면(기본 흐름 불러오기·저장) 다시 적재
  useEffect(() => {
    setNodes(toFlowNodes(laid(initial).nodes, agents));
    setEdges(toFlowEdges(initial.edges));
    setTimeout(() => rf.fitView({ padding: 0.08, maxZoom: 1.1 }), 50);
    setSelNode(null);
    setSelEdge(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  const graph: WorkGraph = useMemo(
    () => ({
      nodes: nodes.map((n) => ({ ...n.data.node, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } })),
      edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, kind: ((e.data as { kind?: EdgeKind })?.kind ?? 'next') as EdgeKind })),
    }),
    [nodes, edges],
  );
  const dirty = useMemo(() => JSON.stringify(graph) !== JSON.stringify(savedVersion?.graph ?? null), [graph, savedVersion]);
  const invalidIds = useMemo(() => new Set((issues ?? []).filter((i) => i.level === 'error' && i.nodeId).map((i) => i.nodeId!)), [issues]);

  useEffect(() => {
    setNodes((ns) => ns.map((n) => (n.data.invalid === invalidIds.has(n.id) ? n : { ...n, data: { ...n.data, invalid: invalidIds.has(n.id) } })));
  }, [invalidIds, setNodes]);

  const onConnect = useCallback(
    (c: Connection) => {
      const kind: EdgeKind = 'next';
      setEdges((es) => addEdge(edgeView({ id: uid('e'), source: c.source!, target: c.target!, kind }), es));
      setMsg(null);
    },
    [setEdges],
  );

  const agentLabel = (id: string | null) => {
    if (!id) return undefined;
    const a = agents.find((x) => x.id === id);
    return a ? `${a.code} ${a.name}` : '없는 담당';
  };

  const updateNode = (id: string, patch: Partial<GraphNode>) => {
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id !== id) return n;
        const node = { ...n.data.node, ...patch };
        return { ...n, data: { ...n.data, node, agentName: agentLabel(node.agentId) } };
      }),
    );
  };

  const addNode = (kind: NodeKind) => {
    const vp = rf.getViewport();
    const pos = { x: Math.round((-vp.x + 300) / vp.zoom), y: Math.round((-vp.y + 160) / vp.zoom) };
    const n = newNode(kind, pos);
    setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), { ...toFlowNodes([n], agents)[0], selected: true }]);
    setSelNode(n.id);
    setSelEdge(null);
  };

  const deleteSelected = () => {
    if (selNode) {
      setNodes((ns) => ns.filter((n) => n.id !== selNode));
      setEdges((es) => es.filter((e) => e.source !== selNode && e.target !== selNode));
      setSelNode(null);
    } else if (selEdge) {
      setEdges((es) => es.filter((e) => e.id !== selEdge));
      setSelEdge(null);
    }
  };

  const focusNode = (id: string) => {
    const n = nodes.find((x) => x.id === id);
    if (!n) return;
    setNodes((ns) => ns.map((x) => ({ ...x, selected: x.id === id })));
    setSelNode(id);
    setSelEdge(null);
    void rf.setCenter(n.position.x + 90, n.position.y + 40, { zoom: 1.1, duration: 300 });
  };

  const validate = () =>
    act.run(async () => {
      const r = await ws().validateGraph(project.id, graph);
      setIssues(r);
      setMsg(r.length === 0 ? '검사 통과: 문제가 없습니다.' : null);
    });

  const save = () =>
    act.run(async () => {
      const r = await ws().saveGraph(project.id, graph, note);
      setIssues(r.issues);
      if (r.version) {
        setMsg(`흐름 v${r.version.version}로 저장했습니다. 진행 중인 실행은 시작 당시 버전을 유지합니다.`);
        setNote('');
        onSaved(r.version);
      } else {
        setMsg(null);
      }
    });

  const selectedNode = nodes.find((n) => n.id === selNode)?.data.node ?? null;
  const selectedEdge = edges.find((e) => e.id === selEdge) ?? null;
  const errors = (issues ?? []).filter((i) => i.level === 'error');

  return (
    <div className="flow-layout">
      <div className="flow-toolbar">
        <div className="palette">
          {KINDS.map((k) => (
            <button key={k} className="palette-btn" style={{ borderLeftColor: KIND_COLOR[k] }} onClick={() => addNode(k)} title={`${NODE_KIND_LABEL[k]} 노드 추가`}>
              + {NODE_KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <div className="row gap wrap">
          <Badge tone={savedVersion ? 'info' : 'warn'}>{savedVersion ? `저장된 흐름 v${savedVersion.version} · ${fmtDate(savedVersion.createdAt)}` : '아직 저장 안 됨'}</Badge>
          {dirty && <Badge tone="warn">저장 안 된 변경</Badge>}
          <button className="btn" disabled={!selNode && !selEdge} onClick={deleteSelected}>
            선택 삭제
          </button>
          <button
            className="btn"
            disabled={act.busy}
            onClick={() =>
              act.run(async () => {
                if (dirty && !confirm('현재 편집 내용을 기본 흐름으로 바꿉니다. 저장된 버전은 유지됩니다. 계속할까요?')) return;
                onReplace(await ws().defaultGraph(project.id));
                setIssues(null);
              })
            }
          >
            기본 흐름 불러오기
          </button>
          <button
            className="btn"
            disabled={act.busy || nodes.length === 0}
            title="겹치거나 흩어진 카드를 실행 순서대로 위→아래로 다시 배치합니다"
            onClick={() => {
              const g = autoLayout(graph);
              const pos = new Map(g.nodes.map((n) => [n.id, n.position]));
              setNodes((ns) => ns.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })));
              setTimeout(() => rf.fitView({ padding: 0.08, maxZoom: 1.1 }), 50);
            }}
          >
            자동 정렬
          </button>
          <button className="btn" disabled={act.busy} onClick={validate}>
            검사
          </button>
          <input className="input note-input" value={note} placeholder="저장 메모(선택)" onChange={(e) => setNote(e.target.value)} />
          <button className="btn btn-primary" disabled={act.busy || graph.nodes.length === 0} onClick={save}>
            {act.busy ? '처리 중…' : '저장'}
          </button>
        </div>
      </div>
      {act.error && <Banner>{act.error}</Banner>}
      {msg && <Banner kind="ok">{msg}</Banner>}
      {issues && issues.length > 0 && (
        <div className={`issues ${errors.length ? 'has-error' : ''}`}>
          <strong>{errors.length ? `오류 ${errors.length}건 — 저장·실행할 수 없습니다` : '경고만 있습니다'}</strong>
          <ul>
            {issues.map((i, k) => (
              <li key={k} className={i.level}>
                <Badge tone={i.level === 'error' ? 'bad' : 'warn'}>{i.level === 'error' ? '오류' : '경고'}</Badge> {i.message}
                {i.nodeId && (
                  <button className="btn-link" onClick={() => focusNode(i.nodeId!)}>
                    노드 보기
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flow-main">
        <div className="flow-canvas">
          {nodes.length === 0 && (
            <div className="canvas-empty">
              <Empty title="노드가 없습니다">위의 버튼으로 노드를 추가하거나 “기본 흐름 불러오기”를 누르세요.</Empty>
            </div>
          )}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => {
              setSelNode(n.id);
              setSelEdge(null);
            }}
            onEdgeClick={(_, e) => {
              setSelEdge(e.id);
              setSelNode(null);
            }}
            onPaneClick={() => {
              setSelNode(null);
              setSelEdge(null);
            }}
            onNodesDelete={(ds) => ds.some((d) => d.id === selNode) && setSelNode(null)}
            onEdgesDelete={(ds) => ds.some((d) => d.id === selEdge) && setSelEdge(null)}
            deleteKeyCode={['Backspace', 'Delete']}
            fitView
            fitViewOptions={{ padding: 0.08, maxZoom: 1.1 }}
            minZoom={0.2}
          >
            <Background gap={20} />
            <MiniMap pannable zoomable />
            <Controls />
          </ReactFlow>
        </div>
        <aside className="flow-side">
          {selectedNode ? (
            <NodeEditor key={selectedNode.id} node={selectedNode} agents={agents} allNodes={graph.nodes} onChange={(p) => updateNode(selectedNode.id, p)} />
          ) : selectedEdge ? (
            <EdgeEditor
              edge={selectedEdge}
              nodes={graph.nodes}
              onKind={(k) =>
                setEdges((es) => es.map((e) => (e.id === selectedEdge.id ? { ...edgeView({ id: e.id, source: e.source, target: e.target, kind: k }), selected: e.selected } : e)))
              }
            />
          ) : (
            <div className="muted small">
              <h3>편집 방법</h3>
              <ul>
                <li>위 버튼으로 노드 추가, 끌어서 이동</li>
                <li>노드 아래쪽 점에서 다른 노드 위쪽 점으로 끌어 연결</li>
                <li>카드가 겹치면 “자동 정렬”</li>
                <li>연결선을 선택해 종류(다음·실패 시·조건 참/거짓) 지정</li>
                <li>Delete/Backspace 또는 “선택 삭제”로 삭제</li>
                <li>연결선이 실제 실행 순서를 정합니다. 여러 선행 단계는 모두 완료된 뒤 합류합니다.</li>
              </ul>
              <h3>연결선 종류</h3>
              <ul className="legend">
                {(Object.keys(EDGE_STYLE) as EdgeKind[]).map((k) => (
                  <li key={k}>
                    <span className="legend-line" style={{ borderTopColor: EDGE_STYLE[k].color, borderTopStyle: EDGE_STYLE[k].dash ? 'dashed' : 'solid' }} /> {EDGE_LABEL[k]}
                  </li>
                ))}
              </ul>
              <p>프로젝트 쓰기 허용 경로: {project.plan.writablePaths.length ? project.plan.writablePaths.join(', ') : '없음'}</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

const EDGE_LABEL: Record<EdgeKind, string> = { next: '다음(성공 시)', fail: '실패 시 이동(재작업)', true: '조건 참', false: '조건 거짓' };

function EdgeEditor({ edge, nodes, onKind }: { edge: Edge; nodes: GraphNode[]; onKind: (k: EdgeKind) => void }) {
  const kind = ((edge.data as { kind?: EdgeKind })?.kind ?? 'next') as EdgeKind;
  const name = (id: string) => nodes.find((n) => n.id === id)?.label ?? id;
  return (
    <div className="form">
      <h3>연결선</h3>
      <p className="small">
        {name(edge.source)} → {name(edge.target)}
      </p>
      <Field label="종류">
        <select className="input" value={kind} onChange={(e) => onKind(e.target.value as EdgeKind)}>
          {(Object.keys(EDGE_LABEL) as EdgeKind[]).map((k) => (
            <option key={k} value={k}>
              {EDGE_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>
      <p className="muted small">조건 참/거짓은 조건 분기 노드에서 나가는 선에만 사용합니다. “실패 시”는 검사·검토 실패 때 재작업할 단계로 돌아가는 선입니다.</p>
    </div>
  );
}

function NodeEditor({ node, agents, allNodes, onChange }: { node: GraphNode; agents: Agent[]; allNodes: GraphNode[]; onChange: (p: Partial<GraphNode>) => void }) {
  const active = agents.filter((a) => a.active);
  const usesAgent = node.kind === 'agent' || node.kind === 'review';
  const cond: BranchCondition = node.condition ?? { sourceNodeId: '', field: 'outcome', equals: 'succeeded' };
  const setOut = (i: number, p: Partial<OutputSpec>) => onChange({ outputs: node.outputs.map((o, j) => (j === i ? { ...o, ...p } : o)) });
  return (
    <div className="form">
      <div className="row between">
        <h3 style={{ color: KIND_COLOR[node.kind] }}>{NODE_KIND_LABEL[node.kind]}</h3>
        <span className="muted small mono">{node.id}</span>
      </div>
      <Field label="이름">
        <input className="input" value={node.label} onChange={(e) => onChange({ label: e.target.value })} />
      </Field>
      {usesAgent && (
        <Field label={node.kind === 'review' ? '검토 담당(읽기 전용)' : '담당 Agent'}>
          <select className="input" value={node.agentId ?? ''} onChange={(e) => onChange({ agentId: e.target.value || null })}>
            <option value="">선택</option>
            {node.agentId && !active.some((a) => a.id === node.agentId) && <option value={node.agentId}>(해고했거나 휴가 중인 담당)</option>}
            {active.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} {a.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {node.kind === 'agent' && (
        <Field label="독립 검토자(선택)" hint="지정하면 작업 후 다른 담당이 읽기 전용으로 확인합니다.">
          <select className="input" value={node.reviewerAgentId ?? ''} onChange={(e) => onChange({ reviewerAgentId: e.target.value || null })}>
            <option value="">없음</option>
            {active
              .filter((a) => a.id !== node.agentId)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
          </select>
        </Field>
      )}
      {node.kind === 'codexReview' && (
        <Banner kind="info">
          Codex CLI를 읽기 전용으로 실행해 검토 대상(아래 입력 자료와 앞 단계 산출물)을 리뷰합니다. 모델·추론 강도는 설정에서 정합니다. 결과는 다음 단계(Claude 재검토)의 입력이 됩니다.
        </Banner>
      )}
      {node.kind !== 'branch' && (
        <Field label={node.kind === 'codexReview' ? '리뷰 지시(선택)' : '작업 지시'}>
          <textarea className="input" rows={4} value={node.instructions} onChange={(e) => onChange({ instructions: e.target.value })} />
        </Field>
      )}
      <Field label={node.kind === 'codexReview' ? '검토 대상(프로젝트 기준 상대 경로, 한 줄에 하나)' : '입력 자료(프로젝트 기준 상대 경로, 한 줄에 하나)'}>
        <LinesInput value={node.inputs} onChange={(v) => onChange({ inputs: v })} rows={2} />
      </Field>
      <label className="check">
        <input type="checkbox" checked={node.useUpstreamOutputs} onChange={(e) => onChange({ useUpstreamOutputs: e.target.checked })} /> 앞 단계 산출물을 입력으로 사용
      </label>
      {node.kind === 'check' && (
        <Field label="검사 명령(인자를 한 줄에 하나씩)" hint="셸을 거치지 않고 인자 배열로 실행합니다. 예: npm / test. 파이프·리다이렉션은 지원하지 않습니다.">
          <LinesInput value={node.command} onChange={(v) => onChange({ command: v })} rows={3} placeholder={'npm\ntest'} />
        </Field>
      )}
      {node.kind === 'branch' && (
        <div className="subform">
          <strong className="small">분기 조건</strong>
          <Field label="기준 단계">
            <select className="input" value={cond.sourceNodeId} onChange={(e) => onChange({ condition: { ...cond, sourceNodeId: e.target.value } })}>
              <option value="">선택</option>
              {allNodes
                .filter((n) => n.id !== node.id)
                .map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.label}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="비교 대상">
            <select className="input" value={cond.field} onChange={(e) => onChange({ condition: { ...cond, field: e.target.value as 'outcome' | 'json' } })}>
              <option value="outcome">단계 결과(succeeded/failed)</option>
              <option value="json">JSON 산출물 필드</option>
            </select>
          </Field>
          {cond.field === 'json' && (
            <Field label="JSON 경로" hint="예: result.status">
              <input className="input mono" value={cond.jsonPath ?? ''} onChange={(e) => onChange({ condition: { ...cond, jsonPath: e.target.value } })} />
            </Field>
          )}
          <Field label="같으면 ‘조건 참’ 선으로 이동">
            <input className="input mono" value={cond.equals} onChange={(e) => onChange({ condition: { ...cond, equals: e.target.value } })} />
          </Field>
        </div>
      )}
      {node.kind !== 'branch' && (
        <div className="subform">
          <div className="row between">
            <strong className="small">출력 형식·산출물 위치</strong>
            <button className="btn-link" onClick={() => onChange({ outputs: [...node.outputs, { path: '', format: 'markdown', required: true }] })}>
              + 추가
            </button>
          </div>
          {node.outputs.length === 0 && <div className="muted small">없음</div>}
          {node.outputs.map((o, i) => (
            <div key={i} className="output-row">
              <input className="input mono grow" value={o.path} placeholder="crewgenai-output/report.md" onChange={(e) => setOut(i, { path: e.target.value })} />
              <select className="input" value={o.format} onChange={(e) => setOut(i, { format: e.target.value as OutputSpec['format'] })}>
                {['markdown', 'json', 'html', 'text', 'code', 'image', 'any'].map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
              <label className="check small">
                <input type="checkbox" checked={o.required} onChange={(e) => setOut(i, { required: e.target.checked })} />
                필수
              </label>
              <button className="btn-link danger" onClick={() => onChange({ outputs: node.outputs.filter((_, j) => j !== i) })}>
                제거
              </button>
            </div>
          ))}
        </div>
      )}
      <Field label={node.kind === 'codexReview' ? '리뷰 기준' : '완료 조건'}>
        <textarea className="input" rows={2} value={node.doneCriteria} onChange={(e) => onChange({ doneCriteria: e.target.value })} />
      </Field>
      {node.kind === 'agent' && (
        <Field label="수정 범위(상대 경로, 한 줄에 하나)" hint="비우면 담당의 작업 폴더를 사용합니다. 병렬 단계끼리 겹치면 검사에서 막습니다.">
          <LinesInput value={node.writeScope} onChange={(v) => onChange({ writeScope: v })} rows={2} />
        </Field>
      )}
      <div className="form-grid three">
        <Field label="재시도">
          <NumberInput value={node.maxRetries} min={0} onChange={(v) => onChange({ maxRetries: v ?? 0 })} />
        </Field>
        <Field label="재작업 상한">
          <NumberInput value={node.maxVisits} min={1} onChange={(v) => onChange({ maxVisits: v ?? 1 })} />
        </Field>
        <Field label="시간 제한(초)">
          <NumberInput value={node.timeoutSec} min={10} onChange={(v) => onChange({ timeoutSec: v ?? 900 })} />
        </Field>
      </div>
      <Field label="다음 단계 진입 조건(선행 단계가 여럿일 때)">
        <select className="input" value={node.entryCondition} onChange={(e) => onChange({ entryCondition: e.target.value as 'all' | 'any' })}>
          <option value="all">모든 선행 단계 완료 후(합류)</option>
          <option value="any">하나라도 완료되면</option>
        </select>
      </Field>
      <p className="muted small">실패 시 이동할 단계는 “실패 시” 연결선으로 지정합니다.</p>
    </div>
  );
}
