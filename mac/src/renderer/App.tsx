import { useEffect, useMemo, useState } from 'react';
import type { AppSettings, CliStatus, LiveEvent, Project } from '../shared/types';
import { errMsg, useLoad, ws } from './api';
import { Banner, Empty, Loading } from './components/common';
import Sidebar from './components/Sidebar';
import PlanTab from './components/PlanTab';
import AgentsTab from './components/AgentsTab';
import FlowTab from './components/FlowTab';
import RunTab from './components/RunTab';
import ReviewTab from './components/ReviewTab';
import MissionTab from './components/MissionTab';

type Tab = 'mission' | 'plan' | 'agents' | 'flow' | 'run' | 'review';
const TABS: { id: Tab; label: string }[] = [
  { id: 'mission', label: '운영' },
  { id: 'plan', label: '기획' },
  { id: 'agents', label: '직원' },
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
          if (id === 'new') setTab('plan');
        }}
        cli={cli}
        setCli={setCli}
        settings={settings}
        setSettings={setSettings}
        queue={queue}
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
            <div className="page-body">
              {tab === 'mission' && (
                <MissionTab
                  key={project.id}
                  project={project}
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
