// 운영 — 오퍼레이터 루프(미션) 화면
// 사용자 지시 → 오퍼레이터 계획 → 담당 Agent 수행 → Codex 리뷰 → Claude 재검토 → 오퍼레이터 판단 → (반복 | 사용자 확인 | 완료)
import type { ReactNode } from 'react';
import { autoLayout } from '../../shared/layout';
import { Background, Controls, ReactFlow } from '@xyflow/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, LiveEvent, Mission, MissionGap, MissionPick, MissionResult, MissionRef, RefSnippet, StaffProposal, MissionDetail, MissionEvent, MissionFile, MissionReadiness, WorkingItem, MissionSnapshot, MissionStage, MissionStatus, Project, PromptTemplate, RunDetail } from '../../shared/types';
import { MISSION_STAGE_LABEL, MISSION_STATUS_LABEL, NODE_KIND_LABEL, NODE_STATUS_LABEL, RUN_STATUS_LABEL, billingLabel } from '../../shared/types';
import { fmtDate, isComposingEnter, useAction, useLoad, ws } from '../api';
import { Badge, Banner, Collapsible, Empty, Loading, Modal } from './common';
import { Markdown } from '../markdown';
import ResultsPanel from './Results';
import ReviewCheckpoint from './ReviewCheckpoint';
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
// 직원이 일하는 동안 실행 이벤트가 쉬지 않고 오므로, 다시 불러오기는 최소 1.5초 간격으로 묶는다(입력이 버벅이지 않게)
const DETAIL_GAP_MS = 1500;
function useMissionDetail(missionId: string | null, eventLimit: number) {
  const detail = useLoad(() => (missionId ? ws().missionDetail(missionId, eventLimit) : Promise.resolve(null)), [missionId, eventLimit]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const last = useRef(0);
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
      if (!hit || timer.current) return; // 이미 예약됨
      const wait = Math.max(300, DETAIL_GAP_MS - (Date.now() - last.current));
      timer.current = setTimeout(() => { timer.current = null; last.current = Date.now(); void reloadRef.current(); }, wait);
    });
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [missionId]);
  return detail;
}

