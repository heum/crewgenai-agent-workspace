import { useEffect, useState } from 'react';
import type { Agent, AgentFields, AgentTemplateSetId, LiveEvent, Project, ToolName, WorkingItem } from '../../shared/types';
import { fmtDate, useAction, useLoad, ws } from '../api';
import { Badge, Banner, Empty, Field, LinesInput, Loading, Modal, NumberInput, PathList } from './common';

const TOOLS: { id: ToolName; label: string; hint: string }[] = [
  { id: 'Read', label: 'Read', hint: '파일 읽기' },
  { id: 'Grep', label: 'Grep', hint: '내용 검색' },
  { id: 'Glob', label: 'Glob', hint: '파일 찾기' },
  { id: 'Edit', label: 'Edit', hint: '파일 수정(작업 폴더 안)' },
  { id: 'Write', label: 'Write', hint: '파일 생성(작업 폴더 안)' },
  { id: 'Bash', label: 'Bash', hint: '허용 명령만 실행' },
  { id: 'WebFetch', label: 'WebFetch', hint: '웹 읽기' },
];

const BLANK: AgentFields = {
  code: '',
  name: '',
  role: '',
  instructions: '',
  references: [],
  workPaths: [],
  tools: ['Read', 'Grep', 'Glob'],
  allowedCommands: [],
  expectedOutput: '',
  doneCriteria: '',
  reviewerAgentId: null,
  model: '',
  maxBudgetUsd: null,
  timeoutSec: 900,
  maxRetries: 1,
  active: true,
};

function toFields(a: Agent): AgentFields {
  const { id: _id, projectId: _p, version: _v, updatedAt: _u, ...rest } = a;
  return { ...BLANK, ...rest };
}

