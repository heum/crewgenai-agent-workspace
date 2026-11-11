import { Handle, MarkerType, Position, type Edge, type Node, type NodeProps } from '@xyflow/react';
import type { Agent, EdgeKind, GraphEdge, GraphNode, NodeKind, NodeStatus } from '../../shared/types';
import { NODE_KIND_LABEL, NODE_STATUS_LABEL } from '../../shared/types';

export type FlowNodeData = {
  node: GraphNode;
  agentName?: string;
  status?: NodeStatus;
  visits?: number;
  invalid?: boolean;
};
export type FlowNode = Node<FlowNodeData, 'work'>;

export const KIND_COLOR: Record<NodeKind, string> = {
  input: '#5b6b80',
  agent: '#2563eb',
  check: '#0f766e',
  review: '#7c3aed',
  branch: '#b45309',
  merge: '#0e7490',
  userReview: '#be185d',
  codexReview: '#475569',
};

export const EDGE_STYLE: Record<EdgeKind, { color: string; label: string; dash?: string }> = {
  next: { color: '#64748b', label: '' },
  fail: { color: '#dc2626', label: '실패 시', dash: '6 4' },
  true: { color: '#16a34a', label: '조건 참' },
  false: { color: '#ea580c', label: '조건 거짓', dash: '2 3' },
};

export function WorkNode({ data, selected }: NodeProps<FlowNode>) {
  const { node, agentName, status, visits, invalid } = data;
  const color = KIND_COLOR[node.kind];
  return (
    <div className={`wnode ${selected ? 'selected' : ''} ${status ? `st-${status}` : ''} ${invalid ? 'invalid' : ''}`} style={{ borderTopColor: color }}>
      <Handle type="target" position={Position.Top} />
      <div className="wnode-kind" style={{ color }}>
        {NODE_KIND_LABEL[node.kind]}
      </div>
      <div className="wnode-label">{node.label || '(이름 없음)'}</div>
      {(node.kind === 'agent' || node.kind === 'review') && <div className="wnode-sub">{agentName ?? '담당 미지정'}</div>}
      {node.kind === 'check' && <div className="wnode-sub mono ellipsis">{node.command.join(' ') || '명령 미지정'}</div>}
      {status && (
        <div className={`wnode-status st-${status}`}>
          {NODE_STATUS_LABEL[status]}
          {visits ? ` · ${visits}회` : ''}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export const nodeTypes = { work: WorkNode };

export function toFlowNodes(nodes: GraphNode[], agents: Agent[], extra?: (n: GraphNode) => Partial<FlowNodeData>): FlowNode[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  return nodes.map((n) => {
    const a = n.agentId ? byId.get(n.agentId) : undefined;
    return {
      id: n.id,
      type: 'work',
      position: n.position,
      data: { node: n, agentName: a ? `${a.code} ${a.name}` : n.agentId ? '없는 담당' : undefined, ...(extra?.(n) ?? {}) },
    };
  });
}

export function toFlowEdges(edges: GraphEdge[]): Edge[] {
  return edges.map((e) => edgeView(e));
}

export function edgeView(e: GraphEdge): Edge {
  const st = EDGE_STYLE[e.kind];
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    label: st.label || undefined,
    data: { kind: e.kind },
    animated: false,
    style: { stroke: st.color, strokeWidth: 2, strokeDasharray: st.dash },
    labelStyle: { fill: st.color, fontWeight: 600, fontSize: 11 },
    labelBgStyle: { fill: '#fff' },
    markerEnd: { type: MarkerType.ArrowClosed, color: st.color },
  };
}