export default function MissionTab({ project, onOpenRun, onGoTab, draft, onDraftUsed, focusMissionId }: { project: Project; onOpenRun: (runId: string) => void; onGoTab?: (tab: 'plan' | 'agents' | 'settings') => void; draft?: string | null; onDraftUsed?: () => void; focusMissionId?: { id: string; n: number } | null }) {
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
  // '확인 필요' 막대에서 넘어오면 그 미션을 연다
  // 한 번 연 뒤에는 다시 적용하지 않는다(사용자가 다른 미션을 고르면 그대로 둔다)
  const focusApplied = useRef(0);
  useEffect(() => {
    if (!focusMissionId || focusApplied.current === focusMissionId.n || !list.data?.some((m) => m.id === focusMissionId.id)) return;
    focusApplied.current = focusMissionId.n;
    setSel(focusMissionId.id);
  }, [focusMissionId, list.data]);
  // 확인이 필요한 미션(사용자 답변 대기)을 맨 위에
  const ordered = useMemo(() => (list.data ? [...list.data].sort((a, b) => Number(b.status === 'waiting_user') - Number(a.status === 'waiting_user')) : null), [list.data]);
  const mission = sel && sel !== NEW ? list.data?.find((m) => m.id === sel) ?? null : null;
  // 지시 입력 때마다 미션 화면 전체가 다시 그려지지 않게 콜백을 고정한다
  const openRunRef = useRef(onOpenRun); openRunRef.current = onOpenRun;
  const openRun = useCallback((id: string) => openRunRef.current(id), []);
  const listReload = useRef(list.reload); listReload.current = list.reload;
  const viewChanged = useCallback(() => void listReload.current(), []);
  const noAgents = useMemo<Agent[]>(() => [], []);

  return (
    <div className="mission-layout">
      <aside className="mission-left">
        <button className={`btn block ${sel === NEW ? 'btn-primary' : ''}`} onClick={() => setSel(NEW)}>+ 새 지시</button>
        <div className="side-label">미션</div>
        {list.loading && !list.data && <Loading />}
        {list.error && <Banner>{list.error}</Banner>}
        {list.data && list.data.length === 0 && <div className="muted small pad">아직 지시한 미션이 없습니다.</div>}
        <div className="mission-list">
          {ordered?.map((m) => (
            <button key={m.id} className={`mission-item ${sel === m.id ? 'active' : ''} ${m.status === 'waiting_user' ? 'needs-you' : ''}`} onClick={() => setSel(m.id)}>
              <div className="row between">
                {m.status === 'waiting_user' ? <span className="attn-badge">확인 필요</span> : <Badge tone={missionTone(m.status)}>{MISSION_STATUS_LABEL[m.status]}</Badge>}
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
            <MissionView key={sel} missionId={sel} agents={agents.data ?? noAgents} onOpenRun={openRun} onChanged={viewChanged} />
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
  // 검토 지점에서는 결정·피드백을 검토 카드에서 보내므로 입력창은 일반 추가 지시로 쓴다
  const cp = st === 'waiting_user' && !!mission?.checkpoint?.blocking;
  const gaps = !cp && st === 'waiting_user' && !!mission?.gaps?.length;
  const denied = !cp && st === 'waiting_user' && (!!mission?.denials?.length || !!mission?.blockers?.length);
  const mode: 'new' | 'live' | 'answer' | 'done' | 'stopped' = !mission || st === 'failed' ? 'new' : live ? 'live' : st === 'waiting_user' ? 'answer' : st === 'done' ? 'done' : 'stopped';
  const active = ready?.activeMission ?? null;
  const blockedNew = mode === 'new' && !!active;
  const notReady = mode === 'new' && !!ready && !ready.ready;
  const run = (f: () => Promise<void>) => act.run(async () => { setNote(null); await f(); });
  // 지시 첨부 파일: 앱 데이터 폴더로 복사한 경로를 지시 끝에 붙인다(오퍼레이터·직원이 읽기 전용으로 받음)
  const [files, setFiles] = useState<{ name: string; path: string; size: number }[]>([]);
  const attach = () => run(async () => {
    const got = await ws().pickAttachments(project.id);
    const ok = got.filter((f) => f.path); const bad = got.filter((f) => !f.path);
    setFiles((cur) => [...cur, ...ok.filter((f) => !cur.some((c) => c.path === f.path))].slice(0, 10));
    if (bad.length) setNote(`첨부하지 않은 파일: ${bad.map((f) => `${f.name}(${f.skipped})`).join(', ')}`);
  });
  // 붙여넣기: 클립보드에 파일·이미지(스크린샷 등)가 있으면 첨부로 저장한다. 글자만 있으면 평소처럼 입력창에 붙는다
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const list = [...(e.clipboardData?.files ?? [])];
    if (!list.length) return;
    e.preventDefault();
    void run(async () => {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
      const bad: string[] = [];
      for (const [i, f] of list.slice(0, 10).entries()) {
        const ext = f.type.startsWith('image/') ? `.${f.type.slice(6).replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '')}` : '';
        const name = f.name && f.name !== 'image.png' ? f.name : `붙여넣기-${stamp}${list.length > 1 ? `-${i + 1}` : ''}${ext || '.png'}`;
        const r = await ws().saveAttachmentData(project.id, name, new Uint8Array(await f.arrayBuffer()));
        if (r.path) setFiles((cur) => (cur.some((c) => c.path === r.path) ? cur : [...cur, r].slice(0, 10))); else bad.push(`${r.name}(${r.skipped})`);
      }
      if (bad.length) setNote(`첨부하지 않은 내용: ${bad.join(', ')}`);
    });
  };
  const withFiles = (t: string) => (files.length ? `${t}${t ? '\n\n' : ''}[첨부 파일 ${files.length}개 — 읽기 전용으로 참고]\n${files.map((f) => `- ${f.name}: ${f.path}`).join('\n')}` : t);
  // 새 지시의 참여 직원(선택). 비워 두면 활성 직원 전체
  const [staff, setStaff] = useState<string[]>([]);
  const staffList = useLoad(() => (mode === 'new' ? ws().listAgents(project.id) : Promise.resolve([] as Agent[])), [project.id, mode]);
  const pickable = (staffList.data ?? []).filter((a) => a.active && a.code !== '00');

  const startNew = () => run(async () => {
    const t = text.trim();
    if (!t) throw new Error('지시 내용을 입력하세요.');
    const r = await ws().missionReadiness(project.id, true);
    if (!r.ready) throw new Error(`지시하려면 먼저 설정하세요: ${r.items.filter((i) => !i.ok).map((i) => i.label).join(', ')}`);
    const m = await ws().startMission(project.id, withFiles(t), staff.length ? { staff } : null);
    setText(''); setStaff([]); setFiles([]);
    await onChanged(m.id);
  });
  const directive = (how: 'next' | 'now') => run(async () => {
    const t = text.trim();
    if (!t) throw new Error('추가 지시 내용을 입력하세요.');
    if (how === 'now' && !confirm('진행 중인 Claude·Codex 작업을 멈추고, 이 지시를 반영해 다시 계획할까요?')) return;
    await ws().addDirective(mission!.id, withFiles(t), how);
    setText(''); setFiles([]);
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
    if (action === 'continue' && mode === 'answer' && !t && !gaps && !denied) throw new Error('답변을 입력하세요.');
    if (action === 'continue' && mode === 'done' && !t) throw new Error('추가 지시를 입력하세요.');
    // 입력창 버튼은 '허용했으니 다시 시도'·'보완했으니 다시 확인'처럼 해결을 뜻하므로 확인 필요 항목을 풀고 다시 계획한다(질문에만 답하려면 선택지 버튼)
    await ws().answerMission(mission!.id, action === 'continue' ? withFiles(t) : t, action);
    setText(''); setFiles([]);
    await onChanged();
  });

  const primary = mode === 'new' ? startNew : mode === 'live' ? () => directive('next') : mode === 'stopped' ? () => answer('continue') : () => answer('continue');
  const label = mode === 'new' ? '새 지시' : mode === 'live' ? '진행 중 추가 지시' : mode === 'answer' ? (cp ? '추가 지시(결정·피드백은 위 검토 카드에서 한 번에)' : gaps ? '근거 문서 보완 후 다시 확인' : denied ? '확인한 뒤 다시 시도' : '오퍼레이터 질문에 답변') : mode === 'done' ? '완료 보고 — 추가 지시' : '중단된 미션';
  const placeholder = mode === 'new' ? '무엇을 만들거나 고칠지 적어 주세요. 예: 공고 목록 화면에 마감일 정렬을 추가하고, 정렬 기준을 문서로 남겨 줘'
    : mode === 'live' ? '추가 지시 — 예: 표 대신 목록으로 정리하고, 근거 줄 번호를 꼭 달아 줘'
    : mode === 'answer' ? (gaps ? '보완한 내용을 적거나(선택), 문서를 올린 뒤 비워 두고 다시 확인을 누르세요' : denied ? '위에서 허용했으면 비워 두고 다시 시도를 누르세요. 다른 방법으로 하려면 바꿀 지시를 적으세요' : '답변을 입력하세요')
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
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (isComposingEnter(e)) return;
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (!disabled) void primary(); }
          }}
        />
        <div className="composer-files small">
          <button type="button" className="btn btn-sm" disabled={act.busy || files.length >= 10} onClick={() => void attach()} title="문서·이미지·자료 파일을 지시와 함께 보냅니다(앱 데이터 폴더로 복사, 저장소에는 들어가지 않음)">📎 파일 첨부</button>
          {files.map((f) => (
            <span key={f.path} className="file-chip">{f.name} <span className="muted">{f.size >= 1048576 ? `${(f.size / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(f.size / 1024))}KB`}</span>
              <button type="button" className="btn-link" aria-label={`${f.name} 첨부 빼기`} onClick={() => setFiles((cur) => cur.filter((x) => x.path !== f.path))}>×</button></span>
          ))}
          {!files.length && <span className="muted">복사한 이미지·파일은 입력창에 붙여 넣어도(Ctrl+V) 첨부됩니다 · 비밀값 파일(.env·키)은 첨부되지 않습니다</span>}
        </div>
        {mode === 'new' && (
          <div className="composer-limits">
            {pickable.length > 0 && (
              <div className="small composer-staff" role="group" aria-label="참여 직원">
                <span>참여 직원</span>
                {pickable.map((a) => (
                  <label key={a.id} className={`chip-check${staff.includes(a.id) ? ' is-on' : ''}`}>
                    <input type="checkbox" checked={staff.includes(a.id)} onChange={(e) => setStaff((s) => (e.target.checked ? [...s, a.id] : s.filter((x) => x !== a.id)))} />
                    {a.code} {a.name}
                  </label>
                ))}
                <span className="muted">{staff.length ? '오퍼레이터와 고른 직원만 일합니다' : '고르지 않으면 활성 직원 전체'}</span>
              </div>
            )}
          </div>
        )}
        <div className="composer-actions">
          <small className="muted">Ctrl+Enter로 보내기</small>
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
              <button className="btn btn-primary" disabled={act.busy} onClick={() => void answer('continue')}>{mode === 'done' ? '추가 지시하고 계속' : gaps ? '보완했으니 다시 확인' : denied ? (mission?.blockers?.length ? '해결했으니 다시 시도' : '허용했으니 다시 시도') : '답변하고 계속'}</button>
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

const EVENT_PAGE = 150;
const MissionView = memo(function MissionView({ missionId, agents, onOpenRun, onChanged }: { missionId: string; agents: Agent[]; onOpenRun: (runId: string) => void; onChanged: () => void }) {
  const [eventLimit, setEventLimit] = useState(EVENT_PAGE);
  const detail = useMissionDetail(missionId, eventLimit);
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
            사이클 {m.cycle} · 지난 검토 이후 자동 {m.sinceReview ?? 0}회 · 시작 {fmtDate(m.createdAt)} · 갱신 {fmtDate(m.updatedAt)}
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
      {/* 지금 단계·지금 일하는 직원: 결과 카드보다 위에 두어 늘 보이게 */}
      <LoopStrip stage={m.stage} live={live} cycle={m.cycle} maxCycles={m.maxCycles} working={d.working.filter((w) => w.missionId === m.id)} run={d.currentRun} agents={agents} />
      {m.checkpoint && !['stopped', 'failed'].includes(m.status) && <ReviewCheckpoint mission={m} progress={d.progress} onChanged={async () => { await detail.reload(); onChanged(); }} />}
      {m.status === 'waiting_user' && m.pauseKind === 'restart' && !m.checkpoint && (
        <div className="limit-card" role="status">
          <strong>앱이 다시 시작되어 잠시 멈췄습니다</strong>
          <div className="muted small">사용자 결정이 필요한 멈춤이 아니어서 팝업으로 묻지 않았습니다. 이어서 진행하면 같은 사이클부터 다시 계획합니다.</div>
          <div className="row gap"><button className="btn btn-primary" disabled={act.busy} onClick={() => void act.run(async () => { await ws().answerMission(m.id, '', 'continue', true); await detail.reload(); })}>이어서 진행</button></div>
        </div>
      )}
      {(d.pendingDirectives?.length ?? 0) > 0 && <PendingDirectives missionId={m.id} items={d.pendingDirectives!} onChanged={async () => { await detail.reload(); }} />}
      {!m.checkpoint && (m.results || m.resultsHistory?.length) && <ResultsCard mission={m} />}
      {m.summary && (
        <div className="card report-card">
          <div className="report-head"><strong>진행 보고</strong><span className="muted small">사이클 {m.resultsCycle ?? m.cycle} · 오퍼레이터 판단</span></div>
          <Markdown text={m.summary} />
        </div>
      )}
      <Fold id="prompt" title="지시" className="mission-prompt" summary={m.prompt}>
        <div>{m.prompt}</div>
      </Fold>
      {act.error && <Banner>{act.error}</Banner>}
      {live && (m.limitUntil || m.limitWait) && (
        <div className="limit-card" role="status">
          <strong>{m.limitWait?.source === 'pace' ? `사용량 속도 조절 — ${m.limitUntil ? `${fmtDate(m.limitUntil)}에 다음 사이클을 자동으로 시작합니다` : '다시 확인하는 중'}` : `Claude 한도 대기${m.limitUntil ? ` — ${fmtDate(m.limitUntil)}에 앱이 다시 확인하고 자동으로 이어서 진행합니다` : ' — 다시 시도하는 중'}`}</strong>
          <dl className="limit-facts small">
            <dt>대기 사유</dt><dd>{m.limitWait?.reason || '플랜 사용 한도 도달'}</dd>
            <dt>해제 시각</dt><dd>{m.limitWait ? (m.limitWait.resetKnown ? `확인됨 · ${fmtDate(m.limitWait.nextAt)}` : '알 수 없음 — 1시간마다 한 번 다시 확인') : '—'}</dd>
            <dt>다음 확인</dt><dd>{m.limitUntil ? fmtDate(m.limitUntil) : '지금 확인 중'}</dd>
            <dt>마지막 확인</dt><dd>{m.limitWait?.lastAt ? `${fmtDate(m.limitWait.lastAt)} · ${m.limitWait.lastResult ?? ''}` : '아직 없음(처음 한도 도달)'}</dd>
            <dt>자동 재개할 작업</dt><dd>{m.limitWait?.target ?? '멈춘 작업'}</dd>
          </dl>
          {m.limitWait?.source === 'pace' && <div className="muted small">한도에 걸린 것이 아닙니다. 주간 사용량을 초기화 시각까지 나눠 쓰려고 새 사이클 시작만 미루고 있습니다(진행하던 단계는 끝까지 함). 설정 &gt; 사용량 속도 조절에서 끄거나 남길 몫을 바꿀 수 있습니다.</div>}
          <div className="muted small">실패로 처리하지 않습니다. 예약은 이 앱이 관리하므로 앱이 켜져 있어야 실행됩니다(앱을 껐다 켜도 예약은 복원되고, 지난 예약은 한 번만 확인합니다). 대기 중에는 Claude를 부르지 않습니다.</div>
          <div className="row gap">
            <button className="btn" disabled={act.busy} onClick={() => void act.run(async () => { await ws().retryMissionLimit(m.id); await detail.reload(); })}>
              지금 다시 시도
            </button>
          </div>
        </div>
      )}
      {(m.status === 'waiting_user' || m.status === 'done' || m.status === 'stopped') && !m.checkpoint?.blocking && m.pauseKind !== 'restart' && <QuestionCard mission={m} agents={agents} onChanged={async () => onChanged()} />}
      {m.status !== 'waiting_user' && m.status !== 'stopped' && m.status !== 'failed' && <ParkedCard mission={m} agents={agents} onChanged={async () => onChanged()} />}
      {m.status !== 'stopped' && m.status !== 'failed' && <StaffProposalCard mission={m} agents={agents} onChanged={async () => onChanged()} />}
      <Fold id="files" title="결과물 파일" count={d.files.length} extra={<span className="muted small">경로를 누르면 기본 앱으로 열립니다</span>}>
        <FileList files={d.files} />
      </Fold>
      <Fold id="timeline" title="진행 기록" count={d.eventsTotal ?? d.events.length}>
        {(d.eventsTotal ?? 0) > d.events.length && (
          <div className="row gap small pad"><span className="muted">최근 {d.events.length}건만 표시 중(전체 {d.eventsTotal}건)</span>
            <button className="btn-link small" disabled={detail.loading} onClick={() => setEventLimit((n) => n + EVENT_PAGE * 2)}>이전 기록 더 보기</button></div>
        )}
        <Timeline events={d.events} files={d.files} />
      </Fold>
      <Fold id="flow" title="사이클 히스토리" count={d.cycles.length}>
          <CycleHistory detail={d} agents={agents} onOpenRun={onOpenRun} />
          <SnapshotCard mission={m} />
      </Fold>
    </div>
  );
});