export default function AgentsTab({ project }: { project: Project }) {
  const agents = useLoad(() => ws().listAgents(project.id), [project.id]);
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const [showInactive, setShowInactive] = useState(true);
  const [pickSet, setPickSet] = useState(false);
  const act = useAction();
  const list = agents.data ?? [];
  const activeCount = list.filter((a) => a.active).length;
  // 지금 일하는 직원(실행 이벤트가 오면 다시 읽는다)
  const [working, setWorking] = useState<WorkingItem[]>([]);
  useEffect(() => {
    let alive = true; let t: ReturnType<typeof setTimeout> | null = null;
    const load = () => { ws().workingNow(project.id).then((w) => { if (alive) setWorking(w); }).catch(() => {}); };
    load();
    const off = ws().onLive((e: LiveEvent) => { if (['attempt', 'run', 'mission', 'node'].includes(e.type)) { if (t) clearTimeout(t); t = setTimeout(load, 300); } });
    const iv = setInterval(load, 10000);
    return () => { alive = false; off(); clearInterval(iv); if (t) clearTimeout(t); };
  }, [project.id]);
  const busy = (id: string) => working.filter((w) => w.agentId === id);

  useEffect(() => {
    if (selected === null && list.length) setSelected(list[0].id);
  }, [list, selected]);

  const current = selected && selected !== 'new' ? list.find((a) => a.id === selected) ?? null : null;
  const visible = showInactive ? list : list.filter((a) => a.active);

  return (
    <div className="split">
      <section className="panel list-panel">
        <div className="row gap wrap">
          <Badge tone="info">등록 {list.length}명</Badge>
          <Badge tone="ok">근무 {activeCount}명</Badge>
          <Badge tone={working.length ? 'info' : 'neutral'}>작업 중 {new Set(working.filter((w) => w.agentId).map((w) => w.agentId)).size}명</Badge>
          <span className="muted small">동시 실행 수는 설정에서 따로 정합니다.</span>
        </div>
        {act.error && <Banner>{act.error}</Banner>}
        <div className="row gap wrap">
          <button className="btn btn-primary" onClick={() => setSelected('new')}>
            + 직원 추가
          </button>
          <button className="btn" disabled={act.busy} onClick={() => setPickSet(true)}>
            기본 템플릿 불러오기…
          </button>
          <label className="check small">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> 휴가 중인 직원 표시
          </label>
        </div>
        {agents.loading && !agents.data && <Loading />}
        {agents.error && <Banner>{agents.error}</Banner>}
        {agents.data && list.length === 0 && (
          <Empty title="등록된 직원이 없습니다">“기본 템플릿 불러오기…”에서 개발팀 표준 또는 범용 소규모 팀을 골라 시작하거나 직접 추가하세요.</Empty>
        )}
        <div className="agent-list">
          {visible.map((a) => (
            <button key={a.id} className={`agent-item ${selected === a.id ? 'active' : ''} ${a.active ? '' : 'inactive'}`} onClick={() => setSelected(a.id)}>
              <span className="agent-code">{a.code || '··'}</span>
              <span className="grow">
                <span className="agent-item-head">
                  <strong>{a.name || '(이름 없음)'}</strong>
                  <span className="tool-line" title={a.tools.join(', ')}>
                    {a.tools.includes('Edit') || a.tools.includes('Write') ? '수정 가능' : '읽기 전용'}{a.tools.includes('Bash') ? ' · 명령 실행' : ''}
                  </span>
                </span>
                <small className="ellipsis" title={a.role}>{a.role}</small>
              </span>
              {busy(a.id).length > 0 && (
                <span className="agent-busy" title={busy(a.id).map((w) => w.task).join(', ')}>
                  <span className="dot" />
                  {busy(a.id)[0].kind === 'reviewer' ? '검토 중' : busy(a.id)[0].kind === 'operator' ? '판단 중' : '작업 중'}
                </span>
              )}
              {!a.active && <Badge tone="warn">휴가</Badge>}
            </button>
          ))}
        </div>
      </section>
      <section className="panel grow">
        {selected === 'new' ? (
          <AgentForm
            key="new"
            project={project}
            agents={list}
            agent={null}
            onSaved={async (a) => {
              await agents.reload();
              setSelected(a.id);
            }}
          />
        ) : current ? (
          <AgentForm
            key={`${current.id}-${current.version}`}
            project={project}
            agents={list}
            agent={current}
            onSaved={async (a) => {
              await agents.reload();
              setSelected(a.id);
            }}
            onFired={async () => {
              setSelected(null);
              await agents.reload();
            }}
          />
        ) : (
          <Empty title="직원을 선택하세요" />
        )}
      </section>
      {pickSet && (
        <TemplateSetPicker
          existing={list}
          onClose={() => setPickSet(false)}
          onPick={(id) =>
            act.run(async () => {
              await ws().loadAgentTemplates(project.id, id);
              setPickSet(false);
              await agents.reload();
            })
          }
        />
      )}
    </div>
  );
}

