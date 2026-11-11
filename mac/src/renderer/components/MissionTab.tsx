// 운영 — 오퍼레이터 루프(미션) 화면
// 사용자 지시 → 오퍼레이터 계획 → 담당 Agent 수행 → Codex 리뷰 → Claude 재검토 → 오퍼레이터 판단 → (반복 | 사용자 확인 | 완료)
import type { ReactNode } from 'react';
import { autoLayout, needsLayout } from '../../shared/layout';
import { Background, Controls, ReactFlow } from '@xyflow/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, LiveEvent, Mission, MissionDetail, MissionEvent, MissionFile, MissionReadiness, WorkingItem, MissionSnapshot, MissionStage, MissionStatus, Project, PromptTemplate, RunDetail } from '../../shared/types';
import { MISSION_STAGE_LABEL, MISSION_STATUS_LABEL, NODE_KIND_LABEL, NODE_STATUS_LABEL, RUN_STATUS_LABEL, billingLabel } from '../../shared/types';
import { fmtDate, isComposingEnter, useAction, useLoad, ws } from '../api';
import { Badge, Banner, Collapsible, Empty, Loading, Modal } from './common';
import { Markdown } from '../markdown';
import { nodeTypes, toFlowEdges, toFlowNodes } from './flowShared';
import { runTone } from './RunTab';

const ACTIVE: MissionStatus[] = ['planning', 'running', 'evaluating'];

function missionTone(s: MissionStatus): 'ok' | 'bad' | 'warn' | 'info' | 'neutral' {
  if (s === 'done') return 'ok';
  if (s === 'failed') return 'bad';
  if (s === 'stopped') return 'neutral';
  if (s === 'waiting_user') return 'warn';
  return 'info';
}