/** 대기 중인 추가 지시: 오퍼레이터가 다음 계획에서 읽기 전까지는 취소할 수 있다 */
function PendingDirectives({ missionId, items, onChanged }: { missionId: string; items: { seq: number; at: string; text: string }[]; onChanged: () => Promise<void> }) {
  const act = useAction();
  return (
    <div className="card pending-dir" aria-label="대기 중인 추가 지시">
      <div className="report-head"><strong>대기 중인 추가 지시 {items.length}건</strong><span className="muted small">다음 오퍼레이터 계획 때 반영됩니다. 그 전까지 취소할 수 있습니다.</span></div>
      {act.error && <Banner>{act.error}</Banner>}
      <ul className="pending-dir-list">
        {items.map((x) => (
          <li key={x.seq}>
            <div className="pending-dir-text">{x.text}</div>
            <div className="row gap small"><span className="muted">{fmtDate(x.at)}</span>
              <button className="btn btn-sm" disabled={act.busy} onClick={() => { if (window.confirm('이 추가 지시를 취소할까요? 오퍼레이터에게 전달되지 않습니다.')) void act.run(async () => { await ws().cancelDirective(missionId, x.seq); await onChanged(); }); }}>취소</button></div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 접었다 펼 수 있는 운영 화면 구역. 제목 줄을 누르면 접히고, 접힌 상태는 다음에 열 때도 유지된다(이 컴퓨터에만 저장).
 * 접혀 있으면 제목 옆에 개수나 첫 줄 요약을 보여 준다.
 */
/** 작업별로 바로 열어 볼 결과물 + 그 결과물에 대한 피드백(다음 사이클에 반영) */
function ResultsCard({ mission: m }: { mission: Mission }) {
  return (
    <div className="card results-card">
      <div className="report-head"><strong>열어 볼 결과물</strong></div>
      <ResultsPanel mission={m} />
    </div>
  );
}

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
function LoopStrip({ stage, live, cycle, maxCycles, working, run, agents }: { stage: MissionStage; live: boolean; cycle: number; maxCycles: number; working: WorkingItem[]; run: RunDetail | null; agents: Agent[] }) {
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
        {run && <button className="btn-link small" onClick={() => setBig((v) => !v)}>{big ? '작업 흐름 닫기' : '작업 흐름'}</button>}
      </div>
      {live && <WorkingRow items={working} />}
      {big && run && <CycleFlow detail={run} agents={agents} />}
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

/** 결과물 파일: 경로를 누르면 기본 앱으로 열고, 탐색기에서 위치를 보여 준다. */
const FILE_PAGE = 100;
function FileList({ files }: { files: MissionFile[] }) {
  const act = useAction();
  const [n, setN] = useState(FILE_PAGE);
  if (!files.length) return <div className="muted small pad">아직 만든 결과물이 없습니다. 담당 직원이 파일을 만들면 여기에 경로가 나타납니다.</div>;
  return (
    <div className="file-list">
      {act.error && <Banner>{act.error}</Banner>}
      {files.slice(0, n).map((f) => (
        <div key={f.relPath} className={`file-row ${f.exists ? '' : 'gone'}`}>
          <button className="file-path" disabled={!f.exists || act.busy} title={f.exists ? `${f.path}\n누르면 기본 앱으로 엽니다` : '파일이 없습니다(삭제·이동됨)'} onClick={() => void act.run(async () => { const err = await ws().openPath(f.path); if (err) throw new Error(err); })}>
            {f.relPath}
          </button>
          <span className="muted small">{f.cycle ? `사이클 ${f.cycle}` : ''}{f.kind ? ` · ${f.kind}` : ''}{f.exists ? '' : ' · 없음'}</span>
          {f.exists && <button className="btn-link small" onClick={() => void act.run(() => ws().revealInFinder(f.path))}>탐색기</button>}
        </div>
      ))}
      {files.length > n && <button className="btn-link small" onClick={() => setN((x) => x + FILE_PAGE * 3)}>파일 {files.length - n}개 더 보기(최신 사이클 먼저)</button>}
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
function QuestionCard({ mission, agents, onChanged }: { mission: Mission; agents: Agent[]; onChanged: () => Promise<void> }) {
  const act = useAction();
  const done = mission.status === 'done';
  const stopped = mission.status === 'stopped';
  const gaps = mission.status === 'waiting_user' ? mission.gaps ?? [] : [];
  const denials = mission.status === 'waiting_user' ? mission.denials ?? [] : [];
  const blockers = mission.status === 'waiting_user' ? mission.blockers ?? [] : [];
  return (
    <div className="answer-card">
      <strong>{stopped ? '중단된 미션 — 아래에서 이어서 다시 시작할 수 있습니다' : done ? '완료 보고 — 아래에서 추가 지시하거나 종료하세요' : gaps.length ? '근거 문서를 보완해 주세요 — 오퍼레이터가 멈췄습니다' : denials.length ? '권한 때문에 멈췄습니다 — 지시문으로는 권한이 바뀌지 않습니다' : blockers.length ? '에이전트가 해결할 수 없는 문제로 멈췄습니다 — 확인이 필요합니다' : '오퍼레이터가 확인을 요청했습니다'}</strong>
      {stopped ? (
        <div className="muted small">같은 미션 안에서 다음 사이클부터 다시 계획합니다. 이전 판단·답변·추가 지시와 스냅샷을 이어받고, 중단 때 멈춘 작업은 다시 하지 않고 필요한 일만 계획합니다.</div>
      ) : gaps.length ? (
        <>
          <GapPicker mission={mission} gaps={gaps} resume onChanged={onChanged} />
          <div className="muted small">항목마다 선택지를 고르거나 직접 적고 <strong>고른 대로 계속 진행</strong>을 누르세요. 문서를 보완했다면 기획 탭 ‘완성 문서 목록…’에서 다시 올린 뒤 아래에서 <strong>보완했으니 다시 확인</strong>을 눌러도 됩니다.</div>
        </>
      ) : denials.length ? (
        <DenialList mission={mission} agents={agents} />
      ) : blockers.length ? (
        <>
          <ul className="gap-list">
            {blockers.map((b, i) => (
              <li key={i}>
                <div><span className={`blocker-kind ${b.kind}`}>{b.kind === 'environment' ? '내 PC 환경' : '같은 실패 반복'}</span> <strong>{b.step}</strong></div>
                <div className="mono small denial-target">{b.reason}</div>
              </li>
            ))}
          </ul>
          <div className="muted small">
            {blockers.some((b) => b.kind === 'environment')
              ? '명령·프로그램 설치, 경로, 로그인, 네트워크처럼 이 PC에서 직접 고쳐야 하는 문제입니다. 고친 뒤 아래에서 다시 시도를 누르세요. 다른 방법으로 진행하려면 바꿀 지시를 적으세요.'
              : '같은 원인으로 다시 실패했습니다. 지시·완료 조건·검사 명령을 바꾸거나 원인을 고친 뒤 다시 시도하세요.'}
          </div>
        </>
      ) : null}
      {/* 오퍼레이터가 직접 물은 질문은 보류·근거 부족 항목이 함께 있어도 보여 준다 */}
      {!stopped && (done || (!gaps.length && !denials.length && !blockers.length) || mission.questionOptions != null) && (
        <>
          {mission.question && <div className="answer-q">{gaps.length || denials.length || blockers.length ? mission.question.split('\n')[0] : mission.question}</div>}
          {!done && (mission.questionOptions?.length ?? 0) > 0 && (
            <>
              {act.error && <Banner>{act.error}</Banner>}
              <div className="pick-options">
                {mission.questionOptions!.map((o, i) => {
                  const c = mission.questionChoices?.find((x) => x.label === o);
                  const text = c?.effect ? `${o} — ${c.effect}` : o;
                  return (
                    <button key={i} className="btn pick-option" disabled={act.busy} title={c?.effect ? `고르면: ${c.effect}` : undefined}
                      onClick={() => void act.run(async () => { if (c?.action === 'stop') await ws().answerMission(mission.id, '', 'stop'); else await ws().answerMission(mission.id, text.slice(0, 600), 'continue', true); await onChanged(); })}>
                      {o}{c?.recommended && <span className="badge badge-info">추천</span>}
                    </button>
                  );
                })}
              </div>
              <div className="muted small">하나를 누르면 그 답으로 바로 이어서 진행합니다. 다른 답이면 아래 입력창에 적으세요.</div>
            </>
          )}
        </>
      )}
      <DecisionLog mission={mission} />
    </div>
  );
}

/**
 * 확인 필요 항목 고르기: 오퍼레이터가 낸 선택지 중 하나, 직접 적기, 나중에(고르지 않음).
 * 고른 결정은 미션에 남아 다음 계획부터 오퍼레이터·직원이 그대로 따른다. resume이면 고른 뒤 바로 이어서 진행한다.
 */
function GapPicker({ mission, gaps, resume, onChanged }: { mission: Mission; gaps: MissionGap[]; resume: boolean; onChanged: () => Promise<void> }) {
  const act = useAction();
  const [sel, setSel] = useState<Record<number, number | 'own'>>({});
  const [own, setOwn] = useState<Record<number, string>>({});
  const key = gaps.map((g) => `${g.doc}|${g.issue}`).join('\n');
  useEffect(() => { setSel({}); setOwn({}); }, [mission.id, key]);
  const picks: MissionPick[] = gaps.flatMap((g, i) => {
    const v = sel[i];
    if (v === 'own') return own[i]?.trim() ? [{ doc: g.doc, issue: g.issue, choice: own[i].trim() }] : [];
    if (typeof v === 'number' && g.options?.[v]) return [{ doc: g.doc, issue: g.issue, choice: g.options[v] }];
    return [];
  });
  const submit = () => act.run(async () => { await ws().decideMission(mission.id, picks, resume); await onChanged(); });
  return (
    <>
      {act.error && <Banner>{act.error}</Banner>}
      <ul className="gap-list pick-list">
        {gaps.map((g, i) => (
          <li key={`${g.doc}|${g.issue}`}>
            <strong>{g.doc || '문서 미지정'}</strong>
            <div>{g.issue}</div>
            {g.explain && <div className="gap-explain"><span className="gap-explain-label">쉽게 말하면</span>{g.explain}</div>}
            <GapRefs key={`${mission.id}|${g.doc}|${g.issue}`} missionId={mission.id} refs={gapRefs(g)} />
            {g.need && <div className="small">{g.options?.length ? '정할 내용' : '채울 내용'}: {g.need}</div>}
            <div className="pick-options" role="radiogroup" aria-label={`${g.doc || '문서 미지정'} 결정`}>
              {(g.options ?? []).map((o, j) => (
                <label key={j} className={`pick-option${sel[i] === j ? ' on' : ''}`}>
                  <input type="radio" name={`gap-${mission.id}-${i}`} checked={sel[i] === j} onChange={() => setSel((x) => ({ ...x, [i]: j }))} />
                  <span>{o}</span>
                </label>
              ))}
              {(g.options?.length ?? 0) > 0 && <label className={`pick-option${sel[i] === 'own' ? ' on' : ''}`}>
                <input type="radio" name={`gap-${mission.id}-${i}`} checked={sel[i] === 'own'} onChange={() => setSel((x) => ({ ...x, [i]: 'own' }))} />
                <span>직접 적기</span>
              </label>}
              <label className={`pick-option later${sel[i] === undefined ? ' on' : ''}`}>
                <input type="radio" name={`gap-${mission.id}-${i}`} checked={sel[i] === undefined} onChange={() => setSel((x) => { const n = { ...x }; delete n[i]; return n; })} />
                <span>나중에(보류)</span>
              </label>
            </div>
            {(sel[i] === 'own' || !g.options?.length) && (
              <textarea className="input pick-own" rows={2} value={own[i] ?? ''}
                placeholder={g.options?.length ? '정한 내용 — 오퍼레이터·직원이 이 문장을 그대로 따릅니다' : '보완할 내용을 적으세요 — 적으면 이 항목은 이 내용으로 확정되고, 비워 두면 나중에(보류)'}
                aria-label={g.options?.length ? '직접 적은 결정' : '보완할 내용'}
                onChange={(e) => { const v = e.target.value; setOwn((x) => ({ ...x, [i]: v })); if (!g.options?.length) setSel((x) => { const n = { ...x }; if (v.trim()) n[i] = 'own'; else delete n[i]; return n; }); }} />
            )}
          </li>
        ))}
      </ul>
      <div className="row gap wrap">
        <button className="btn btn-primary" disabled={act.busy || !picks.length} onClick={() => void submit()}>
          {resume ? `고른 대로 계속 진행${picks.length ? ` (${picks.length}건)` : ''}` : `고른 결정 반영${picks.length ? ` (${picks.length}건)` : ''}`}
        </button>
        <span className="muted small">{resume ? '고르지 않은 항목은 다음 계획에서 다시 확인 필요로 남습니다.' : '진행 중인 작업은 그대로 두고, 다음 계획부터 고른 결정을 그대로 따릅니다.'}</span>
      </div>
    </>
  );
}

/** 근거 위치: 오퍼레이터가 적은 refs, 없으면 문서 칸에 적힌 파일 경로(예: a/b.md:87)를 찾아 쓴다 */
function gapRefs(g: MissionGap): MissionRef[] {
  if (g.refs?.length) return g.refs;
  const out: MissionRef[] = [];
  for (const m of `${g.doc} ${g.issue}`.matchAll(/((?:[\w가-힣.-]+\/)*[\w가-힣.-]+\.(?:md|markdown|html?|json|txt|csv|ya?ml|tsx?|jsx?|py))(?::(\d+))?/g)) {
    if (!out.some((r) => r.path === m[1] && (r.line ?? null) === (m[2] ? Number(m[2]) : null))) out.push({ path: m[1], line: m[2] ? Number(m[2]) : null });
    if (out.length >= 4) break;
  }
  return out;
}

/** 근거 위치를 앱 안에서 바로 보기(해당 줄 앞뒤, 읽기 전용) · 기본 앱으로 열기 */
function GapRefs({ missionId, refs }: { missionId: string; refs: MissionRef[] }) {
  const act = useAction();
  const [open, setOpen] = useState<number | null>(null);
  const [snip, setSnip] = useState<RefSnippet | null>(null);
  const req = useRef(0);
  if (!refs.length) return null;
  const show = (i: number) => act.run(async () => {
    const my = ++req.current; // 늦게 온 이전 응답은 버린다
    if (open === i) { setOpen(null); setSnip(null); return; }
    const r = await ws().refSnippet(missionId, refs[i].path, refs[i].line ?? null);
    if (my === req.current) { setSnip(r); setOpen(i); }
  });
  return (
    <div className="gap-refs">
      {act.error && <Banner>{act.error}</Banner>}
      <div className="row gap wrap">
        <span className="muted small">근거 위치</span>
        {refs.map((r, i) => (
          <button key={i} className={`btn-link small gap-ref${open === i ? ' on' : ''}`} disabled={act.busy} onClick={() => void show(i)} title="누르면 이 부분을 바로 보여 줍니다">
            {r.path}{r.line ? `:${r.line}` : ''} {open === i ? '▴' : '▾'}
          </button>
        ))}
      </div>
      {open !== null && snip && (
        <div className="ref-snippet">
          <div className="row gap wrap ref-snippet-head">
            <span className="mono small grow">{snip.path}{snip.total ? ` · ${snip.total}줄` : ''}</span>
            {snip.exists && <button className="btn-link small" onClick={() => void act.run(async () => { const err = await ws().openPath(snip.path); if (err) throw new Error(err); })}>기본 앱으로 열기</button>}
            {snip.exists && <button className="btn-link small" onClick={() => void act.run(() => ws().revealInFinder(snip.path))}>폴더에서 보기</button>}
          </div>
          {snip.note ? <div className="muted small">{snip.note}</div> : (
            <pre className="ref-lines">{snip.lines.map((l, k) => {
              const n = snip.start + k;
              return <div key={n} className={n === snip.target ? 'hit' : ''}><span className="ln">{n}</span>{l || ' '}</div>;
            })}</pre>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 오퍼레이터의 직원 제안: 새 직원(포지션) 추가, 기존 직원의 역할·지시 변경. 그대로·고쳐서 적용하거나 무시한다.
 * 진행은 막지 않는다. 도구·명령 권한은 제안으로 바뀌지 않는다.
 */
function StaffProposalCard({ mission, agents, onChanged }: { mission: Mission; agents: Agent[]; onChanged: () => Promise<void> }) {
  const act = useAction();
  const [edit, setEdit] = useState<Record<string, { name: string; role: string; instructions: string } | undefined>>({});
  const pending = (mission.staffProposals ?? []).filter((p) => p.status === 'pending');
  const doneList = (mission.staffProposals ?? []).filter((p) => p.status !== 'pending');
  if (!pending.length && !doneList.length) return null;
  const resolve = (p: StaffProposal, action: 'apply' | 'dismiss') => act.run(async () => {
    await ws().resolveStaffProposal(mission.id, p.id, action, action === 'apply' ? edit[p.id] ?? null : null);
    setEdit((x) => { const n = { ...x }; delete n[p.id]; return n; });
    await onChanged();
  });
  return (
    <div className={`answer-card staff-card${pending.length ? '' : ' quiet'}`}>
      {pending.length > 0 && <strong>직원 제안 {pending.length}건 — 적용할지 골라 주세요(진행은 계속합니다)</strong>}
      {act.error && <Banner>{act.error}</Banner>}
      {pending.length > 0 && (
        <ul className="gap-list staff-list">
          {pending.map((p) => {
            const cur = p.kind === 'update' ? agents.find((a) => a.id === p.agentId) : undefined;
            const base = p.kind === 'add' && p.agentId ? agents.find((a) => a.id === p.agentId) : undefined;
            const e = edit[p.id];
            return (
              <li key={p.id}>
                <div><span className="staff-kind">{p.kind === 'add' ? '새 직원' : '역할·지시 변경'}</span> <strong>{p.kind === 'add' ? p.name : `${p.agentCode} ${cur?.name ?? p.name}`}</strong> <span className="muted small">사이클 {p.cycle}</span></div>
                <div className="gap-explain"><span className="gap-explain-label">왜 필요한가</span>{p.reason}</div>
                {e ? (
                  <div className="staff-edit">
                    <label className="small">이름<input className="input" value={e.name} onChange={(ev) => setEdit((x) => ({ ...x, [p.id]: { ...e, name: ev.target.value } }))} /></label>
                    <label className="small">역할<input className="input" value={e.role} onChange={(ev) => setEdit((x) => ({ ...x, [p.id]: { ...e, role: ev.target.value } }))} /></label>
                    <label className="small">업무 지시<textarea className="input" rows={6} value={e.instructions} onChange={(ev) => setEdit((x) => ({ ...x, [p.id]: { ...e, instructions: ev.target.value } }))} /></label>
                  </div>
                ) : (
                  <div className="staff-compare">
                    {p.kind === 'update' && cur && (
                      <div><div className="muted small">지금</div><div className="small"><strong>역할</strong> {cur.role}</div><pre className="staff-text">{cur.instructions}</pre></div>
                    )}
                    <div><div className="muted small">{p.kind === 'update' ? '제안' : '제안 내용'}</div><div className="small"><strong>역할</strong> {p.role || cur?.role}</div><pre className="staff-text">{p.instructions || cur?.instructions}</pre></div>
                  </div>
                )}
                {p.kind === 'add' && <div className="muted small">도구는 {base ? `${base.code} ${base.name}과 같게(Bash·웹 제외)` : '읽기·쓰기 기본'}로 시작하고, 명령 권한은 없습니다. 필요하면 직원 화면이나 확인 필요에서 따로 허용하세요.{p.workPaths.length ? ` 작업 폴더: ${p.workPaths.join(', ')}` : ''}</div>}
                <div className="row gap wrap">
                  <button className="btn btn-primary" disabled={act.busy} onClick={() => void resolve(p, 'apply')}>{e ? '고친 내용으로 적용' : '그대로 적용'}</button>
                  {!e && <button className="btn" disabled={act.busy} onClick={() => setEdit((x) => ({ ...x, [p.id]: { name: p.name || cur?.name || '', role: p.role || cur?.role || '', instructions: p.instructions || cur?.instructions || '' } }))}>고쳐서 적용</button>}
                  {e && <button className="btn" disabled={act.busy} onClick={() => setEdit((x) => { const n = { ...x }; delete n[p.id]; return n; })}>고치기 취소</button>}
                  <button className="btn" disabled={act.busy} onClick={() => void resolve(p, 'dismiss')}>무시</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {doneList.length > 0 && (
        <details className="decision-log">
          <summary className="small">처리한 직원 제안 {doneList.length}건</summary>
          <ul className="gap-list">{doneList.map((p) => <li key={p.id} className="small">{p.status === 'applied' ? '적용' : '무시'} · {p.result || (p.kind === 'add' ? `새 직원 '${p.name}'` : `${p.agentCode} 역할·지시 변경`)}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

/** 지금까지 고른 결정(이 미션에서 오퍼레이터·직원이 그대로 따르는 기준) */
function DecisionLog({ mission }: { mission: Mission }) {
  const ds = mission.decisions ?? [];
  if (!ds.length) return null;
  return (
    <details className="decision-log">
      <summary className="small">내가 고른 결정 {ds.length}건 — 이 미션에서 그대로 따릅니다</summary>
      <ul className="gap-list">
        {ds.map((d, i) => <li key={i} className="small"><strong>{d.doc || '문서 미지정'}</strong> · {d.issue}<div>→ {d.choice}</div></li>)}
      </ul>
    </details>
  );
}

/** 보류한 업무(확인 필요): 진행 중·완료 보고 미션에서 권한·환경 때문에 뺀 업무. 나머지 작업은 계속 진행한다. */
function ParkedCard({ mission, agents, onChanged }: { mission: Mission; agents: Agent[]; onChanged: () => Promise<void> }) {
  const act = useAction();
  const denials = mission.denials ?? []; const blockers = mission.blockers ?? []; const gaps = mission.gaps ?? [];
  if (!denials.length && !blockers.length && !gaps.length) return <div className="parked-decisions"><DecisionLog mission={mission} /></div>;
  return (
    <div className="answer-card parked-card">
      <strong>{denials.length || blockers.length ? `보류한 업무 ${denials.length + blockers.length}건 — 확인 필요(나머지 작업은 계속 진행합니다)` : '근거가 부족한 부분 — 확인 필요(할 수 있는 작업부터 진행합니다)'}</strong>
      {act.error && <Banner>{act.error}</Banner>}
      {denials.length > 0 && <DenialList mission={mission} agents={agents} />}
      {blockers.length > 0 && (
        <ul className="gap-list">
          {blockers.map((b, i) => (
            <li key={i}>
              <div><span className={`blocker-kind ${b.kind}`}>{b.kind === 'environment' ? '내 PC 환경' : '같은 실패 반복'}</span> <strong>{b.step}</strong></div>
              <div className="mono small denial-target">{b.reason}</div>
            </li>
          ))}
        </ul>
      )}
      {gaps.length > 0 && <GapPicker mission={mission} gaps={gaps} resume={false} onChanged={onChanged} />}
      {(denials.length > 0 || blockers.length > 0) && <div className="row gap wrap">
        <button className="btn btn-primary" disabled={act.busy} onClick={() => void act.run(async () => { await ws().retryParked(mission.id); await onChanged(); })}>해결했으니 다시 시도하게 하기</button>
        <span className="muted small">허용·수정을 마친 뒤 누르면 다음 계획부터 이 업무를 다시 시도합니다. 누르기 전에는 다시 계획하지 않습니다.</span>
      </div>}
      <DecisionLog mission={mission} />
    </div>
  );
}

/**
 * 권한 거부 항목과 바로 고치는 버튼: 명령은 그 직원의 허용 명령에, 프로젝트 밖 경로는 기획의 참고 문서(읽기 전용)에 넣는다.
 * 허용 범위는 사용자가 정한다 — 접두어는 고친 뒤 추가할 수 있다.
 */
function DenialList({ mission, agents }: { mission: Mission; agents: Agent[] }) {
  const act = useAction();
  const [done, setDone] = useState<Record<string, string>>({});
  const [edit, setEdit] = useState<Record<string, string>>({});
  // Windows판: Bash를 쓰지 않으므로 명령 허용 버튼이 없다(경로만 참고 문서로 연다)
  const addReference = (sig: string, path: string) => act.run(async () => {
    const pr = (await ws().listProjects()).find((x) => x.id === mission.projectId);
    if (!pr) throw new Error('프로젝트를 찾을 수 없습니다.');
    if (!pr.plan.referenceDocs.includes(path)) await ws().updatePlan(pr.id, { ...pr.plan, referenceDocs: [...pr.plan.referenceDocs, path] });
    await ws().saveLearning(null, { scope: 'project', projectId: mission.projectId, kind: 'environment', text: `프로젝트 밖 자료 ${path}는 참고 문서로 읽을 수 있다(사용자가 허용함)` }).catch(() => {});
    setDone((d) => ({ ...d, [sig]: `기획의 참고 문서에 넣었습니다(읽기 전용으로 열림).` }));
  });
  return (
    <>
      {act.error && <Banner>{act.error}</Banner>}
      <ul className="gap-list denial-list">
        {(mission.denials ?? []).map((d) => {
          const agent = agents.find((a) => a.id === d.agentId);
          const val = edit[d.sig] ?? d.suggestion ?? '';
          return (
            <li key={d.sig}>
              <div><strong>{d.agent}</strong> · <span className="mono small">{d.tool}</span></div>
              <div className="mono small denial-target">{d.target}</div>
              {done[d.sig] ? <div className="small ok-text">{done[d.sig]}</div>
                : d.kind === 'command' ? (
                  <div className="muted small">Windows판은 Claude의 Bash 도구를 쓰지 않습니다(OS 격리가 없음). 이 명령은 업무 흐름의 검사 단계로 실행하거나 직접 실행하세요.</div>
                ) : d.kind === 'path' && /^(\/|[A-Za-z]:\\)/.test(d.target) ? (
                  <div className="row gap wrap">
                    <button className="btn" disabled={act.busy} onClick={() => void addReference(d.sig, d.target)}>참고 문서에 추가</button>
                    <span className="muted small">프로젝트 밖 파일·폴더를 직원이 읽을 수 있게 엽니다(쓰기는 안 됨).</span>
                  </div>
                ) : <div className="muted small">앱 설정으로 허용할 수 없는 행위입니다. 지시를 바꿔 다른 방법으로 진행하세요.</div>}
              {agent && !agent.active && <div className="muted small">이 직원은 휴가 중입니다.</div>}
            </li>
          );
        })}
      </ul>
      <div className="muted small">허용한 뒤 아래에서 <strong>허용했으니 다시 시도</strong>를 누르세요. 허용하지 않으려면 바꿀 지시를 적어 계속하거나 여기서 종료하세요. 브라우저 실행처럼 격리 공간 밖이 필요한 일은 직접 실행하는 편이 확실합니다.</div>
    </>
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


// ───────── 이번 사이클 작업 흐름 ─────────
function CycleFlow({ detail, agents }: { detail: RunDetail; agents: Agent[] }) {
  const [selNode, setSelNode] = useState<string | null>(null);
  const flowNodes = useMemo(
    () =>
      toFlowNodes(autoLayout(detail.graph).nodes, agents, (n) => {
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

/** 사이클 히스토리: 사이클을 골라 그때의 작업 흐름(단계·상태·시도)을 본다. 기본은 가장 최근 사이클 */
function CycleHistory({ detail, agents, onOpenRun }: { detail: MissionDetail; agents: Agent[]; onOpenRun: (runId: string) => void }) {
  const list = [...detail.cycles].sort((a, b) => b.cycle - a.cycle || 0);
  const [sel, setSel] = useState<string | null>(null);
  const [limit, setLimit] = useState(10); // 사이클이 많아도 최근 것부터 몇 개만
  const cur = sel ?? detail.currentRun?.run.id ?? list[0]?.runId ?? null;
  const other = useLoad(() => (cur && cur !== detail.currentRun?.run.id ? ws().runDetail(cur) : Promise.resolve(null)), [cur, detail.currentRun?.run.id]);
  const run = cur && cur === detail.currentRun?.run.id ? detail.currentRun : other.data;
  if (!list.length) return <div className="muted small pad">아직 실행된 사이클이 없습니다. 오퍼레이터가 계획을 세우면 여기에 작업 흐름이 나타납니다.</div>;
  const at = list.find((c) => c.runId === cur);
  return (
    <div className="cycle-history">
      <div className="cycle-chips" role="tablist" aria-label="사이클 고르기">
        {list.filter((c, i) => i < limit || c.runId === cur).map((c) => (
          <button key={`${c.cycle}-${c.runId}`} role="tab" aria-selected={c.runId === cur} className={`cycle-chip${c.runId === cur ? ' is-on' : ''} st-${c.status}`} onClick={() => setSel(c.runId)} title={`사이클 ${c.cycle} · 흐름 v${c.graphVersion} · ${RUN_STATUS_LABEL[c.status]}`}>
            {c.cycle}<span className="cycle-dot" />
          </button>
        ))}
        {list.length > limit && <button className="btn-link small" onClick={() => setLimit((n) => n + 20)}>이전 사이클 {list.length - limit}개 더 보기</button>}
      </div>
      {at && (
        <div className="row between small cycle-history-head">
          <span>사이클 <b>{at.cycle}</b> · 흐름 v{at.graphVersion} <Badge tone={runTone(at.status)}>{RUN_STATUS_LABEL[at.status]}</Badge>{run?.run.executor === 'mock' && <Badge tone="mock">모의 실행</Badge>}</span>
          <button className="btn-link" onClick={() => onOpenRun(at.runId)}>실행 탭에서 자세히</button>
        </div>
      )}
      {run ? <CycleFlow detail={run} agents={agents} /> : <div className="muted small pad">{other.loading ? '불러오는 중…' : '이 사이클의 기록을 불러오지 못했습니다.'}</div>}
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

/** 기록 상세: 펼칠 때만 정리해서 그린다(기록이 많을 때 매번 JSON을 다시 해석하지 않게) */
function EventData({ data }: { data: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="collapsible" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary><span className="small">상세</span></summary>
      {open && <div className="collapsible-body"><pre className="pre small">{pretty(data)}</pre></div>}
    </details>
  );
}
const Timeline = memo(TimelineView, (a, b) => (a.files?.length ?? 0) === (b.files?.length ?? 0) && a.events.length === b.events.length && a.events.at(-1)?.seq === b.events.at(-1)?.seq && a.events[0]?.seq === b.events[0]?.seq);
function TimelineView({ events, files = [] }: { events: MissionEvent[]; files?: MissionFile[] }) {
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
            {e.data && e.data !== '{}' && e.data !== 'null' && <EventData data={e.data} />}
          </div>
        );
      })}
    </div>
  );
}