/** 직원 기본 템플릿 세트 고르기: 세트마다 구성원을 보여 주고, 같은 코드의 기존 직원은 건너뛴다고 알린다. */
function TemplateSetPicker({ existing, onClose, onPick }: { existing: Agent[]; onClose: () => void; onPick: (id: AgentTemplateSetId) => void }) {
  const sets = useLoad(() => ws().agentTemplateSets(), []);
  return (
    <Modal title="기본 템플릿 불러오기" onClose={onClose} wide>
      <p className="muted small">팀 구성을 하나 고르세요. 불러온 직원은 이름·업무지시·도구를 고치거나, 휴가 보내거나, 해고할 수 있습니다.</p>
      {sets.loading && <Loading />}
      {sets.error && <Banner>{sets.error}</Banner>}
      <div className="template-set-list">
        {sets.data?.map((t) => {
          const skip = t.agents.filter((a) => existing.some((e) => e.code === a.code));
          return (
            <div key={t.id} className="template-set">
              <div className="row between wrap gap">
                <div>
                  <strong>{t.label}</strong> <span className="muted small">{t.agents.length}명</span>
                </div>
                <button className="btn btn-primary" onClick={() => onPick(t.id)}>
                  이 구성으로 불러오기
                </button>
              </div>
              <ul className="template-set-members small">
                {t.agents.map((a) => (
                  <li key={a.code} className={skip.some((x) => x.code === a.code) ? 'muted' : ''}>
                    <span className="mono">{a.code}</span> <strong>{a.name}</strong> — {a.role}
                    {skip.some((x) => x.code === a.code) ? ' (같은 코드의 직원이 있어 건너뜀)' : ''}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

function AgentForm({ project, agents, agent, onSaved, onFired }: { project: Project; agents: Agent[]; agent: Agent | null; onSaved: (a: Agent) => void; onFired?: () => void }) {
  const [f, setF] = useState<AgentFields>(agent ? toFields(agent) : { ...BLANK });
  const act = useAction();
  const [msg, setMsg] = useState<string | null>(null);
  const set = <K extends keyof AgentFields>(k: K, v: AgentFields[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    setMsg(null);
  };
  const toggleTool = (t: ToolName) => set('tools', f.tools.includes(t) ? f.tools.filter((x) => x !== t) : [...f.tools, t]);
  const readOnlyWarn = f.tools.some((t) => t === 'Edit' || t === 'Write') && f.workPaths.length === 0 && project.plan.writablePaths.length === 0;

  return (
    <div className="form">
      <div className="row between">
        <h2>{agent ? `${agent.code} ${agent.name}` : '새 직원'}</h2>
        {agent && (
          <span className="muted small">
            정의 v{agent.version} · {fmtDate(agent.updatedAt)}
          </span>
        )}
      </div>
      {act.error && <Banner>{act.error}</Banner>}
      {msg && <Banner kind="ok">{msg}</Banner>}
      {readOnlyWarn && <Banner kind="warn">수정 도구를 허용했지만 작업 폴더와 기획의 자동 수정 허용 경로가 모두 비어 있어 실제로는 파일을 수정할 수 없습니다.</Banner>}
      <div className="agent-form-cols">
      <div className="agent-form-left">
      <div className="form-grid two">
        <Field label="번호">
          <input className="input" value={f.code} onChange={(e) => set('code', e.target.value)} placeholder="예: 06" />
        </Field>
        <Field label="이름 *">
          <input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
      </div>
      <Field label="역할">
        <input className="input" value={f.role} onChange={(e) => set('role', e.target.value)} />
      </Field>
      <Field label="업무 지시">
        <textarea className="input agent-instructions" rows={5} value={f.instructions} onChange={(e) => set('instructions', e.target.value)} />
      </Field>
      </div>
      <div className="agent-form-right">
      <Field label="참조 자료">
        <PathList items={f.references} onChange={(v) => set('references', v)} onPick={() => ws().pickFiles()} pickLabel="파일 선택…" />
      </Field>
      <Field label="작업 가능한 폴더" hint="비어 있으면 기획의 자동 수정 허용 경로를 사용합니다.">
        <PathList
          items={f.workPaths}
          showFull
          onChange={(v) => set('workPaths', v)}
          onPick={async () => {
            if (!project.plan.folder) throw new Error('기획에서 프로젝트 폴더를 먼저 선택하세요.');
            return ws().pickSubfolder(project.plan.folder);
          }}
          pickLabel="하위 폴더 선택…"
          emptyText="기획 기본값 사용"
        />
      </Field>
      <Field label="사용할 수 있는 도구" hint="실행 시 CLI의 도구 목록·권한 규칙으로 집행합니다(프롬프트 지시만으로 제한하지 않음).">
        <div className="tool-grid">
          {TOOLS.map((t) => (
            <label key={t.id} className="check" title={t.hint}>
              <input type="checkbox" checked={f.tools.includes(t.id)} onChange={() => toggleTool(t.id)} /> {t.label} <span className="muted small">{t.hint}</span>
            </label>
          ))}
        </div>
        {f.tools.includes('Bash') && <div className="muted small win-note">Windows판: Claude의 Bash 격리(샌드박스)를 쓸 수 없어 실행할 때 Bash 도구는 꺼집니다. 아래 허용 명령은 오퍼레이터가 계획한 검사 명령의 허용 목록으로만 쓰입니다.</div>}
      </Field>
      {f.tools.includes('Bash') && (
        <Field label="허용 명령(한 줄에 하나, 명령 접두어)" hint="예: npm test / git diff. 목록 밖 명령은 실행되지 않습니다.">
          <LinesInput value={f.allowedCommands} onChange={(v) => set('allowedCommands', v)} rows={3} />
        </Field>
      )}
      <Field label="기대 산출물">
        <textarea className="input" rows={2} value={f.expectedOutput} onChange={(e) => set('expectedOutput', e.target.value)} />
      </Field>
      <Field label="완료 조건">
        <textarea className="input" rows={2} value={f.doneCriteria} onChange={(e) => set('doneCriteria', e.target.value)} />
      </Field>
      <Field label="독립 검토 담당">
        <select className="input" value={f.reviewerAgentId ?? ''} onChange={(e) => set('reviewerAgentId', e.target.value || null)}>
          <option value="">지정 안 함</option>
          {agents
            .filter((a) => a.id !== agent?.id)
            .map((a) => (
              <option key={a.id} value={a.id} disabled={!a.active}>
                {a.code} {a.name}
                {a.active ? '' : ' (휴가)'}
              </option>
            ))}
        </select>
      </Field>
      <div className="form-grid four">
        <Field label="모델" hint="비우면 CLI 기본">
          <input className="input mono" value={f.model} onChange={(e) => set('model', e.target.value)} placeholder="예: sonnet" />
        </Field>
        <Field label="비용 한도(USD)" hint="비우면 제한 없음">
          <NumberInput value={f.maxBudgetUsd} allowNull step={0.5} onChange={(v) => set('maxBudgetUsd', v)} />
        </Field>
        <Field label="시간 제한(초)">
          <NumberInput value={f.timeoutSec} min={30} onChange={(v) => set('timeoutSec', v ?? 900)} />
        </Field>
        <Field label="재시도 횟수">
          <NumberInput value={f.maxRetries} min={0} onChange={(v) => set('maxRetries', v ?? 0)} />
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> 근무 중(업무 배정 가능) — 끄면 휴가
      </label>
      </div>
      </div>
      <div className="row gap end sticky-bottom">
        {agent && (
          <>
            <button
              className="btn"
              disabled={act.busy}
              onClick={() =>
                act.run(async () => {
                  const a = await ws().duplicateAgent(agent.id);
                  onSaved(a);
                })
              }
            >
              복제
            </button>
            <button
              className="btn"
              disabled={act.busy}
              onClick={() =>
                act.run(async () => {
                  const a = await ws().setAgentActive(agent.id, !agent.active);
                  onSaved(a);
                })
              }
            >
              {agent.active ? '휴가 보내기' : '휴가에서 복귀'}
            </button>
            <button
              className="btn btn-danger"
              disabled={act.busy}
              title="팀에서 내보냅니다. 지난 실행 기록은 남습니다."
              onClick={() =>
                act.run(async () => {
                  if (!confirm(`${agent.code} ${agent.name}을(를) 해고할까요?\n\n- 직원 목록과 업무 배정에서 빠집니다. 되돌릴 수 없습니다.\n- 지난 실행·검토 기록은 그대로 남습니다.\n- 이 직원을 검토 담당으로 둔 직원은 검토 담당이 비워집니다.\n- 잠시 쉬게 하려면 해고 대신 휴가 보내기를 쓰세요.`)) return;
                  const r = await ws().fireAgent(agent.id);
                  if (r.cleared.length) alert(`검토 담당이 비워진 직원: ${r.cleared.join(', ')}\n직원 탭에서 새 검토 담당을 정하세요.`);
                  onFired?.();
                })
              }
            >
              해고(삭제)
            </button>
          </>
        )}
        <button
          className="btn btn-primary"
          disabled={act.busy || !f.name.trim()}
          onClick={() =>
            act.run(async () => {
              const a = await ws().saveAgent(project.id, agent?.id ?? null, f);
              setMsg(`저장했습니다(정의 v${a.version}). 진행 중인 실행은 시작 당시 정의를 사용합니다.`);
              onSaved(a);
            })
          }
        >
          {act.busy ? '저장 중…' : '저장'}
        </button>
      </div>
    </div>
  );
}
