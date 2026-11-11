import { useEffect, useState } from 'react';
import type { AppSettings, CliStatus, CodexStatus, Project } from '../../shared/types';
import { fmtDate, useAction, useLoad, ws } from '../api';
import { Markdown } from '../markdown';
import type { QueueInfo } from '../App';
import { Badge, Banner, Field, Loading, Modal, NumberInput } from './common';

export default function Sidebar(props: {
  projects: Project[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  cli: CliStatus | null;
  setCli: (c: CliStatus) => void;
  settings: AppSettings | null;
  setSettings: (s: AppSettings) => void;
  queue: QueueInfo | null;
}) {
  const [modal, setModal] = useState<null | 'cli' | 'settings' | 'help'>(null);
  // 운영 탭의 준비 항목에서 '설정 열기'를 누르면 설정 창을 연다
  useEffect(() => { const h = () => setModal('settings'); window.addEventListener('crewgenai:open-settings', h); return () => window.removeEventListener('crewgenai:open-settings', h); }, []);
  const { cli, settings, queue } = props;
  // 왼쪽 목록 접기(이 컴퓨터에만 기억)
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('crewgenai.sidebarCollapsed') === '1'; } catch { return false; } });
  const toggle = () => setCollapsed((c) => { const n = !c; try { localStorage.setItem('crewgenai.sidebarCollapsed', n ? '1' : '0'); } catch { /* 기억 못 해도 동작 */ } return n; });
  const [codex, setCodex] = useState<CodexStatus | null>(null);
  useEffect(() => {
    ws()
      .codexStatus(false)
      .then(setCodex)
      .catch(() => setCodex({ path: null, version: null, loggedIn: null, ready: false, problem: 'Codex 상태를 확인하지 못했습니다.', fix: null }));
  }, []);
  const mock = settings?.executor === 'mock';
  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <button className="side-toggle" onClick={toggle} title={collapsed ? '프로젝트 목록 펼치기' : '프로젝트 목록 접기'} aria-label={collapsed ? '프로젝트 목록 펼치기' : '프로젝트 목록 접기'} aria-expanded={!collapsed}>
        {collapsed ? '»' : '«'}
      </button>
      {collapsed ? (
        <div className="side-rail">
          <button className="rail-btn rail-new" onClick={() => props.onSelect('new')} title="새 프로젝트">+</button>
          <div className="rail-list">
            {props.projects.map((p) => (
              <button key={p.id} className={`rail-btn ${props.selectedId === p.id ? 'active' : ''}`} onClick={() => props.onSelect(p.id)} title={`${p.plan.name || '(이름 없음)'}\n${p.plan.folder}`}>
                {(p.plan.name || '?').trim().slice(0, 1)}
              </button>
            ))}
          </div>
          <div className="rail-bottom">
            <button className={`rail-btn rail-dot ${cli?.ready ? 'ok' : cli ? 'bad' : ''}`} onClick={() => setModal('cli')} title={`Claude CLI · ${!cli ? '확인 중…' : cli.ready ? '준비됨' : cli.problem ?? '준비 안 됨'}`}><span className="dot" /></button>
            <button className={`rail-btn rail-dot ${codex?.ready ? 'ok' : codex ? 'bad' : ''}`} onClick={() => setModal('settings')} title={`Codex 리뷰 · ${!codex ? '확인 중…' : codex.ready ? '준비됨' : codex.problem ?? '준비 안 됨'}`}><span className="dot" /></button>
            <button className="rail-btn" onClick={() => setModal('settings')} title="설정">⚙</button>
            <button className="rail-btn" onClick={() => setModal('help')} title="사용법·검증 결과">?</button>
          </div>
        </div>
      ) : (
      <>
      <div className="brand">
        <span className="brand-name">CREWGENAI</span>
        <span className="brand-sub">개발팀 관리 · 검토본 2026-11-10</span>
      </div>
      <button className="btn btn-primary block" onClick={() => props.onSelect('new')}>
        + 새 프로젝트
      </button>
      <div className="side-label">내 프로젝트</div>
      <div className="project-list">
        {props.loading && props.projects.length === 0 && <Loading />}
        {!props.loading && props.projects.length === 0 && <div className="muted small pad">아직 프로젝트가 없습니다.</div>}
        {props.projects.map((p) => (
          <button key={p.id} className={`project-item ${props.selectedId === p.id ? 'active' : ''}`} onClick={() => props.onSelect(p.id)} title={p.plan.folder}>
            <strong className="ellipsis">{p.plan.name || '(이름 없음)'}</strong>
            <small className="ellipsis">{p.plan.goal || p.plan.folder || '목표 미입력'}</small>
          </button>
        ))}
      </div>
      <div className="side-bottom">
        {queue && (
          <div className="queue-chip" title="등록된 직원 수와 별개로, 동시에 실행되는 작업 수">
            동시 실행 {queue.running}/{queue.max} · 대기 {queue.waiting}
            {queue.paused.length > 0 && ` · 일시정지 ${queue.paused.length}`}
          </div>
        )}
        {mock && <div className="mock-chip">모의 실행 모드 — 실제 Claude 작업 아님</div>}
        <button className={`cli-chip ${cli?.ready ? 'ok' : cli ? 'bad' : ''}`} onClick={() => setModal('cli')}>
          <span className="dot" />
          <span>
            <strong>Claude CLI</strong>
            <small>{!cli ? '확인 중…' : cli.ready ? `준비됨 · ${cli.version ?? ''}` : cli.problem ?? '준비 안 됨'}</small>
          </span>
        </button>
        <button className={`codex-line ${codex?.ready ? 'ok' : codex ? 'bad' : ''}`} onClick={() => setModal('settings')} title="Codex 리뷰 준비 상태 — 설정에서 확인">
          <span className="dot" />
          <small>
            Codex 리뷰 · {!codex ? '확인 중…' : codex.ready ? `준비됨${codex.version ? ` · ${codex.version}` : ''}` : codex.problem ?? '준비 안 됨'}
          </small>
        </button>
        <div className="row gap">
          <button className="btn grow" onClick={() => setModal('settings')}>
            설정
          </button>
          <button className="btn grow" onClick={() => setModal('help')}>
            사용법·검증 결과
          </button>
        </div>
      </div>
      </>
      )}
      {modal === 'cli' && <CliModal cli={cli} setCli={props.setCli} onClose={() => setModal(null)} />}
      {modal === 'settings' && settings && <SettingsModal settings={settings} setSettings={props.setSettings} codex={codex} setCodex={setCodex} onClose={() => setModal(null)} />}
      {modal === 'settings' && !settings && (
        <Modal title="설정" onClose={() => setModal(null)}>
          <Loading />
        </Modal>
      )}
      {modal === 'help' && <HelpModal onClose={() => setModal(null)} />}
    </aside>
  );
}

