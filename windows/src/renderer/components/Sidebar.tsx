import LearningsModal from './LearningsModal';
import TelegramSettings from './TelegramSettings';
import { useEffect, useState } from 'react';
import type { AppSettings, CliStatus, CodexStatus, Project, Attention, SkillSource, UsagePaceView } from '../../shared/types';
import { fmtDate, useAction, useLoad, ws } from '../api';
import { Markdown } from '../markdown';
import type { QueueInfo } from '../App';
import { Badge, Banner, Field, Loading, Modal, NumberInput } from './common';

export default function Sidebar(props: {
  projects: Project[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  attention?: Attention | null;
  cli: CliStatus | null;
  setCli: (c: CliStatus) => void;
  settings: AppSettings | null;
  setSettings: (s: AppSettings) => void;
  queue: QueueInfo | null;
}) {
  const [modal, setModal] = useState<null | 'cli' | 'settings' | 'help' | 'learn'>(null);
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
  const count = (pid: string) => props.attention?.items.filter((x) => x.projectId === pid).length ?? 0;
  const toReview = props.attention?.learningsToReview ?? 0;
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
                {count(p.id) > 0 && <span className="attn-dot" aria-label={`확인 필요 ${count(p.id)}건`} />}
              </button>
            ))}
          </div>
          <div className="rail-bottom">
            <button className={`rail-btn rail-dot ${cli?.ready ? 'ok' : cli ? 'bad' : ''}`} onClick={() => setModal('cli')} title={`Claude CLI · ${!cli ? '확인 중…' : cli.ready ? '준비됨' : cli.problem ?? '준비 안 됨'}`}><span className="dot" /></button>
            <button className={`rail-btn rail-dot ${codex?.ready ? 'ok' : codex ? 'bad' : ''}`} onClick={() => setModal('settings')} title={`Codex 리뷰 · ${!codex ? '확인 중…' : codex.ready ? '준비됨' : codex.problem ?? '준비 안 됨'}`}><span className="dot" /></button>
            <button className="rail-btn" onClick={() => setModal('learn')} title={`배운 것${toReview ? ` · 검토 필요 ${toReview}` : ''}`}>✎{toReview > 0 && <span className="attn-dot" />}</button>
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
            <span className="row between gap"><strong className="ellipsis">{p.plan.name || '(이름 없음)'}</strong>{count(p.id) > 0 && <span className="attn-badge" title="확인이 필요한 일">{count(p.id)}</span>}</span>
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
        <button className="btn block learn-btn" onClick={() => setModal('learn')} title="지시·답변에서 배운 것 — 다음 지시와 다른 프로젝트에 반영">
          배운 것{toReview > 0 && <span className="attn-badge">검토 {toReview}</span>}
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
      {modal === 'learn' && <LearningsModal projects={props.projects} onClose={() => setModal(null)} />}
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
              setNote('명령 프롬프트 창에서 로그인을 마친 뒤 “다시 확인”을 누르세요.');
            })
          }
        >
          명령 프롬프트에서 로그인
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
  const [skills, setSkills] = useState<{ dirs: string[]; sources: SkillSource[] } | null>(null);
  const [skillsTouched, setSkillsTouched] = useState(false);
  useEffect(() => { ws().skillSources(null).then(setSkills).catch(() => setSkills({ dirs: [], sources: [] })); }, []);
  const [pace, setPace] = useState<UsagePaceView | null>(null);
  useEffect(() => { ws().usagePace().then(setPace).catch(() => setPace(null)); }, []);
  const setSkillDirs = (dirs: string[]) => act.run(async () => { setSkills(await ws().skillSources(dirs)); setSkillsTouched(true); });
  const addSkillDir = () => act.run(async () => { const p = await ws().pickSkillFolder(); if (p && skills && !skills.dirs.includes(p)) { setSkills(await ws().skillSources([...skills.dirs, p])); setSkillsTouched(true); } });
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
          autoAssist: s.autoAssist !== false,
          testLocalSockets: s.testLocalSockets === true,
          paceEnabled: s.paceEnabled !== false,
          paceReservePct: s.paceReservePct ?? 10,
          commandLevel: s.commandLevel ?? 'medium',
          ...(skillsTouched && skills ? { skillDirs: skills.dirs } : {}),
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
    <Modal title="설정" onClose={onClose} wide>
      {act.error && <Banner>{act.error}</Banner>}
      {saved && <Banner kind="ok">저장했습니다.</Banner>}
      <div className="settings-cols">
        <div>
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
      <h3>배우기</h3>
      <label className="check">
        <input type="checkbox" checked={s.learning !== false} onChange={(e) => setS({ ...s, learning: e.target.checked })} /> 대화에서 배우기 (권장)
      </label>
      <p className="muted small">미션을 끝내거나 종료할 때 지시·답변·추가 지시에서 배운 것을 정리해 이 PC에 저장하고, 다음 지시와 다른 프로젝트에 반영합니다. 정리할 때 Claude를 한 번 더 호출합니다. 배운 것은 왼쪽 아래 ‘배운 것’에서 고치거나 지울 수 있습니다.</p>
      <h3>git 커밋·스냅샷</h3>
      <label className="check">
        <input type="checkbox" checked={!!s.gitCommits} onChange={(e) => setS({ ...s, gitCommits: e.target.checked })} /> 직원별 git 커밋·미션 스냅샷 사용 (권장)
      </label>
      <p className="muted small">직원이 바꾼 파일만 그 직원 이름으로 커밋합니다. push는 하지 않습니다. 미션 시작과 사이클마다 스냅샷을 남깁니다(저장소 하나면 git 태그, 여러 저장소면 앱 기록).</p>
      <h3>자동 처리</h3>
      <label className="check">
        <input type="checkbox" checked={s.autoAssist !== false} onChange={(e) => setS({ ...s, autoAssist: e.target.checked })} /> 사람 손이 덜 가게 자동 처리 (권장)
      </label>
      <ul className="muted small auto-list">
        <li>저장소가 dev·main 등에 있으면 직원 변경을 거기에 커밋하지 않고 작업 브랜치(feat/crewgenai-미션)를 만들어 커밋합니다. push·PR·병합은 사람이 합니다.</li>
        <li>Bash를 가진 직원은 저장소에 있는 시험 명령(scripts/gradle.sh, scripts/check.sh, npm check)을 허용 없이 실행합니다. 네트워크는 막힌 채 내려받아 둔 의존성만 씁니다.</li>
        <li>파일을 쓰는 직원은 Skill을 기본으로 쓰고, 연결 폴더 저장소의 skills/·.claude/skills/도 스킬 폴더에 더합니다.</li>
        <li>사이클을 시작할 때 문서 저장소(빌드 파일이 없는 저장소)를 fast-forward로만 최신화합니다. 사용자 변경과 겹치면 그대로 둡니다.</li>
      </ul>
      <label className="check">
        <input type="checkbox" disabled={s.autoAssist === false} checked={s.testLocalSockets === true} onChange={(e) => setS({ ...s, testLocalSockets: e.target.checked })} /> 시험 명령에 로컬 소켓 허용 (Gradle·Spring 시험에 필요)
      </label>
      <p className="muted small">켜면 Gradle 시험이 격리 환경에서 돕니다. 대신 격리된 시험도 이 PC에서 켜져 있는 로컬 서비스(예: localhost의 프록시·DB·개발 서버)에 접속할 수 있게 됩니다. 외부 인터넷은 계속 막힙니다. 끄면 Gradle 시험은 ‘실행 못 함’으로 기록됩니다.</p>
      <h3>사용량 속도 조절 (Max 요금제)</h3>
      <label className="check">
        <input type="checkbox" checked={s.paceEnabled !== false} onChange={(e) => setS({ ...s, paceEnabled: e.target.checked })} /> 주간 한도를 초기화 시각까지 나눠 쓰기 (권장)
      </label>
      <ul className="muted small auto-list">
        <li>Claude CLI가 호출마다 알려 주는 실제 사용률(주간·5시간)로 판단합니다. 추정하지 않습니다.</li>
        <li>주간 창에서 지난 시간 비율만큼만 씁니다(주 초반 5%는 바로 허용). 앞서 있으면 따라잡을 때까지 새 사이클을 시작하지 않고, 5시간 사용률이 90% 이상이면 그 창이 풀릴 때까지 쉽니다. 진행 중인 단계는 끊지 않습니다.</li>
        <li>사용률은 계정 전체 값이라, 직접 쓰는 Claude 사용량도 포함됩니다. 그래서 아래 몫은 앱이 쓰지 않고 남깁니다.</li>
      </ul>
      <Field label="직접 쓸 몫·여유 (%)" hint="주간 한도 중 앱이 쓰지 않고 남길 몫. 0~50">
        <input className="input" type="number" min={0} max={50} value={s.paceReservePct ?? 10} onChange={(e) => setS({ ...s, paceReservePct: Number(e.target.value) })} />
      </Field>
      {pace && (
        <p className="muted small">
          지금: {pace.sevenDay ? `주간 ${Math.round(pace.sevenDay.utilization * 100)}% (초기화 ${fmtDate(pace.sevenDay.resetsAt)})` : '주간 사용률 미보고'}
          {pace.fiveHour ? ` · 5시간 ${Math.round(pace.fiveHour.utilization * 100)}% (초기화 ${fmtDate(pace.fiveHour.resetsAt)})` : ''}
          {pace.reportedAt ? ` · ${fmtDate(pace.reportedAt)} 기준` : ''} — {pace.text}
        </p>
      )}
      <h3>명령 허용 범위</h3>
      <p className="muted small">Windows판은 직원에게 Bash(명령 실행)를 주지 않으므로 이 설정은 쓰이지 않습니다. 시험·빌드는 업무 흐름의 검사 단계로 앱이 실행합니다.</p>
      <div className="radio-row">
        <label><input type="radio" checked={s.commandLevel === 'low'} onChange={() => setS({ ...s, commandLevel: 'low' })} /> 낮음</label>
        <label><input type="radio" checked={(s.commandLevel ?? 'medium') === 'medium'} onChange={() => setS({ ...s, commandLevel: 'medium' })} /> 중간 (권장)</label>
        <label><input type="radio" checked={s.commandLevel === 'high'} onChange={() => setS({ ...s, commandLevel: 'high' })} /> 높음</label>
      </div>
      <ul className="muted small auto-list">
        <li><b>낮음</b>: 직원 설정의 허용 명령과 저장소 시험 명령만. 그 밖의 명령은 '확인 필요'로 올라옵니다.</li>
        <li><b>중간</b>: 위에 더해 조회·탐색(ls·find·grep·cat·git log 등), 파일 정리(mkdir·cp·mv), 빌드·시험 도구(npm run·npx tsc·pytest·gradle·make 등)를 묻지 않고 허용. 파일을 쓰는 직원에게 Bash를 줍니다.</li>
        <li><b>높음</b>: 거의 모든 명령을 허용. 권한 상승(sudo)·원격 접속·전송(ssh·curl)·git push·앱 실행(open·osascript)·키체인·시스템 설정·프로세스 종료만 막습니다.</li>
        <li>어느 범위든 명령은 프로젝트 격리 복사본 안에서 네트워크 없이 돌고, 수정 허용 범위 밖 변경은 실제 프로젝트에 반영되지 않습니다.</li>
        <li>높음의 차단 목록은 보조 장치입니다(경로를 바꾸거나 다른 명령으로 감싸는 우회를 완전히 막지는 못함). 실제 보호는 격리입니다: 네트워크 없음, 쓰기는 복사본·임시 폴더만. 다만 같은 사용자 권한으로 도는 다른 프로그램을 종료하는 것 같은 일은 격리가 막지 못할 수 있으니, 낯선 저장소에서는 중간을 쓰세요.</li>
      </ul>
      <h3>스킬 폴더</h3>
      <p className="muted small">직원 설정에서 도구 ‘Skill’을 켠 직원(자동 처리가 켜져 있으면 파일을 쓰는 직원도)이 이 폴더의 스킬을 씁니다. 실행할 때마다 스킬 파일만 읽기 전용 사본으로 넘기며, 플러그인의 훅·MCP·명령은 가져오지 않습니다. 스킬을 써도 직원 권한(수정 폴더·Bash 허용 명령·웹)은 그대로입니다.</p>
      {!skills && <p className="muted small">스킬 폴더 확인 중…</p>}
      {skills && skills.sources.length === 0 && <p className="muted small">지정한 스킬 폴더가 없습니다. 이 경우 Claude CLI 기본 제공 스킬만 씁니다.</p>}
      {skills && skills.sources.map((src) => (
        <div key={src.path} className="skill-src">
          <div className="skill-src-head">
            <code className="mono small">{src.path}</code>
            <button className="btn small" onClick={() => setSkillDirs(skills.dirs.filter((d) => d !== src.path))}>빼기</button>
          </div>
          <div className="muted small">{src.ok ? `스킬 ${src.skills.length}개: ${src.skills.slice(0, 12).join(', ')}${src.skills.length > 12 ? ' …' : ''}` : src.note}</div>
        </div>
      ))}
      <div className="row"><button className="btn small" onClick={addSkillDir} disabled={!skills}>스킬 폴더 추가</button>{skillsTouched && <span className="muted small">저장해야 반영됩니다.</span>}</div>
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
        </div>
        <div>
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
      <Field label="결과 정리 주기(사이클)" hint="이 수만큼 반복할 때마다 지금까지의 결과를 확인함에 정리해 올립니다. 개발은 멈추지 않습니다(1–50).">
        <NumberInput value={s.missionMaxCycles ?? 5} min={1} onChange={(v) => setS({ ...s, missionMaxCycles: Math.min(50, Math.max(1, v ?? 1)) })} />
      </Field>
      <h3>텔레그램</h3>
      <p className="muted small">휴대폰 텔레그램에서 진행 상황 확인, 결정·검토, 커밋 승인, 추가 지시를 처리합니다. 텔레그램에서 처리한 내용은 앱과 미션에 그대로 반영됩니다(아래 항목은 바로 적용).</p>
      <TelegramSettings />
        </div>
      </div>
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