/** 프로젝트의 미션 목록 — 실시간 갱신 */
function useMissionList(projectId: string) {
  const list = useLoad(() => ws().listMissions(projectId), [projectId]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadRef = useRef(list.reload);
  reloadRef.current = list.reload;
  useEffect(() => {
    const off = ws().onLive((e: LiveEvent) => {
      if (e.type !== 'mission' || e.mission.projectId !== projectId) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void reloadRef.current(), 300);
    });
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [projectId]);
  return list;
}

/** 미션 상세 — 미션·이벤트·현재 실행의 실시간 이벤트에 맞춰 ~300ms 간격으로 다시 불러온다 */
function useMissionDetail(missionId: string | null) {
  const detail = useLoad(() => (missionId ? ws().missionDetail(missionId) : Promise.resolve(null)), [missionId]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadRef = useRef(detail.reload);
  reloadRef.current = detail.reload;
  const runIdRef = useRef<string | null>(null);
  runIdRef.current = detail.data?.mission.currentRunId ?? null;
  useEffect(() => {
    if (!missionId) return;
    const off = ws().onLive((e: LiveEvent) => {
      const runId = runIdRef.current;
      const hit =
        (e.type === 'mission' && e.mission.id === missionId) ||
        (e.type === 'missionEvent' && e.event.missionId === missionId) ||
        (!!runId &&
          ((e.type === 'run' && e.run.id === runId) || (e.type === 'node' && e.state.runId === runId) || (e.type === 'attempt' && e.attempt.runId === runId)));
      if (!hit) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void reloadRef.current(), 300);
    });
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [missionId]);
  return detail;
}

export default function MissionTab({ project, onOpenRun, onGoTab, draft, onDraftUsed }: { project: Project; onOpenRun: (runId: string) => void; onGoTab?: (tab: 'plan' | 'agents' | 'settings') => void; draft?: string | null; onDraftUsed?: () => void }) {
  const list = useMissionList(project.id);
  const ready = useLoad(() => ws().missionReadiness(project.id), [project.id, project.planVersion]);
  // 미션 상태가 바뀌면(시작·중단·완료) 단일 실행 규칙을 다시 확인한다
  const readyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readyReload = useRef(ready.reload);
  readyReload.current = ready.reload;
  useEffect(() => {
    const off = ws().onLive((e: LiveEvent) => {
      if (e.type !== 'mission') return;
      if (readyTimer.current) clearTimeout(readyTimer.current);
      readyTimer.current = setTimeout(() => void readyReload.current(), 400);
    });
    return () => {
      off();
      if (readyTimer.current) clearTimeout(readyTimer.current);
    };
  }, []);
  const agents = useLoad(() => ws().listAgents(project.id), [project.id]);
  // 선택: 미션 ID 또는 NEW(새 지시). 처음에는 가장 최근 미션을 보여 준다.
  const [sel, setSel] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  // 다른 탭에서 넘어온 지시문
  useEffect(() => { if (draft) { setPrompt(draft); setSel(NEW); onDraftUsed?.(); } }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (sel === null && list.data) setSel(list.data[0]?.id ?? NEW);
  }, [list.data, sel]);
  const mission = sel && sel !== NEW ? list.data?.find((m) => m.id === sel) ?? null : null;

  return (
    <div className="mission-layout">
      <aside className="mission-left">
        <button className={`btn block ${sel === NEW ? 'btn-primary' : ''}`} onClick={() => setSel(NEW)}>+ 새 지시</button>
        <div className="side-label">미션</div>
        {list.loading && !list.data && <Loading />}
        {list.error && <Banner>{list.error}</Banner>}
        {list.data && list.data.length === 0 && <div className="muted small pad">아직 지시한 미션이 없습니다.</div>}
        <div className="mission-list">
          {list.data?.map((m) => (
            <button key={m.id} className={`mission-item ${sel === m.id ? 'active' : ''}`} onClick={() => setSel(m.id)}>
              <div className="row between">
                <Badge tone={missionTone(m.status)}>{MISSION_STATUS_LABEL[m.status]}</Badge>
                <small className="muted">사이클 {m.cycle}</small>
              </div>
              <div className="ellipsis2">{m.prompt}</div>
              <small className="muted">{fmtDate(m.createdAt)}</small>
            </button>
          ))}
        </div>
      </aside>
      <section className="mission-center">
        <div className="mission-main">
          {sel && sel !== NEW ? (
            <MissionView key={sel} missionId={sel} agents={agents.data ?? []} onOpenRun={onOpenRun} onChanged={() => void list.reload()} />
          ) : (
            <NewMissionIntro ready={ready.data} onGoTab={onGoTab} onRecheck={() => void ready.reload()} />
          )}
        </div>
        <Composer
          project={project}
          mission={mission}
          ready={ready.data}
          text={prompt}
          setText={setPrompt}
          onGoTab={onGoTab}
          onShowMission={(id) => setSel(id)}
          onChanged={async (id) => { await list.reload(); await ready.reload(); if (id) setSel(id); }}
        />
      </section>
    </div>
  );
}

const NEW = '__new__';

/** 새 지시 화면: 무엇을 하는 곳인지와 준비 상태 */
function NewMissionIntro({ ready, onGoTab, onRecheck }: { ready: MissionReadiness | null; onGoTab?: (tab: 'plan' | 'agents' | 'settings') => void; onRecheck: () => void }) {
  return (
    <div className="mission-view">
      <div className="card">
        <h3>새 지시</h3>
        <p className="muted">아래 입력창에 무엇을 만들거나 고칠지 적어 주세요. 오퍼레이터가 기획의 완성 문서를 근거로 읽고 계획을 세워 담당 직원에게 배정합니다. 결과는 Codex 리뷰와 Claude 재검토를 거칩니다.</p>
        <p className="muted small">근거 문서가 빈약하거나 애매하면 오퍼레이터가 채울 부분을 알려 주고 멈춥니다. 문서는 <strong>기획</strong> 탭의 ‘완성 문서 목록…’에서 올립니다.</p>
      </div>
      {ready && <ReadinessBox ready={ready} onGoTab={onGoTab} onRecheck={onRecheck} />}
    </div>
  );
}

function ReadinessBox({ ready, onGoTab, onRecheck }: { ready: MissionReadiness; onGoTab?: (tab: 'plan' | 'agents' | 'settings') => void; onRecheck: () => void }) {
  return (
    <div className={`readiness ${ready.ready ? 'ok' : 'bad'}`}>
      <div className="row between">
        <strong>{ready.ready ? '지시할 준비가 됐습니다' : '지시하려면 먼저 설정하세요'}</strong>
        <button className="btn-link" onClick={onRecheck}>다시 확인</button>
      </div>
      <ul>
        {ready.items.filter((i) => (!ready.ready ? true : !i.ok)).map((i) => (
          <li key={i.key} className={i.ok ? 'ok' : 'bad'}>
            <span className="mark">{i.ok ? '✓' : '✕'}</span>
            <span className="lbl">{i.label}</span>
            {!i.ok && <span className="muted small det">{i.detail}</span>}
            {!i.ok && i.tab && onGoTab && <button className="btn-link" onClick={() => onGoTab(i.tab!)}>{i.tab === 'plan' ? '기획에서 설정' : i.tab === 'agents' ? '직원에서 설정' : '설정 열기'}</button>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 아래 고정 입력창 — 선택한 미션 상태에 맞춰 바뀐다.
 * 새 지시 / 진행 중: 추가 지시(다음 사이클·지금 반영)·중단 / 확인 대기: 답변 / 완료 보고: 추가 지시·종료 / 중단됨: 이어서 다시 시작
 */
function Composer({ project, mission, ready, text, setText, onGoTab, onShowMission, onChanged }: {
  project: Project; mission: Mission | null; ready: MissionReadiness | null; text: string; setText: (v: string) => void;
  onGoTab?: (tab: 'plan' | 'agents' | 'settings') => void; onShowMission: (id: string) => void; onChanged: (selectId?: string) => Promise<void>;
}) {
  const act = useAction();
  const [note, setNote] = useState<string | null>(null);
  const st = mission?.status ?? null;
  const live = !!st && ACTIVE.includes(st);
  const gaps = st === 'waiting_user' && !!mission?.gaps?.length;
  const mode: 'new' | 'live' | 'answer' | 'done' | 'stopped' = !mission || st === 'failed' ? 'new' : live ? 'live' : st === 'waiting_user' ? 'answer' : st === 'done' ? 'done' : 'stopped';
  const active = ready?.activeMission ?? null;
  const blockedNew = mode === 'new' && !!active;
  const notReady = mode === 'new' && !!ready && !ready.ready;
  const run = (f: () => Promise<void>) => act.run(async () => { setNote(null); await f(); });

  const startNew = () => run(async () => {
    const t = text.trim();
    if (!t) throw new Error('지시 내용을 입력하세요.');
    const r = await ws().missionReadiness(project.id, true);
    if (!r.ready) throw new Error(`지시하려면 먼저 설정하세요: ${r.items.filter((i) => !i.ok).map((i) => i.label).join(', ')}`);
    const m = await ws().startMission(project.id, t);
    setText('');
    await onChanged(m.id);
  });
  const directive = (how: 'next' | 'now') => run(async () => {
    const t = text.trim();
    if (!t) throw new Error('추가 지시 내용을 입력하세요.');
    if (how === 'now' && !confirm('진행 중인 Claude·Codex 작업을 멈추고, 이 지시를 반영해 다시 계획할까요?')) return;
    await ws().addDirective(mission!.id, t, how);
    setText('');
    setNote(how === 'now' ? '지금 반영: 진행 중인 작업을 멈추고 다시 계획합니다.' : '다음 사이클 계획에 반영합니다.');
    await onChanged();
  });
  const stop = () => run(async () => {
    if (!confirm('이 미션을 중단할까요? 진행 중인 작업 프로세스를 종료하고 현재 상태를 보존합니다.')) return;
    await ws().stopMission(mission!.id);
    await onChanged();
  });
  const answer = (action: 'continue' | 'stop') => run(async () => {
    const t = text.trim();
    if (action === 'continue' && mode === 'answer' && !t && !gaps) throw new Error('답변을 입력하세요.');
    if (action === 'continue' && mode === 'done' && !t) throw new Error('추가 지시를 입력하세요.');
    await ws().answerMission(mission!.id, t, action);
    setText('');
    await onChanged();
  });

  const primary = mode === 'new' ? startNew : mode === 'live' ? () => directive('next') : mode === 'stopped' ? () => answer('continue') : () => answer('continue');
  const label = mode === 'new' ? '새 지시' : mode === 'live' ? '진행 중 추가 지시' : mode === 'answer' ? (gaps ? '근거 문서 보완 후 다시 확인' : '오퍼레이터 질문에 답변') : mode === 'done' ? '완료 보고 — 추가 지시' : '중단된 미션';
  const placeholder = mode === 'new' ? '무엇을 만들거나 고칠지 적어 주세요. 예: 공고 목록 화면에 마감일 정렬을 추가하고, 정렬 기준을 문서로 남겨 줘'
    : mode === 'live' ? '추가 지시 — 예: 표 대신 목록으로 정리하고, 근거 줄 번호를 꼭 달아 줘'
    : mode === 'answer' ? (gaps ? '보완한 내용을 적거나(선택), 문서를 올린 뒤 비워 두고 다시 확인을 누르세요' : '답변을 입력하세요')
    : mode === 'done' ? '추가로 진행할 내용(없으면 “여기서 종료”)' : '다시 시작하면서 반영할 지시(선택)';
  const disabled = act.busy || (mode === 'new' && (blockedNew || notReady || !ready || !text.trim()));

  return (
    <div className={`composer mode-${mode}`}>
      {mode === 'new' && active && (
        <div className="single-note">
          {active.sameProject
            ? <><span>이 프로젝트에 열려 있는 미션이 있습니다 — 그 미션에 추가 지시하거나 종료한 뒤 새로 지시하세요.</span><button className="btn-link" onClick={() => onShowMission(active.id)}>그 미션 보기</button></>
            : <span>다른 프로젝트({active.projectName})에서 미션이 작동 중입니다. 미션은 한 번에 하나만 작동합니다.</span>}
        </div>
      )}
      {notReady && !active && (
        <div className="single-note">
          <span>지시하려면 먼저 설정하세요: {ready!.items.filter((i) => !i.ok).map((i) => i.label).join(', ')}</span>
          {onGoTab && ready!.items.find((i) => !i.ok && i.tab) && <button className="btn-link" onClick={() => onGoTab(ready!.items.find((i) => !i.ok && i.tab)!.tab!)}>설정하러 가기</button>}
        </div>
      )}
      {act.error && <Banner>{act.error}</Banner>}
      {note && <div className="small ok-line">{note}</div>}
      <div className="composer-box">
        <div className="composer-mode"><span className={`mode-dot ${mode}`} />{label}</div>
        <textarea
          className="composer-input"
          rows={3}
          value={text}
          placeholder={placeholder}
          aria-label={label}
          onChange={(e) => { setText(e.target.value); setNote(null); }}
          onKeyDown={(e) => {
            if (isComposingEnter(e)) return;
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (!disabled) void primary(); }
          }}
        />
        <div className="composer-actions">
          <small className="muted">⌘+Enter로 보내기</small>
          <span className="grow" />
          {mode === 'live' && (
            <>
              <button className="btn danger" disabled={act.busy} onClick={() => void stop()}>중단</button>
              <button className="btn" disabled={act.busy || !text.trim()} onClick={() => void directive('now')} title="진행 중인 작업을 멈추고 이 지시를 반영해 바로 다시 계획">지금 반영</button>
              <button className="btn btn-primary" disabled={act.busy || !text.trim()} onClick={() => void directive('next')} title="지금 작업은 마저 끝내고 다음 사이클 계획에 반영">추가 지시</button>
            </>
          )}
          {(mode === 'answer' || mode === 'done') && (
            <>
              <button className="btn" disabled={act.busy} onClick={() => void answer('stop')}>여기서 종료</button>
              <button className="btn btn-primary" disabled={act.busy} onClick={() => void answer('continue')}>{mode === 'done' ? '추가 지시하고 계속' : gaps ? '보완했으니 다시 확인' : '답변하고 계속'}</button>
            </>
          )}
          {mode === 'stopped' && (
            <button className="btn btn-primary" disabled={act.busy} onClick={() => void answer('continue')}>이어서 다시 시작</button>
          )}
          {mode === 'new' && (
            <button className="btn btn-primary" disabled={disabled} title={notReady ? '필수 항목을 먼저 설정하세요' : blockedNew ? '미션은 한 번에 하나만 작동합니다' : ''} onClick={() => void startNew()}>
              {act.busy ? '보내는 중…' : '지시하기'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MissionView({ missionId, agents, onOpenRun, onChanged }: { missionId: string; agents: Agent[]; onOpenRun: (runId: string) => void; onChanged: () => void }) {
  const detail = useMissionDetail(missionId);
  const act = useAction();
  const d = detail.data;
  if (detail.loading && !d) return <Loading />;
  if (detail.error) return <Banner>{detail.error}</Banner>;
  if (!d) return <Empty title="미션을 찾을 수 없습니다" />;
  const m = d.mission;
  const live = ACTIVE.includes(m.status);
  void onChanged;
  return (
    <div className="mission-view">
      <div className="mission-head">
        <div className="row gap wrap">
          <Badge tone={missionTone(m.status)}>{MISSION_STATUS_LABEL[m.status]}</Badge>
          <Badge tone="info">{MISSION_STAGE_LABEL[m.stage]}</Badge>
          <span className="muted small">
            사이클 {m.cycle} / {m.maxCycles} · 시작 {fmtDate(m.createdAt)} · 갱신 {fmtDate(m.updatedAt)}
          </span>
        </div>
        <div className="row gap">
          {d.currentRun && (
            <button className="btn" onClick={() => onOpenRun(d.currentRun!.run.id)}>
              실행 화면에서 자세히
            </button>
          )}
        </div>
      </div>
      <Fold id="prompt" title="지시" className="mission-prompt" summary={m.prompt}>
        <div>{m.prompt}</div>
        {m.summary && (
          <>
            <small className="muted">오퍼레이터 최근 판단</small>
            <div>{m.summary}</div>
          </>
        )}
      </Fold>
      {act.error && <Banner>{act.error}</Banner>}
      {live && m.limitUntil && (
        <div className="limit-card" role="status">
          <strong>사용 한도 대기 — {fmtDate(m.limitUntil)} 이후 자동으로 이어서 진행합니다</strong>
          <div className="muted small">Claude(또는 Codex) 플랜 사용 한도에 도달했습니다. 실패로 처리하지 않고, 끊긴 작업은 해제 후 같은 세션을 이어서 진행합니다. 한도가 이미 풀렸다면 바로 다시 시도할 수 있습니다.</div>
          <div className="row gap">
            <button className="btn" disabled={act.busy} onClick={() => void act.run(async () => { await ws().retryMissionLimit(m.id); await detail.reload(); })}>
              지금 다시 시도
            </button>
          </div>
        </div>
      )}
      {(m.status === 'waiting_user' || m.status === 'done' || m.status === 'stopped') && <QuestionCard mission={m} />}
      <LoopStrip stage={m.stage} live={live} cycle={m.cycle} maxCycles={m.maxCycles} working={d.working.filter((w) => w.missionId === m.id)} />
      <Fold id="files" title="결과물 파일" count={d.files.length} extra={<span className="muted small">경로를 누르면 기본 앱으로 열립니다</span>}>
        <FileList files={d.files} />
      </Fold>
      <Fold id="timeline" title="진행 기록" count={d.events.length}>
        <Timeline events={d.events} files={d.files} />
      </Fold>
      <Fold id="flow" title="이번 사이클 작업 흐름" extra={d.currentRun && (
              <span className="row gap">
                <Badge tone={runTone(d.currentRun.run.status)}>{RUN_STATUS_LABEL[d.currentRun.run.status]}</Badge>
                {d.currentRun.run.executor === 'mock' && <Badge tone="mock">모의 실행</Badge>}
              </span>
            )}>
          {d.currentRun ? <CycleFlow detail={d.currentRun} agents={agents} /> : <div className="muted small pad">아직 실행된 사이클이 없습니다. 오퍼레이터가 계획을 세우면 여기에 작업 흐름이 나타납니다.</div>}
          <CycleList detail={d} onOpenRun={onOpenRun} />
          <SnapshotCard mission={m} />
      </Fold>
    </div>
  );
}

/**
 * 접었다 펼 수 있는 운영 화면 구역. 제목 줄을 누르면 접히고, 접힌 상태는 다음에 열 때도 유지된다(이 컴퓨터에만 저장).
 * 접혀 있으면 제목 옆에 개수나 첫 줄 요약을 보여 준다.
 */
function Fold({ id, title, count, summary, extra, className = 'card', children }: { id: string; title: string; count?: number; summary?: string; extra?: ReactNode; className?: string; children: ReactNode }) {
  const key = `crewgenai.fold.${id}`;
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(key) !== '0'; } catch { return true; } });
  const toggle = () => setOpen((o) => { try { localStorage.setItem(key, o ? '0' : '1'); } catch { /* 저장 안 됨 */ } return !o; });
  return (
    <section className={`fold ${className} ${open ? 'open' : 'closed'}`}>
      <div className="fold-head">
        <button type="button" className="fold-toggle" aria-expanded={open} onClick={toggle}>
          <span className="fold-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="fold-title">{title}</span>
          {count !== undefined && <span className="fold-count">{count}</span>}
          {!open && summary && <span className="fold-summary">{summary}</span>}
        </button>
        {open && extra && <span className="fold-extra">{extra}</span>}
      </div>
      {open && <div className="fold-body">{children}</div>}
    </section>
  );
}

/** 오퍼레이터 루프 — 한 줄 진행 표시. 전체 그림은 펼쳐서 본다. */
const STRIP: MissionStage[] = ['plan', 'execute', 'codex', 'claude_review', 'judge'];
function LoopStrip({ stage, live, cycle, maxCycles, working }: { stage: MissionStage; live: boolean; cycle: number; maxCycles: number; working: WorkingItem[] }) {
  const [big, setBig] = useState(false);
  const idx = STRIP.indexOf(stage);
  const end = stage === 'ask_user' || stage === 'done' || stage === 'stopped';
  return (
    <div className="loop-strip-card">
      <div className="loop-strip" aria-label="오퍼레이터 루프 현재 단계">
        <span className="loop-cycle" title="반복 사이클">⟳ 사이클 {cycle}/{maxCycles}</span>
        {STRIP.map((s, i) => (
          <span key={s} className={`loop-step ${s === stage ? `now ${live ? 'live' : ''}` : ''} ${idx > i || end ? 'past' : ''}`} aria-current={s === stage ? 'step' : undefined}>
            {MISSION_STAGE_LABEL[s]}
          </span>
        ))}
        <span className={`loop-step end ${end ? 'now' : ''}`}>{end ? MISSION_STAGE_LABEL[stage] : '확인·완료'}</span>
        <button className="btn-link small" onClick={() => setBig((v) => !v)}>{big ? '그림 닫기' : '루프 그림'}</button>
      </div>
      {live && <WorkingRow items={working} />}
      {big && <LoopDiagram stage={stage} live={live} cycle={cycle} maxCycles={maxCycles} />}
    </div>
  );
}

const WORK_KIND: Record<WorkingItem['kind'], string> = { author: '작업 중', reviewer: '검토 중', codex: '리뷰 중', check: '검사 중', operator: '판단 중' };
/** 지금 일하는 직원: 실행 중인 Claude·Codex 프로세스와 오퍼레이터 호출 */
export function WorkingRow({ items }: { items: WorkingItem[] }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 15000); return () => clearInterval(t); }, []);
  const mins = (iso: string) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  return (
    <div className="working-row" aria-live="polite">
      <span className="working-label">지금 일하는 직원</span>
      {items.length === 0 ? (
        <span className="muted small">없음 — 다음 단계를 준비하고 있습니다</span>
      ) : (
        items.map((w, i) => (
          <span key={`${w.runId ?? w.missionId}-${w.who}-${i}`} className={`working-chip kind-${w.kind}`} title={`${w.task} · ${fmtDate(w.since)}부터`}>
            <span className="dot" />
            <strong>{w.who}</strong>
            <span>{WORK_KIND[w.kind]} · {w.task}</span>
            <span className="muted">{mins(w.since)}분째</span>
          </span>
        ))
      )}
    </div>
  );
}

/** 결과물 파일: 경로를 누르면 기본 앱으로 열고, Finder에서 위치를 보여 준다. */
function FileList({ files }: { files: MissionFile[] }) {
  const act = useAction();
  if (!files.length) return <div className="muted small pad">아직 만든 결과물이 없습니다. 담당 직원이 파일을 만들면 여기에 경로가 나타납니다.</div>;
  return (
    <div className="file-list">
      {act.error && <Banner>{act.error}</Banner>}
      {files.map((f) => (
        <div key={f.relPath} className={`file-row ${f.exists ? '' : 'gone'}`}>
          <button className="file-path" disabled={!f.exists || act.busy} title={f.exists ? `${f.path}\n누르면 기본 앱으로 엽니다` : '파일이 없습니다(삭제·이동됨)'} onClick={() => void act.run(async () => { const err = await ws().openPath(f.path); if (err) throw new Error(err); })}>
            {f.relPath}
          </button>
          <span className="muted small">{f.cycle ? `사이클 ${f.cycle}` : ''}{f.kind ? ` · ${f.kind}` : ''}{f.exists ? '' : ' · 없음'}</span>
          {f.exists && <button className="btn-link small" onClick={() => void act.run(() => ws().revealInFinder(f.path))}>Finder</button>}
        </div>
      ))}
    </div>
  );
}

/** 기록 문장 속 결과물 경로를 눌러 열 수 있는 링크로 바꾼다. */
function LinkedText({ text, files }: { text: string; files: MissionFile[] }) {
  const live = files.filter((f) => f.exists).sort((a, b) => b.relPath.length - a.relPath.length);
  if (!live.length) return <>{text}</>;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(${live.map((f) => esc(f.relPath)).join('|')})`, 'g');
  const parts = text.split(re);
  return (
    <>
      {parts.map((p, i) => {
        const f = i % 2 === 1 ? live.find((x) => x.relPath === p) : undefined;
        return f ? <button key={i} className="inline-file" title={`${f.path} 열기`} onClick={() => void ws().openPath(f.path)}>{p}</button> : <span key={i}>{p}</span>;
      })}
    </>
  );
}

/** 오퍼레이터 질문·근거 문서 보완 요청·완료 보고·중단 안내(입력은 아래 입력창) */
function QuestionCard({ mission }: { mission: Mission }) {
  const done = mission.status === 'done';
  const stopped = mission.status === 'stopped';
  const gaps = mission.status === 'waiting_user' ? mission.gaps ?? [] : [];
  return (
    <div className="answer-card">
      <strong>{stopped ? '중단된 미션 — 아래에서 이어서 다시 시작할 수 있습니다' : done ? '완료 보고 — 아래에서 추가 지시하거나 종료하세요' : gaps.length ? '근거 문서를 보완해 주세요 — 오퍼레이터가 멈췄습니다' : '오퍼레이터가 확인을 요청했습니다'}</strong>
      {stopped ? (
        <div className="muted small">같은 미션 안에서 다음 사이클부터 다시 계획합니다. 이전 판단·답변·추가 지시와 스냅샷을 이어받고, 중단 때 멈춘 작업은 다시 하지 않고 필요한 일만 계획합니다.</div>
      ) : gaps.length ? (
        <>
          <ul className="gap-list">
            {gaps.map((g, i) => (
              <li key={i}>
                <strong>{g.doc || '문서 미지정'}</strong>
                <div>{g.issue}</div>
                {g.need && <div className="small">채울 내용: {g.need}</div>}
              </li>
            ))}
          </ul>
          <div className="muted small">기획 탭 ‘완성 문서 목록…’에서 문서를 보완해 다시 올린 뒤, 아래에서 <strong>보완했으니 다시 확인</strong>을 누르세요. 문서 대신 아래 입력창에 내용을 직접 적어도 됩니다.</div>
        </>
      ) : (
        mission.question && <div className="answer-q">{mission.question}</div>
      )}
    </div>
  );
}
// ───────── 루프 다이어그램(SVG) ─────────
type Box = { id: MissionStage; x: number; y: number; label: string };
const BW = 118;
const BH = 44;
const LOOP: Box[] = [
  { id: 'instruction', x: 10, y: 40, label: MISSION_STAGE_LABEL.instruction },
  { id: 'plan', x: 150, y: 40, label: MISSION_STAGE_LABEL.plan },
  { id: 'execute', x: 290, y: 40, label: MISSION_STAGE_LABEL.execute },
  { id: 'codex', x: 430, y: 40, label: MISSION_STAGE_LABEL.codex },
  { id: 'claude_review', x: 570, y: 40, label: MISSION_STAGE_LABEL.claude_review },
  { id: 'judge', x: 710, y: 40, label: MISSION_STAGE_LABEL.judge },
  { id: 'ask_user', x: 640, y: 150, label: MISSION_STAGE_LABEL.ask_user },
  { id: 'done', x: 780, y: 150, label: MISSION_STAGE_LABEL.done },
];

function LoopDiagram({ stage, live, cycle, maxCycles }: { stage: MissionStage; live: boolean; cycle: number; maxCycles: number }) {
  const at = (id: MissionStage) => LOOP.find((b) => b.id === id)!;
  const order: MissionStage[] = ['instruction', 'plan', 'execute', 'codex', 'claude_review', 'judge'];
  const arrow = (a: Box, b: Box, key: string) => (
    <line key={key} x1={a.x + BW} y1={a.y + BH / 2} x2={b.x - 4} y2={b.y + BH / 2} className="loop-edge" markerEnd="url(#loopArrow)" />
  );
  const j = at('judge');
  const p = at('plan');
  const ask = at('ask_user');
  const dn = at('done');
  return (
    <div className="loop-wrap">
      <svg viewBox="0 0 910 210" className="loop-svg" role="img" aria-label={`오퍼레이터 루프 — 현재 단계: ${MISSION_STAGE_LABEL[stage]}`}>
        <defs>
          <marker id="loopArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className="loop-arrowhead" />
          </marker>
        </defs>
        {order.slice(0, -1).map((id, i) => arrow(at(id), at(order[i + 1]), `e${i}`))}
        {/* 반복: 판단 → 계획 */}
        <path d={`M ${j.x + BW / 2} ${j.y} C ${j.x + BW / 2} ${j.y - 34}, ${p.x + BW / 2} ${p.y - 34}, ${p.x + BW / 2} ${p.y - 3}`} className="loop-edge loop-repeat" markerEnd="url(#loopArrow)" fill="none" />
        <text x={(j.x + p.x + BW) / 2} y={j.y - 22} className="loop-edge-label" textAnchor="middle">
          반복 · 사이클 {cycle}/{maxCycles}
        </text>
        {/* 판단 → 사용자 확인, 완료 */}
        <path d={`M ${j.x + BW / 2 - 20} ${j.y + BH} L ${ask.x + BW / 2} ${ask.y - 3}`} className="loop-edge" markerEnd="url(#loopArrow)" fill="none" />
        <path d={`M ${j.x + BW / 2 + 20} ${j.y + BH} L ${dn.x + BW / 2} ${dn.y - 3}`} className="loop-edge" markerEnd="url(#loopArrow)" fill="none" />
        {/* 사용자 확인 → 계획(답변 후 계속) */}
        <path d={`M ${ask.x} ${ask.y + BH / 2} C ${ask.x - 200} ${ask.y + BH / 2}, ${p.x + BW / 2} ${p.y + BH + 70}, ${p.x + BW / 2} ${p.y + BH + 3}`} className="loop-edge loop-answer" markerEnd="url(#loopArrow)" fill="none" />
        <text x={(ask.x + p.x) / 2 + 40} y={ask.y + BH / 2 + 26} className="loop-edge-label" textAnchor="middle">
          답변 후 계속
        </text>
        {LOOP.map((b) => {
          const cur = b.id === stage;
          return (
            <g key={b.id} className={`loop-box ${cur ? 'current' : ''} ${cur && live ? 'pulse' : ''} kind-${b.id}`}>
              <rect x={b.x} y={b.y} width={BW} height={BH} rx={10} />
              <text x={b.x + BW / 2} y={b.y + BH / 2 + 5} textAnchor="middle">
                {b.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ───────── 이번 사이클 작업 흐름 ─────────
function CycleFlow({ detail, agents }: { detail: RunDetail; agents: Agent[] }) {
  const [selNode, setSelNode] = useState<string | null>(null);
  const flowNodes = useMemo(
    () =>
      toFlowNodes((needsLayout(detail.graph) ? autoLayout(detail.graph) : detail.graph).nodes, agents, (n) => {
        const st = detail.nodes.find((x) => x.nodeId === n.id);
        return { status: st?.status ?? 'waiting', visits: st?.visits ?? 0 };
      }).map((n) => ({ ...n, selected: n.id === selNode })),
    [detail, agents, selNode],
  );
  const flowEdges = useMemo(() => toFlowEdges(detail.graph.edges), [detail]);
  const node = detail.graph.nodes.find((n) => n.id === selNode) ?? null;
  const state = node ? detail.nodes.find((x) => x.nodeId === node.id) : null;
  const attempts = node ? detail.attempts.filter((a) => a.nodeId === node.id) : [];
  const reported = detail.attempts.filter((a) => a.costUsd !== null);
  return (
    <div className="cycle-flow">
      <div className="cycle-canvas">
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
      </div>
      <div className="muted small">
        사용량:{' '}
        {reported.length === 0
          ? `미보고 · ${billingLabel(detail.billing)}`
          : `$${reported.reduce((s, a) => s + (a.costUsd ?? 0), 0).toFixed(4)} — ${billingLabel(detail.billing)}`}
      </div>
      {node && (
        <div className="cycle-node">
          <div className="row between">
            <strong>
              {node.label} <small className="muted">{NODE_KIND_LABEL[node.kind]}</small>
            </strong>
            <button className="btn-link" onClick={() => setSelNode(null)}>
              닫기
            </button>
          </div>
          {state && (
            <div className="small">
              상태: {NODE_STATUS_LABEL[state.status]} · 방문 {state.visits}회
              {state.failureReason && <div className="bad-text">실패 이유: {state.failureReason}</div>}
              {state.nextAction && <div className="muted">다음: {state.nextAction}</div>}
            </div>
          )}
          {attempts.length === 0 && <div className="muted small">아직 시도가 없습니다.</div>}
          {attempts.map((a) => (
            <div key={a.id} className="cycle-attempt">
              <div className="row gap wrap small">
                <Badge tone={a.status === 'succeeded' ? 'ok' : a.status === 'running' ? 'info' : a.status === 'failed' || a.status === 'timeout' ? 'bad' : 'warn'}>{a.status}</Badge>
                <span>
                  {a.role === 'codex' ? 'Codex' : a.role === 'reviewer' ? 'Claude 검토' : a.role === 'check' ? '검사' : a.role === 'author' ? '작성' : a.role} · 방문 {a.visit} · 시도 {a.attemptNo}
                </span>
              </div>
              {a.error && <div className="bad-text small">{a.error}</div>}
              {a.summary && (
                <Collapsible title={<span className="small">요약</span>}>
                  <pre className="pre small">{a.summary}</pre>
                </Collapsible>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 미션 스냅샷(git 태그)과 되돌리기 — 그 시점 이후 이 미션의 CREWGENAI 커밋만 git revert로 되돌린다 */
function SnapshotCard({ mission }: { mission: Mission }) {
  const snaps = useLoad(() => ws().missionSnapshots(mission.id), [mission.id]);
  const act = useAction();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadRef = useRef(snaps.reload);
  reloadRef.current = snaps.reload;
  useEffect(() => {
    const off = ws().onLive((e: LiveEvent) => {
      const hit = (e.type === 'mission' && e.mission.id === mission.id) || (e.type === 'missionEvent' && e.event.missionId === mission.id);
      if (!hit) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void reloadRef.current(), 400);
    });
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [mission.id]);
  const running = ACTIVE.includes(mission.status);
  const rollback = (s: MissionSnapshot) =>
    act.run(async () => {
      const n = s.commitsAfter.length;
      if (!confirm(`'${s.name}' 시점으로 되돌릴까요?\n\n그 이후 이 미션의 CREWGENAI 커밋 ${n}개를 git revert로 되돌립니다.${s.repos ? `\n저장소마다 따로 되돌립니다(${[...new Set(s.commitsAfter.map((c) => c.repo).filter(Boolean))].join(', ') || '대상 없음'}).` : ''}\n기록은 남고 다시 되돌릴 수 있으며, 사용자의 다른 변경은 건드리지 않습니다.`)) return;
      const r = await ws().rollbackMission(mission.id, s.tag);
      setResult(r.ok ? { ok: true, text: `되돌렸습니다: 커밋 ${r.reverted.length}개를 revert했습니다.` } : { ok: false, text: `되돌리지 못했습니다: ${r.error ?? '원인 미상'}` });
      await snaps.reload();
    });
  return (
    <div className="snapshot-card">
      <h4>스냅샷·되돌리기</h4>
      {snaps.loading && !snaps.data && <Loading />}
      {snaps.error && <Banner>{snaps.error}</Banner>}
      {snaps.data && snaps.data.length === 0 && <div className="muted small">스냅샷이 없습니다. (설정에서 git 커밋·스냅샷을 켜고, git 저장소에서 미션을 시작하면 생깁니다.)</div>}
      {running && snaps.data && snaps.data.length > 0 && <div className="muted small">작동 중에는 먼저 중단하세요. 중단·확인 대기·완료 상태에서 되돌릴 수 있습니다.</div>}
      <div className="snapshot-list">
        {snaps.data?.map((s) => (
          <div key={s.tag} className="snapshot-row">
            <div className="row between wrap gap">
              <div>
                <strong>{s.name}</strong> <span className="muted small">사이클 {s.cycle} · {s.repos ? <span title={s.repos.join(', ')}>저장소 {s.repos.length}개</span> : <span className="mono">{s.sha.slice(0, 8)}</span>} · {fmtDate(s.createdAt)}</span>
              </div>
              <button className="btn" disabled={act.busy || running} title={running ? '작동 중에는 먼저 중단하세요' : ''} onClick={() => void rollback(s)}>
                이 시점으로 되돌리기
              </button>
            </div>
            {s.commitsAfter.length > 0 ? (
              <Collapsible title={<span className="small">이후 CREWGENAI 커밋 {s.commitsAfter.length}개</span>}>
                <ul className="commit-list">
                  {s.commitsAfter.map((c) => (
                    <li key={`${c.repo ?? ''}:${c.sha}`} className="small">
                      {c.repo && <strong>{c.repo} </strong>}<span className="mono">{c.sha.slice(0, 8)}</span> · {c.author} · {c.subject}
                    </li>
                  ))}
                </ul>
              </Collapsible>
            ) : (
              <div className="muted small">이후 CREWGENAI 커밋 0개</div>
            )}
          </div>
        ))}
      </div>
      {result && <div className={`small ${result.ok ? 'ok-line' : 'bad-line'}`}>{result.text}</div>}
      {act.error && <Banner>{act.error}</Banner>}
    </div>
  );
}

function CycleList({ detail, onOpenRun }: { detail: MissionDetail; onOpenRun: (runId: string) => void }) {
  if (!detail.cycles.length) return null;
  return (
    <div className="cycle-list">
      <strong className="small">사이클</strong>
      {detail.cycles.map((c) => (
        <div key={`${c.cycle}-${c.runId}`} className="row between small">
          <span>
            사이클 {c.cycle} · 흐름 v{c.graphVersion}
          </span>
          <span className="row gap">
            <Badge tone={runTone(c.status)}>{RUN_STATUS_LABEL[c.status]}</Badge>
            <button className="btn-link" onClick={() => onOpenRun(c.runId)}>
              열기
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

// ───────── 진행 기록 ─────────
const EVENT_LABEL: Record<MissionEvent['kind'], string> = {
  user: '사용자 지시',
  operator_plan: '오퍼레이터 계획',
  operator_judge: '오퍼레이터 판단',
  question: '확인 요청',
  answer: '사용자 답변',
  directive: '추가 지시',
  cycle_start: '사이클 시작',
  cycle_end: '사이클 종료',
  system: '시스템',
};
const EVENT_ICON: Record<MissionEvent['kind'], string> = {
  user: '🧑', operator_plan: '🗂', operator_judge: '⚖️', question: '❓', answer: '💬', directive: '✍️', cycle_start: '▶︎', cycle_end: '■', system: 'ⓘ',
};

function pretty(data: string): string {
  try {
    return JSON.stringify(JSON.parse(data), null, 2);
  } catch {
    return data;
  }
}

function Timeline({ events, files = [] }: { events: MissionEvent[]; files?: MissionFile[] }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // 기록 상자 안에서만 아래로 이동한다(화면 전체를 움직여 루프 다이어그램이 가려지지 않게)
    const el = boxRef.current; if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);
  if (!events.length) return <div className="muted small pad">기록이 없습니다.</div>;
  return (
    <div className="timeline" ref={boxRef}>
      {events.map((e) => {
        const mine = e.kind === 'user' || e.kind === 'answer' || e.kind === 'directive';
        return (
          <div key={e.seq} className={`tl-item ${mine ? 'mine' : ''} kind-${e.kind}`}>
            <div className="tl-meta small muted">
              <span>{EVENT_ICON[e.kind]}</span> {EVENT_LABEL[e.kind]} · 사이클 {e.cycle} · {fmtDate(e.at)}
            </div>
            <div className="tl-text"><LinkedText text={e.text} files={files} /></div>
            {e.data && e.data !== '{}' && e.data !== 'null' && (
              <Collapsible title={<span className="small">상세</span>}>
                <pre className="pre small">{pretty(e.data)}</pre>
              </Collapsible>
            )}
          </div>
        );
      })}
    </div>
  );
}