function CliModal({ cli, setCli, onClose }: { cli: CliStatus | null; setCli: (c: CliStatus) => void; onClose: () => void }) {
  const act = useAction();
  const [note, setNote] = useState<string | null>(null);
  return (
    <Modal title="Claude CLI 준비 상태" onClose={onClose}>
      {act.error && <Banner>{act.error}</Banner>}
      {note && <Banner kind="info">{note}</Banner>}
      {!cli ? (
        <Loading text="확인 중…" />
      ) : (
        <>
          <div className={`status-card ${cli.ready ? 'ok' : 'bad'}`}>
            <strong>{cli.ready ? '실행 준비됨' : '실행 준비 안 됨'}</strong>
            {cli.problem && <p>원인: {cli.problem}</p>}
            {cli.fix && <p>해결: {cli.fix}</p>}
          </div>
          <dl className="kv">
            <dt>실행 파일</dt>
            <dd className="mono">{cli.path ?? '찾지 못함'}</dd>
            <dt>찾은 위치</dt>
            <dd>{cli.source || '-'}</dd>
            <dt>버전</dt>
            <dd>{cli.version ?? '-'}</dd>
            <dt>로그인</dt>
            <dd>{cli.loggedIn === null ? '확인 못 함' : cli.loggedIn ? `됨 (${cli.authMethod ?? ''})` : '안 됨'}</dd>
            <dt>확인 시각</dt>
            <dd>{fmtDate(cli.checkedAt)}</dd>
          </dl>
          {cli.candidates.length > 0 && (
            <>
              <h3>발견한 CLI</h3>
              <ul className="small">
                {cli.candidates.map((c) => (
                  <li key={c.path}>
                    <span className="mono">{c.path}</span> — {c.source} {c.version ? `· ${c.version}` : ''}
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="muted small">
            이 앱은 Claude 모델을 포함하지 않습니다. 설치된 Claude CLI를 실행하며, 작업 중 인터넷 연결과 Claude 계정 로그인(또는 API 키)이 필요합니다.
          </p>
        </>
      )}
      <div className="row gap">
        <button className="btn" disabled={act.busy} onClick={() => act.run(async () => setCli(await ws().cliStatus(true)))}>
          {act.busy ? '확인 중…' : '다시 확인'}
        </button>
        <button className="btn" disabled={act.busy} onClick={() => act.run(async () => setCli(await ws().pickCliPath()))}>
          CLI 직접 선택…
        </button>
        <button
          className="btn"
          disabled={act.busy}
          onClick={() =>
            act.run(async () => {
              await ws().openLoginTerminal();
              setNote('터미널에서 로그인을 마친 뒤 “다시 확인”을 누르세요.');
            })
          }
        >
          터미널에서 로그인
        </button>
      </div>
    </Modal>
  );
}

function SettingsModal({ settings, setSettings, codex, setCodex, onClose }: { settings: AppSettings; setSettings: (s: AppSettings) => void; codex: CodexStatus | null; setCodex: (c: CodexStatus) => void; onClose: () => void }) {
  const [s, setS] = useState<AppSettings>(settings);
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const act = useAction();
  const [saved, setSaved] = useState(false);
  const save = () =>
    act.run(async () => {
      const keyArg = clearKey ? null : key.trim() ? key.trim() : undefined;
      const next = await ws().saveSettings(
        {
          executor: s.executor,
          maxConcurrent: s.maxConcurrent,
          langsmithEnabled: s.langsmithEnabled,
          langsmithProject: s.langsmithProject,
          langsmithEndpoint: s.langsmithEndpoint,
          codexModel: s.codexModel,
          codexEffort: s.codexEffort,
          missionMaxCycles: s.missionMaxCycles,
          gitCommits: s.gitCommits,
        },
        keyArg,
      );
      setSettings(next);
      setS(next);
      setKey('');
      setClearKey(false);
      setSaved(true);
    });
  return (
    <Modal title="설정" onClose={onClose}>
      {act.error && <Banner>{act.error}</Banner>}
      {saved && <Banner kind="ok">저장했습니다.</Banner>}
      <h3>실행 엔진</h3>
      <div className="radio-row">
        <label>
          <input type="radio" checked={s.executor === 'claude'} onChange={() => setS({ ...s, executor: 'claude' })} /> 실제 Claude CLI
        </label>
        <label>
          <input type="radio" checked={s.executor === 'mock'} onChange={() => setS({ ...s, executor: 'mock' })} /> 모의 실행(시험용)
        </label>
      </div>
      {s.executor === 'mock' && (
        <Banner kind="warn">
          모의 실행은 오류·복구 흐름 시험용 가짜 CLI입니다. 실제 Claude 작업을 수행하지 않으며, 모의 실행 결과는 실제 Agent 실행 완료로 보지 않습니다.
        </Banner>
      )}
      <Field label="동시 실행 한도" hint="등록된 직원 수와 별개입니다. 이 수를 넘는 작업은 대기열에서 차례로 실행됩니다.">
        <NumberInput value={s.maxConcurrent} min={1} onChange={(v) => setS({ ...s, maxConcurrent: Math.max(1, v ?? 1) })} />
      </Field>
      <h3>Codex 리뷰</h3>
      <p className="muted small">운영(오퍼레이터 루프)과 “Codex 리뷰” 단계는 설치된 Codex CLI를 읽기 전용으로 실행해 결과를 검토합니다.</p>
      {codex ? (
        <div className={`status-card ${codex.ready ? 'ok' : 'bad'}`}>
          <strong>{codex.ready ? 'Codex 준비됨' : 'Codex 준비 안 됨'}</strong>
          {codex.problem && <p>원인: {codex.problem}</p>}
          {codex.fix && <p>해결: {codex.fix}</p>}
          <dl className="kv">
            <dt>실행 파일</dt>
            <dd className="mono">{codex.path ?? '찾지 못함'}</dd>
            <dt>버전</dt>
            <dd>{codex.version ?? '-'}</dd>
            <dt>로그인</dt>
            <dd>{codex.loggedIn === null ? '확인 못 함' : codex.loggedIn ? '됨' : '안 됨'}</dd>
          </dl>
        </div>
      ) : (
        <Loading text="Codex 확인 중…" />
      )}
      <div className="row gap">
        <button className="btn" disabled={act.busy} onClick={() => act.run(async () => setCodex(await ws().codexStatus(true)))}>
          Codex 다시 확인
        </button>
      </div>
      <Field label="리뷰 모델" hint="기본 gpt-6.1-sol">
        <input className="input mono" value={s.codexModel ?? ''} placeholder="gpt-6.1-sol" onChange={(e) => setS({ ...s, codexModel: e.target.value })} />
      </Field>
      <Field label="추론 강도">
        <select className="input" value={s.codexEffort ?? 'high'} onChange={(e) => setS({ ...s, codexEffort: e.target.value })}>
          {['low', 'medium', 'high', 'xhigh'].map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </Field>
      <Field label="오퍼레이터 루프 최대 사이클" hint="이 수만큼 반복하면 계속할지 사용자에게 묻습니다(1–50).">
        <NumberInput value={s.missionMaxCycles ?? 5} min={1} onChange={(v) => setS({ ...s, missionMaxCycles: Math.min(50, Math.max(1, v ?? 1)) })} />
      </Field>
      <h3>git 커밋·스냅샷</h3>
      <label className="check">
        <input type="checkbox" checked={!!s.gitCommits} onChange={(e) => setS({ ...s, gitCommits: e.target.checked })} /> 직원별 git 커밋·미션 스냅샷 사용 (권장)
      </label>
      <p className="muted small">직원이 바꾼 파일만 그 직원 이름으로 커밋합니다. push는 하지 않습니다. 미션 시작과 사이클마다 git 태그 스냅샷을 남깁니다.</p>
      <h3>LangSmith 추적(선택)</h3>
      <p className="muted small">연결하지 않아도 로컬 실행·기록·검토는 모두 사용할 수 있습니다. 전송 시 비밀값·원문은 제거합니다.</p>
      <label className="check">
        <input type="checkbox" checked={s.langsmithEnabled} onChange={(e) => setS({ ...s, langsmithEnabled: e.target.checked })} /> LangSmith로 실행 추적 보내기
      </label>
      <Field label="프로젝트 이름">
        <input className="input" value={s.langsmithProject} onChange={(e) => setS({ ...s, langsmithProject: e.target.value })} />
      </Field>
      <Field label="엔드포인트">
        <input className="input mono" value={s.langsmithEndpoint} onChange={(e) => setS({ ...s, langsmithEndpoint: e.target.value })} />
      </Field>
      <Field label="API 키" hint={s.langsmithKeySet ? '키가 저장돼 있습니다(값은 표시하지 않음). 새로 입력하면 교체됩니다.' : '저장된 키 없음'}>
        <input className="input" type="password" autoComplete="off" value={key} placeholder={s.langsmithKeySet ? '••••••••(저장됨)' : ''} onChange={(e) => setKey(e.target.value)} />
      </Field>
      {s.langsmithKeySet && (
        <label className="check">
          <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} /> 저장된 키 삭제
        </label>
      )}
      <div className="row gap end">
        <button className="btn btn-primary" disabled={act.busy} onClick={save}>
          {act.busy ? '저장 중…' : '저장'}
        </button>
      </div>
    </Modal>
  );
}

function HelpModal({ onClose }: { onClose: () => void }) {
  const docs = useLoad(() => ws().helpDocs(), []);
  const [tab, setTab] = useState<'guide' | 'verification'>('guide');
  return (
    <Modal title="사용법·검증 결과" onClose={onClose} wide>
      <div className="tabs small-tabs">
        <button className={`tab ${tab === 'guide' ? 'active' : ''}`} onClick={() => setTab('guide')}>
          사용법
        </button>
        <button className={`tab ${tab === 'verification' ? 'active' : ''}`} onClick={() => setTab('verification')}>
          검증 결과
        </button>
      </div>
      {docs.loading && <Loading />}
      {docs.error && <Banner>{docs.error}</Banner>}
      {docs.data && (
        <div className="doc-scroll">
          <Markdown text={tab === 'guide' ? docs.data.guide : docs.data.verification} images={docs.data.images} />
          {!(tab === 'guide' ? docs.data.guide : docs.data.verification) && <Badge tone="warn">문서가 비어 있습니다</Badge>}
        </div>
      )}
    </Modal>
  );
}
