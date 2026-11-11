import { useEffect, useMemo, useState } from 'react';
import type { AppSettings, Attention, AttentionItem, CliStatus, LiveEvent, Project } from '../shared/types';
import { errMsg, useLoad, ws } from './api';
import { Banner, Empty, Loading } from './components/common';
import Sidebar from './components/Sidebar';
import PlanTab from './components/PlanTab';
import AgentsTab from './components/AgentsTab';
import FlowTab from './components/FlowTab';
import RunTab from './components/RunTab';
import ReviewTab from './components/ReviewTab';
import MissionTab from './components/MissionTab';
import OfficeTab from './components/OfficeTab';

type Tab = 'mission' | 'plan' | 'agents' | 'office' | 'flow' | 'run' | 'review';
const TABS: { id: Tab; label: string }[] = [
  { id: 'mission', label: '운영' },
  { id: 'plan', label: '기획' },
  { id: 'agents', label: '직원' },
  { id: 'office', label: '사무실' },
  { id: 'flow', label: '업무 흐름' },
  { id: 'run', label: '실행' },
  { id: 'review', label: '결과물·검토' },
];

export type QueueInfo = { running: number; waiting: number; max: number; paused: string[] };

export default function App() {
  const projects = useLoad(() => ws().listProjects(), []);
  const [selectedId, setSelectedId] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<string | null>(null); // 기획 탭 템플릿 → 운영 탭 지시 칸
  const [tab, setTab] = useState<Tab>('mission');
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [queue, setQueue] = useState<QueueInfo | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [focusRunId, setFocusRunId] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);
  // 확인이 필요한 항목(에이전트가 스스로 풀 수 없는 것) — 실행·미션·배운 것이 바뀔 때마다 다시 읽는다
  const [attn, setAttn] = useState<Attention | null>(null);
  const [focusMission, setFocusMission] = useState<{ id: string; n: number } | null>(null);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const load = () => { ws().attention().then(setAttn).catch(() => {}); };
    load();
    const off = ws().onLive((e: LiveEvent) => { if (e.type === 'mission' || e.type === 'run' || e.type === 'learning') { if (t) clearTimeout(t); t = setTimeout(load, 400); } });
    return () => { off(); if (t) clearTimeout(t); };
  }, []);
  const openAttention = (it: AttentionItem) => {
    setSelectedId(it.projectId);
    if (it.missionId) { setTab('mission'); setFocusMission({ id: it.missionId, n: Date.now() }); }
    else if (it.runId) { setFocusRunId(it.runId); setTab(it.kind === 'review' ? 'review' : 'run'); }
  };

  useEffect(() => {
    let off: (() => void) | undefined;
    try {
      off = ws().onLive((e: LiveEvent) => {
        if (e.type === 'cli') setCli(e.status);
        if (e.type === 'queue') setQueue({ running: e.running, waiting: e.waiting, max: e.max, paused: e.paused });
      });
      setConnected(true);
    } catch (e) {
      setConnected(false);
      setGlobalError(errMsg(e));
    }
    ws()
      .cliStatus(false)
      .then(setCli)
      .catch((e) => setGlobalError(errMsg(e)));
    ws()
      .getSettings()
      .then(setSettings)
      .catch((e) => setGlobalError(errMsg(e)));
    return () => off?.();
  }, []);

  // 첫 프로젝트 자동 선택
  useEffect(() => {
    if (selectedId === null && projects.data) {
      setSelectedId(projects.data.length ? projects.data[0].id : 'new');
    }
  }, [projects.data, selectedId]);

  const project: Project | null = useMemo(
    () => (projects.data && selectedId && selectedId !== 'new' ? projects.data.find((p) => p.id === selectedId) ?? null : null),
    [projects.data, selectedId],
  );

  const onProjectSaved = async (p: Project) => {
    const isNew = selectedId === 'new';
    await projects.reload();
    setSelectedId(p.id);
    if (isNew) setTab('plan');
  };

  return (
    <div className="app">
      <Sidebar
        projects={projects.data ?? []}
        loading={projects.loading}
        selectedId={selectedId}
        onSelect={(id) => {
          setSelectedId(id);
          setFocusMission(null);
          if (id === 'new') setTab('plan');
        }}
        cli={cli}
        setCli={setCli}
        settings={settings}
        setSettings={setSettings}
        queue={queue}
        attention={attn}
      />
      <main className="main">
        {!connected && <Banner kind="error">앱 내부 연결이 끊겼습니다. 앱을 다시 실행하세요.</Banner>}
        {globalError && (
          <Banner kind="error" onClose={() => setGlobalError(null)}>
            {globalError}
          </Banner>
        )}
        {projects.error && <Banner kind="error">프로젝트 목록을 불러오지 못했습니다: {projects.error}</Banner>}
        {projects.loading && !projects.data ? (
          <Loading />
        ) : selectedId === 'new' ? (
          <div className="page">
            <header className="page-head">
              <div>
                <small className="muted">새 프로젝트</small>
                <h1>프로젝트 만들기</h1>
              </div>
            </header>
            <PlanTab project={null} onSaved={onProjectSaved} />
          </div>
        ) : !project ? (
          <Empty title="프로젝트를 선택하세요">왼쪽에서 프로젝트를 고르거나 “새 프로젝트”를 누르세요.</Empty>
        ) : (
          <div className="page">
            <header className="page-head">
              <div>
                <small className="muted">프로젝트 · 기획 v{project.planVersion}</small>
                <h1>{project.plan.name || '(이름 없음)'}</h1>
                <div className="muted small path-wrap mono" title={project.plan.folder}>
                  {project.plan.folder || '연결된 폴더 없음'}
                </div>
              </div>
              <nav className="tabs" role="tablist">
                {TABS.map((t) => (
                  <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
                    {t.label}
                  </button>
                ))}
              </nav>
            </header>
            <AttentionBar attn={attn} projectId={project.id} projects={projects.data ?? []} onOpen={openAttention} />
            <div className="page-body">
              {tab === 'mission' && (
                <MissionTab
                  key={project.id}
                  project={project}
                  focusMissionId={focusMission}
                  onOpenRun={(runId) => {
                    setFocusRunId(runId);
                    setTab('run');
                  }}
                  onGoTab={(t) => { if (t === 'settings') window.dispatchEvent(new CustomEvent('crewgenai:open-settings')); else setTab(t); }}
                  draft={draft}
                  onDraftUsed={() => setDraft(null)}
                />
              )}
              {tab === 'plan' && <PlanTab key={project.id} project={project} onSaved={onProjectSaved} onUseTemplate={(text) => { setDraft(text); setTab('mission'); }} />}
              {tab === 'agents' && <AgentsTab key={project.id} project={project} />}
              {tab === 'office' && <OfficeTab key={project.id} project={project} />}
              {tab === 'flow' && <FlowTab key={project.id} project={project} />}
              {tab === 'run' && (
                <RunTab
                  key={project.id}
                  project={project}
                  cli={cli}
                  settings={settings}
                  queue={queue}
                  focusRunId={focusRunId}
                  onOpenReview={(runId) => {
                    setFocusRunId(runId);
                    setTab('review');
                  }}
                />
              )}
              {tab === 'review' && <ReviewTab key={project.id} project={project} initialRunId={focusRunId} onOpenRun={(id) => { setFocusRunId(id); setTab('run'); }} />}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

const ATTN_LABEL: Record<AttentionItem['kind'], string> = { denied: '권한 필요', blocked: '해결 필요', gaps: '근거 문서 보완', question: '답변 필요', resume: '재개 선택', review: '팀장 검토' };
/** 확인이 필요한 일 — 에이전트가 스스로 풀 수 없어 멈춘 것을 화면 맨 위에 가장 먼저 보여 준다 */
function AttentionBar({ attn, projectId, projects, onOpen }: { attn: Attention | null; projectId: string; projects: Project[]; onOpen: (it: AttentionItem) => void }) {
  if (!attn || !attn.items.length) return null;
  const here = attn.items.filter((x) => x.projectId === projectId);
  const others = attn.items.filter((x) => x.projectId !== projectId);
  const first = here[0] ?? others[0];
  const pname = (id: string) => projects.find((p) => p.id === id)?.plan.name ?? '';
  return (
    <div className="attention-bar" role="alert">
      <span className="attention-count">확인 필요 {attn.items.length}</span>
      <span className="attention-kind">{ATTN_LABEL[first.kind]}</span>
      <span className="attention-label ellipsis">{first.projectId !== projectId ? `[${pname(first.projectId)}] ` : ''}{first.label}</span>
      <button className="btn btn-sm btn-primary" onClick={() => onOpen(first)}>지금 확인</button>
      {here.length > 1 && <span className="muted small">이 프로젝트 {here.length}건</span>}
      {others.length > 0 && first.projectId === projectId && <span className="muted small">다른 프로젝트 {others.length}건</span>}
    </div>
  );
}
