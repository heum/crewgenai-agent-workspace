// 사무실 — 따뜻한 도트 그림 개발 스튜디오에서 직원들이 실제 미션 상태대로 일하는 모습을 보여 준다.
// 원칙: 인물의 위치·자세·말풍선은 실제 실행 정보(작업 중·검토·리뷰 받음·대기·휴식·휴가)에서만 나온다. 임의의 진행률·완료 표시는 없다.
// 시간대(아침·오후·저녁·밤)는 창밖·햇빛·조명 같은 분위기만 바꾸고 직원 상태는 바꾸지 않는다.
// 글자(이름·상태·말풍선)는 그림 위에 HTML로 겹쳐 읽기 좋은 크기를 유지한다(그림만 창 크기에 맞춰 커지고 작아진다).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Attempt, LiveEvent, Mission, Project, WorkingItem } from '../../shared/types';
import { MISSION_STATUS_LABEL } from '../../shared/types';
import { useAction, useLoad, ws } from '../api';
import { characterOf, EXTERNAL, type CharDef } from '../characters';
import { RHEAD_H as HEAD_H, RHEAD_W as HEAD_W } from '../artRetro';
import { CharSprite } from './CharacterArt';
import { Banner, Loading, Modal } from './common';
import { useFileOpener } from './fileOpen';
import { layoutFor, MIN_W, pickScale, placePeople, propOf, reviewGroups, Scene, WALL, type Group, type Person, type Pose, type State } from './officeScene';
import OfficeCompare from './OfficeCompare';
import ResultsPanel, { missionTitle } from './Results';
import { moodFor, TIME_MODES, type TimeMode } from './officeTime';

/** 얼굴 사진(정수 배율): size는 대략의 높이(px) */
function Portrait({ char, size = 28 }: { char: CharDef; size?: number }) {
  const k = Math.max(1, Math.floor(size / HEAD_H));
  return <span className="ofc-portrait" style={{ width: HEAD_W * k + 4, height: HEAD_H * k + 4 }}><CharSprite def={char} size={HEAD_H * k} head /></span>;
}

const STATE_LABEL: Record<State, string> = { work: '작업 중', review: '리뷰', wait: '대기', rest: '휴식', off: '휴가' };
const POSE_LABEL: Record<Pose, string> = { code: '코딩 중', doc: '문서 작성 중', plan: '계획·판단 중', review: '검토 중', reviewed: '리뷰 받는 중', wait: '대기 중', rest: '휴식 중', off: '휴가 중' };
const BUBBLE: Partial<Record<Pose, string>> = { code: '코딩 시작', doc: '문서 작성 시작', plan: '계획 시작', review: '검토 시작', reviewed: '리뷰 받는 중' }; // 대기·휴식으로 바뀔 때는 띄우지 않는다
const RECEIVE_LABEL: Record<WorkingItem['kind'], string> = { author: '작성', reviewer: '독립 검토를 받는 중', codex: 'Codex 리뷰를 받는 중', check: '자동 검사를 받는 중', operator: '' };
const ACTIVE: Mission['status'][] = ['planning', 'running', 'evaluating'];

// ───── 화면 ─────
const store = { get(k: string) { try { return localStorage.getItem(k); } catch { return null; } }, set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* 저장 못 함 */ } } };
function hhmm(iso: string | Date) { try { return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }); } catch { return ''; } }
const openDecisions = () => window.dispatchEvent(new CustomEvent('crewgenai:open-decisions'));

export default function OfficeTab({ project }: { project: Project }) {
  const agents = useLoad(() => ws().listAgents(project.id), [project.id]);
  const [working, setWorking] = useState<WorkingItem[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [asks, setAsks] = useState(0);
  const [ready, setReady] = useState(false); // 첫 실행 정보를 받기 전에는 상태 변화 말풍선을 띄우지 않는다
  useEffect(() => {
    let alive = true; let t: ReturnType<typeof setTimeout> | null = null;
    setReady(false);
    const load = () => {
      ws().workingNow(project.id).then((w) => { if (alive) { setWorking(w); setReady(true); } }).catch(() => {});
      ws().listMissions(project.id).then((m) => { if (alive) setMissions(m); }).catch(() => {});
      ws().pendingDecisions().then((d) => { if (alive) setAsks(d.filter((x) => x.projectId === project.id).length); }).catch(() => {});
    };
    load();
    const off = ws().onLive((e: LiveEvent) => { if (['attempt', 'run', 'mission', 'node', 'missionEvent'].includes(e.type)) { if (t) clearTimeout(t); t = setTimeout(load, 300); } });
    const iv = setInterval(load, 8000);
    return () => { alive = false; off(); clearInterval(iv); if (t) clearTimeout(t); };
  }, [project.id]);

  // 시간대 분위기: 기본은 지금 시각. 사용자가 고정·끄기를 고를 수 있다(이 PC에만 기억).
  const [timeMode, setTimeMode] = useState<TimeMode>(() => (TIME_MODES.some((m) => m.id === store.get('crewgenai.office.time')) ? store.get('crewgenai.office.time') as TimeMode : 'auto'));
  const [still, setStill] = useState(() => store.get('crewgenai.office.still') === '1');
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const iv = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(iv); }, []);
  const { mood } = moodFor(timeMode, now);

  const current = useMemo(() => missions.find((m) => ACTIVE.includes(m.status)) ?? missions.find((m) => m.status === 'waiting_user') ?? missions[0] ?? null, [missions]);
  const limited = missions.find((m) => m.limitUntil && ['planning', 'running', 'evaluating', 'waiting_user'].includes(m.status));
  const liveCount = missions.filter((m) => ACTIVE.includes(m.status)).length;

  const people = useMemo<Person[]>(() => {
    const denials = current ? (current.denials ?? []) : [];
    const blockers = current ? (current.blockers ?? []) : [];
    const sorted = [...(agents.data ?? [])].sort((a, b) => a.code.localeCompare(b.code, 'ko', { numeric: true }));
    const out: Person[] = sorted.map((a) => {
      const jobs = working.filter((w) => w.agentId === a.id);
      const received = working.filter((w) => w.reviewOf === a.id && w.agentId !== a.id);
      let state: State; let pose: Pose; let task: string; let since: string | null = null; let reviewOf: string | null = null;
      if (jobs.length) { // 실제 실행 중인 일이 있으면 휴가 설정보다 우선한다(실행 기록과 화면이 어긋나지 않게)
        const j = jobs[0]; since = j.since;
        if (j.kind === 'reviewer') { state = 'review'; pose = 'review'; reviewOf = j.reviewOf ?? null; } else { state = 'work'; pose = j.kind === 'operator' ? 'plan' : j.mode === 'doc' ? 'doc' : 'code'; }
        task = `${j.task}${jobs.length > 1 ? ` 외 ${jobs.length - 1}건` : ''}`;
      } else if (!a.active) { state = 'off'; pose = 'off'; task = '휴가 — 업무를 배정하지 않습니다'; }
      else if (received.length) { state = 'review'; pose = 'reviewed'; since = received[0].since; task = `${RECEIVE_LABEL[received[0].kind]}: ${received[0].task}`; }
      else if (limited) { state = 'rest'; pose = 'rest'; task = `사용 한도 휴식${limited.limitUntil ? ` · ${hhmm(limited.limitUntil)}에 다시 시작` : ''}`; }
      else if (liveCount) { state = 'wait'; pose = 'wait'; task = '진행 중인 미션에서 차례를 기다리는 중'; }
      else { state = 'rest'; pose = 'rest'; task = '진행 중인 미션이 없습니다'; }
      const mine = denials.filter((d) => d.agentId === a.id);
      const steps = blockers.filter((b) => b.step.includes(`(${a.code} `) || b.step.includes(`${a.code} ${a.name}`)).map((b) => `${b.step}: ${b.reason}`);
      return { key: a.id, agent: a, code: a.code, name: a.name, role: a.role, char: characterOf(a), prop: propOf(a), state, pose, task, since, external: false, blocked: mine, blockedSteps: steps, asks: a.code === '00' && asks > 0, reviewOf };
    });
    working.filter((w) => w.kind === 'codex').forEach((w, i) => out.push({
      key: `codex-${i}`, agent: null, code: `CX${i + 1}`, name: `Codex 리뷰어 ${i + 1}`, role: '외부 검토자(Codex CLI) — 결과물을 읽기 전용으로 검토', char: EXTERNAL[i % EXTERNAL.length], prop: 'redpen',
      state: 'review', pose: 'review', task: w.task, since: w.since, external: true, blocked: [], blockedSteps: [], asks: false, reviewOf: w.reviewOf ?? null,
    }));
    return out;
  }, [agents.data, working, liveCount, limited, current, asks]);

  const staff = people.filter((p) => !p.external && p.state !== 'off');
  const internal = people.filter((p) => !p.external);
  const externals = people.filter((p) => p.external);
  // 그림 배율: 그림 한 칸이 실제 화면 화소 정수 개가 되는 값 중(예: 보통 화면 2배, 레티나 1.5·2배) 장면 전체가 들어가는 가장 큰 값.
  // 장면의 칸 수는 무대 크기에서 계산하므로 옆·아래에 빈 여백이 남지 않는다(고정 그림을 늘리지 않음).
  const [compare, setCompare] = useState(false); // 디자인 비교(예시 상태)
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stage, setStage] = useState<{ w: number; h: number; dpr: number }>({ w: 0, h: 0, dpr: 1 });
  useLayoutEffect(() => {
    const el = stageRef.current; if (!el) return;
    const fit = () => { const r = el.getBoundingClientRect(); setStage((o) => (o.w === Math.floor(r.width) && o.h === Math.floor(r.height) && o.dpr === (window.devicePixelRatio || 1) ? o : { w: Math.floor(r.width), h: Math.floor(r.height), dpr: window.devicePixelRatio || 1 })); };
    fit();
    const ro = new ResizeObserver(fit); ro.observe(el);
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`); mq.addEventListener('change', fit);
    return () => { ro.disconnect(); mq.removeEventListener('change', fit); };
  }, [agents.data, compare]); // 비교 화면을 닫으면 무대가 다시 생기므로 다시 관찰
  const offCount = internal.filter((p) => p.state === 'off').length;
  const groupSizes = useMemo(() => reviewGroups(people).map((g) => g.reviewers.length), [people]);
  // 배율: 라운지에 앉을 사람이 자리 밖으로 넘치면 한 단계 작게 그려 모두 앉힌다(가장 작은 배율이면 그대로)
  const { scale, layout, plan } = useMemo(() => {
    if (!stage.w) { const L = layoutFor(staff.length, MIN_W, 300, offCount); return { scale: 3, layout: L, plan: placePeople(people, staff, L) }; }
    const d = stage.dpr > 0 ? stage.dpr : 1;
    // 배율은 '모두가 라운지에 있는 경우'로 정한다: 누가 일어나고 앉을 때마다 배율이 바뀌어 사무실이 갑자기 달라지지 않게
    const allRest = staff.map((x) => ({ ...x, state: 'rest' as const, pose: 'rest' as const }));
    let r = pickScale(stage.w, stage.h, stage.dpr, staff.length, offCount, groupSizes);
    while (placePeople(allRest, allRest, r.layout).overflow.lounge.length && r.scale > (d >= 2 ? Math.ceil(1.5 * d) : Math.ceil(2 * d)) / d) {
      const next = pickScale(stage.w, stage.h, stage.dpr, staff.length, offCount, groupSizes, r.scale - 1 / d);
      if (next.scale >= r.scale) break;
      r = next;
    }
    return { ...r, plan: placePeople(people, staff, r.layout) };
  }, [stage, staff, people, offCount, groupSizes.join()]);
  const { placed, overflow } = plan;
  // 누르면 잠깐 손을 흔든다(장식). 상태·실행 기록은 바꾸지 않는다
  const [waving, setWaving] = useState<string | null>(null);
  const waveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (waveTimer.current) clearTimeout(waveTimer.current); }, []);
  const [group, setGroup] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState<'lounge' | 'review' | null>(null);
  const count = (s: State) => internal.filter((p) => p.state === s).length;
  const order: State[] = ['work', 'review', 'wait', 'rest', 'off'];

  // 선택: 지도·목록 어느 쪽에서 골라도 같은 직원
  const [sel, setSel] = useState<string | null>(null);
  const [ping, setPing] = useState(0);
  useEffect(() => { if (sel && !people.some((p) => p.key === sel)) setSel(null); }, [people, sel]);
  const selected = people.find((p) => p.key === sel) ?? null;
  const pickPerson = (k: string) => {
    setSel(k); setGroup(null); setTab('staff'); setMoreOpen(null);
    if (still) return;
    setWaving(k); if (waveTimer.current) clearTimeout(waveTimer.current);
    waveTimer.current = setTimeout(() => setWaving(null), 1400);
  };
  const selGroup = plan.groups.find((g) => g.key === group) ?? null;

  // 상태가 바뀔 때만 잠깐 말풍선(첫 화면에서는 띄우지 않음)
  const prev = useRef<Map<string, Pose> | null>(null);
  const [bubbles, setBubbles] = useState<Record<string, string>>({});
  const bubbleTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => () => { for (const t of bubbleTimers.current.values()) clearTimeout(t); }, []);
  useEffect(() => {
    if (!ready || !agents.data) return;
    const before = prev.current; const nowMap = new Map(people.map((p) => [p.key, p.pose]));
    prev.current = nowMap;
    if (!before) return;
    const add: Record<string, string> = {};
    for (const p of people) { const was = before.get(p.key); if (was && was !== p.pose && BUBBLE[p.pose]) add[p.key] = BUBBLE[p.pose]!; }
    // 상태가 다시 바뀌면 그 직원의 말풍선은 지운다(지난 상태 말풍선이 남지 않게)
    const changed = people.filter((p) => { const was = before.get(p.key); return was && was !== p.pose; }).map((p) => p.key);
    if (!changed.length) return;
    setBubbles((b) => { const n = { ...b }; for (const k of changed) delete n[k]; return { ...n, ...add }; });
    for (const k of changed) { const old = bubbleTimers.current.get(k); if (old) clearTimeout(old); bubbleTimers.current.delete(k); }
    for (const k of Object.keys(add)) bubbleTimers.current.set(k, setTimeout(() => { bubbleTimers.current.delete(k); setBubbles((b) => { const n = { ...b }; delete n[k]; return n; }); }, 6000));
  }, [people, ready, agents.data]);


  const [tab, setTab] = useState<'staff' | 'results'>('staff');
  const reduce = still;
  const timeLabel = timeMode === 'off' ? '시간 효과 꺼짐' : timeMode === 'auto' ? `${hhmm(now)} · ${mood.label}` : `${mood.label} 분위기(미리 보기)`;

  return (
    <div className={`ofc${reduce ? ' ofc-still' : ''}`}>
      <header className="ofc-top">
        <div className="ofc-mission">
          <span className="ofc-eyebrow">미션</span>
          {current ? (
            <>
              <strong className="ofc-mission-title" title={current.prompt}>{missionTitle(current)}</strong>
              <span className={`ofc-pill ofc-pill-${ACTIVE.includes(current.status) ? 'live' : current.status === 'waiting_user' ? 'ask' : 'idle'}`}>{MISSION_STATUS_LABEL[current.status]} · 사이클 {current.cycle}</span>
            </>
          ) : <span className="muted">진행 중인 미션 없음</span>}
        </div>
        <div className="ofc-head-row">
          <span className="ofc-headcount">직원 {internal.length}명{externals.length ? ` · 외부 리뷰어 ${externals.length}명` : ''}</span>
          <div className="ofc-counts" aria-label="직원 상태별 인원(외부 리뷰어 제외)">
            {order.map((s) => <span key={s} className={`ofc-count ofc-count-${s}`}>{STATE_LABEL[s]} <b>{count(s)}</b></span>)}
          </div>
          {asks > 0 ? <button className="ofc-ask" onClick={openDecisions}>확인 필요 <b>{asks}</b></button> : <span className="ofc-ask-none">확인할 일 없음</span>}
          <div className="ofc-time">
            <span className="ofc-clock">{timeLabel}</span>
            <select aria-label="시간대 분위기" value={timeMode} onChange={(e) => { const v = e.target.value as TimeMode; setTimeMode(v); store.set('crewgenai.office.time', v); }}>
              {TIME_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            <button className={`btn btn-sm${compare ? ' btn-primary' : ''}`} onClick={() => setCompare((v) => !v)} title="같은 구역을 A안·B안으로 비교(예시 상태)">디자인 비교</button>
            <label className="ofc-still-toggle"><input type="checkbox" checked={still} onChange={(e) => { setStill(e.target.checked); store.set('crewgenai.office.still', e.target.checked ? '1' : '0'); }} /> 움직임 줄이기</label>
          </div>
        </div>
      </header>
      {agents.loading && !agents.data && <Loading />}
      {agents.error && <Banner>{agents.error}</Banner>}
      {agents.data && internal.length === 0 && <div className="ofc-empty">아직 직원이 없습니다. 직원 탭에서 기본 템플릿을 불러오세요.</div>}
      {compare && <OfficeCompare still={still} onClose={() => setCompare(false)} />}
      {!compare && internal.length > 0 && (
        <div className="ofc-body">
          <div className="ofc-left">
          <div className="ofc-stage" ref={stageRef}>
            <div className="ofc-canvas" style={{ width: layout.W * scale, height: layout.H * scale }} data-scale={scale}>
              <Scene people={people} staff={staff} layout={layout} plan={plan} mood={mood} selected={sel} waving={waving} still={still} selectedGroup={group} onGroup={(k) => { setGroup(k); setSel(null); setTab('staff'); }} />
              <div className="ofc-overlay">
                <span className="ofc-zone" style={{ left: 4 * scale, top: (WALL + 1) * scale }}>업무 공간</span>
                <span className="ofc-zone" style={{ left: (layout.review.x + 2) * scale, top: (layout.review.y + 1) * scale }}>리뷰룸{plan.groups.length ? ` · ${plan.groups.length}건` : ''}</span>
                <span className="ofc-zone" style={{ left: (layout.lounge.x + 2) * scale, top: (layout.lounge.y + 1) * scale }}>라운지</span>
                {count('off') > 0 && (() => { const c = layout.wall.find((w) => w.kind === 'cork'); return c ? <span className="ofc-zone ofc-zone-sm" style={{ left: (c.x + c.w / 2) * scale, top: 22 * scale, transform: 'translateX(-50%)' }}>휴가 {count('off')}명</span> : null; })()}
                {staff.map((p, i) => {
                  const d = layout.desks[i]; const at = placed.find((x) => x.p.key === p.key);
                  return <Tag key={`t${p.key}`} p={p} left={(d.x + 25) * scale} top={(d.y + 23) * scale} max={48 * scale} on={sel === p.key} dim={at?.zone !== 'desk'} onPick={() => pickPerson(p.key)} />;
                })}
                {placed.filter((x) => x.zone !== 'desk').map(({ p, x, y, w, h, zone, group: gk }) => {
                  const pd = zone === 'review' ? plan.review.pods.find((q) => q.key === gk) : null;
                  const top = pd ? (pd.y + pd.pod.h + 1) * scale : (y + h + 1) * scale;
                  // 리뷰 탁자: 리뷰받는 직원 이름표는 그 사람 오른쪽 끝에 맞춰 왼쪽으로, 검토자 이름표는 그 사람 왼쪽 끝에서 오른쪽으로 펼쳐 서로 겹치지 않게
                  const role = pd ? (pd.author === p.key ? 'author' as const : p.external ? 'codex' as const : 'reviewer' as const) : undefined;
                  const left = !pd ? (x + w / 2) * scale : role === 'author' ? (x + w) * scale : (x + 1) * scale;
                  return <Tag key={`r${p.key}`} p={p} left={left} top={top} max={44 * scale} align={!pd ? 'center' : role === 'author' ? 'end' : 'start'} on={sel === p.key} onPick={() => pickPerson(p.key)} small role={role} />;
                })}
                {overflow.review.length > 0 && <button className="ofc-zone ofc-zone-sm ofc-more" style={{ right: (layout.W - layout.review.x - layout.review.w + 4) * scale, top: (layout.review.y + 1) * scale }} onClick={() => setMoreOpen(moreOpen === 'review' ? null : 'review')}>리뷰 자리 밖 {overflow.review.length}명 · 목록</button>}
                {overflow.lounge.length > 0 && <button className="ofc-zone ofc-zone-sm ofc-more" style={{ left: (layout.lounge.x + layout.lounge.w - 4) * scale, top: (layout.H - 2) * scale, transform: 'translate(-100%, -100%)' }} onClick={() => setMoreOpen(moreOpen === 'lounge' ? null : 'lounge')}>휴식 자리 밖 {overflow.lounge.length}명 · 목록</button>}
                {moreOpen && <div className="ofc-cmp-list" style={moreOpen === 'lounge' ? { left: (layout.lounge.x + layout.lounge.w - 4) * scale, top: (layout.H - 12) * scale, transform: 'translate(-100%, -100%)' } : { right: 8, top: (layout.review.y + 10) * scale }}>
                  {(moreOpen === 'lounge' ? overflow.lounge : overflow.review).map((p) => <button key={p.key} onClick={() => pickPerson(p.key)}>{p.code} {p.name} · {POSE_LABEL[p.pose]}</button>)}
                </div>}
                {placed.map(({ p, x, y, w, h }) => (
                  <button key={`h${p.key}-${sel === p.key ? ping : 0}`} className={`ofc-hit${sel === p.key ? ' is-on' : ''}${sel === p.key && ping ? ' is-ping' : ''}`} style={{ left: x * scale, top: y * scale, width: w * scale, height: h * scale }}
                    aria-label={`${p.code} ${p.name} — ${POSE_LABEL[p.pose]}`} title={`${p.code} ${p.name}\n${POSE_LABEL[p.pose]}: ${p.task}`} onClick={() => pickPerson(p.key)} />
                ))}
                {placed.map(({ p, x, y, w, zone }) => {
                  const flag = p.blocked.length || p.blockedSteps.length ? { cls: 'bad', text: '막힘' } : p.asks ? { cls: 'ask', text: '확인 필요' } : null;
                  const bub = bubbles[p.key];
                  if (!flag && !bub) return null;
                  // 머리 옆(오른쪽 좌석은 왼쪽)에 붙여 위 줄 이름표를 가리지 않게 한다
                  const leftSide = zone === 'review' && x > layout.review.x + layout.review.w / 2;
                  return (
                    <div key={`f${p.key}`} className={`ofc-flags${leftSide ? ' is-left' : ''}`} style={{ left: (leftSide ? x - 1 : x + w + 1) * scale, top: (y - 1) * scale }}>
                      {flag && <span className={`ofc-flag ofc-flag-${flag.cls}`}>{flag.cls === 'bad' ? '⛔' : '🔔'} {flag.text}</span>}
                      {!flag && bub && <span className="ofc-bubble">{bub}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          <Activity people={people} working={working} sel={sel} mission={current} onPick={(k) => { setSel(k); setTab('staff'); }} onResults={() => setTab('results')} />
          </div>
          <aside className="ofc-side">
            <div className="ofc-tabs" role="tablist">
              <button role="tab" aria-selected={tab === 'staff'} className={tab === 'staff' ? 'is-on' : ''} onClick={() => setTab('staff')}>직원 현황</button>
              <button role="tab" aria-selected={tab === 'results'} className={tab === 'results' ? 'is-on' : ''} onClick={() => setTab('results')}>결과물{current?.results?.length ? ` ${current.results.length}` : ''}</button>
            </div>
            {tab === 'staff' ? (
              <>
                <ul className="ofc-list" aria-label="직원 목록">
                  {[...internal, ...externals].map((p) => (
                    <li key={p.key}>
                      <button className={`ofc-row${sel === p.key ? ' is-on' : ''}`} onClick={() => { setSel(p.key); setPing((n) => n + 1); }} aria-pressed={sel === p.key}>
                        <Portrait char={p.char} />
                        <span className="ofc-row-main">
                          <span className="ofc-row-head"><span className="ofc-code">{p.code}</span><span className="ofc-row-name">{p.name}</span>{p.external && <span className="ofc-ext">외부</span>}</span>
                          <span className="ofc-row-task">{p.blocked.length || p.blockedSteps.length ? '⛔ 막힘 · ' : ''}{p.task}</span>
                        </span>
                        <span className={`ofc-state ofc-state-${p.state}`}>{POSE_LABEL[p.pose]}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                {selGroup ? <GroupCard g={selGroup} mission={current} onPick={pickPerson} onResults={() => setTab('results')} /> : selected ? <Detail p={selected} mission={current} folder={project.plan.folder} /> : <div className="ofc-detail ofc-detail-empty muted small">지도에서 인물을 누르거나 목록에서 직원을 고르면 현재 작업·막힌 이유·최근 결과물을 보여 줍니다.</div>}
                {asks > 0 && <button className="ofc-ask-box" onClick={openDecisions}><span>🔔 확인 요청 <b>{asks}</b></span><span className="ofc-ask-cta">추천안 보기 ›</span></button>}
              </>
            ) : (
              <div className="ofc-results">{current ? <ResultsPanel mission={current} showMission /> : <div className="muted small">진행한 미션이 없습니다.</div>}</div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function Tag({ p, left, top, max, align = 'center', on, dim, small, role, onPick }: { p: Person; left: number; top: number; max: number; align?: 'start' | 'center' | 'end'; on: boolean; dim?: boolean; small?: boolean; role?: 'author' | 'reviewer' | 'codex'; onPick: () => void }) {
  const tx = align === 'start' ? '0' : align === 'end' ? '-100%' : '-50%';
  return (
    <button className={`ofc-tag ofc-tag-${p.state}${on ? ' is-on' : ''}${dim ? ' is-dim' : ''}${small ? ' is-sm' : ''}${role ? ` ofc-cmp-tag is-${role}` : ''}`} style={{ left, top, maxWidth: max, transform: `translate(${tx}, 0)` }} onClick={onPick} title={`${p.code} ${p.name} — ${POSE_LABEL[p.pose]}`}>
      <span className="ofc-tag-dot" aria-hidden="true" />{role === 'author' ? '받음 ' : ''}{small ? p.code : `${p.code} ${shortName(p.name)}`}
    </button>
  );
}

/** 지도 이름표용 짧은 이름: '기획·요구 분석' → '기획', '프런트엔드 개발' → '프런트엔드'(전체 이름은 목록·툴팁에) */
function shortName(n: string) { return n.split(/[\s·/]+/).find(Boolean) ?? n; }
const KIND_LABEL: Record<WorkingItem['kind'], string> = { author: '작성', reviewer: '독립 검토', codex: 'Codex 리뷰', check: '자동 검사', operator: '계획·판단' };
/** 지도 아래: 지금 실제로 실행 중인 일(실행 기록 그대로). 누르면 그 직원을 고른다. */
function Activity({ people, working, sel, mission, onPick, onResults }: { people: Person[]; working: WorkingItem[]; sel: string | null; mission: Mission | null; onPick: (key: string) => void; onResults: () => void }) {
  const codexIdx = new Map<WorkingItem, number>(); working.filter((w) => w.kind === 'codex').forEach((w, i) => codexIdx.set(w, i));
  const items = working.map((w) => {
    const p = w.kind === 'codex' ? people.find((x) => x.key === `codex-${codexIdx.get(w)}`) : people.find((x) => x.agent?.id === w.agentId);
    return { w, p };
  });
  if (items.length === 0) {
    // 실행 중인 작업이 없으면 한 줄로: 미션 상태와 결과물·미션 화면으로 가는 버튼
    return (
      <section className="ofc-activity is-idle" aria-label="지금 진행 중인 작업">
        <strong>지금 실행 중인 작업 없음</strong>
        <span className="muted small">{mission ? `${MISSION_STATUS_LABEL[mission.status]} · 사이클 ${mission.cycle}` : '진행한 미션 없음'}</span>
        <span className="ofc-activity-actions">
          {mission && <button className="btn btn-sm" onClick={onResults}>최근 결과물 보기</button>}
          {mission && <button className="btn btn-sm" onClick={() => window.dispatchEvent(new CustomEvent('crewgenai:goto-mission', { detail: { projectId: mission.projectId, missionId: mission.id } }))}>미션 화면</button>}
        </span>
      </section>
    );
  }
  return (
    <section className="ofc-activity" aria-label="지금 진행 중인 작업">
      <div className="ofc-activity-head"><strong>지금 진행 중</strong><span className="muted small">실행 기록 기준 · {items.length}건</span></div>
      {(
        <ul className="ofc-activity-list">
          {items.map(({ w, p }, i) => (
            <li key={i}>
              <button className={`ofc-act${p && sel === p.key ? ' is-on' : ''}`} disabled={!p} onClick={() => p && onPick(p.key)}>
                {p && <Portrait char={p.char} size={24} />}
                <span className="ofc-act-who">{p ? `${p.code} ${p.name}` : w.who}</span>
                <span className={`ofc-act-kind ofc-act-${w.kind}`}>{KIND_LABEL[w.kind]}</span>
                <span className="ofc-act-task" title={w.task}>{w.task}</span>
                <span className="muted small">{hhmm(w.since)}부터</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 선택한 직원 상세: 이름·역할·상태·현재 작업·막힌 이유·최근 결과물(직전 실행에서 이 직원이 바꾼 파일) */
function Detail({ p, mission, folder }: { p: Person; mission: Mission | null; folder: string }) {
  const [files, setFiles] = useState<{ rel: string; at: string | null }[] | null>(null);
  const [more, setMore] = useState(false);
  const act = useAction();
  const opener = useFileOpener();
  useEffect(() => {
    let alive = true; setFiles(null);
    if (!mission || !p.agent) { setFiles([]); return; }
    (async () => {
      const d = await ws().missionDetail(mission.id);
      const out: { rel: string; at: string | null }[] = [];
      for (const c of [...d.cycles].reverse().slice(0, 3)) {
        const r = await ws().runDetail(c.runId);
        const mine = r.attempts.filter((a: Attempt) => a.agentId === p.agent!.id && a.role === 'author' && a.changedFiles.length).reverse();
        for (const a of mine) for (const f of a.changedFiles) if (!out.some((x) => x.rel === f)) out.push({ rel: f, at: a.finishedAt });
        if (out.length >= 5) break;
      }
      if (alive) setFiles(out.slice(0, 5));
    })().catch(() => { if (alive) setFiles([]); });
    return () => { alive = false; };
  }, [p.key, p.agent, mission?.id, mission?.cycle, mission?.updatedAt]);
  const blocked = [...p.blocked.map((d) => `${d.tool} 거부: ${d.target}`), ...p.blockedSteps];
  return (
    <section className="ofc-detail" aria-label={`${p.code} ${p.name} 상세`}>
      <div className="ofc-detail-head">
        <Portrait char={p.char} size={46} />
        <div className="ofc-detail-id">
          <div><span className="ofc-code">{p.code}</span> <strong>{p.name}</strong>{p.external && <span className="ofc-ext">외부</span>}</div>
          <div className="muted small ofc-clamp" title={p.role}>{p.role}</div>
        </div>
        <span className={`ofc-state ofc-state-${p.state}`}>{POSE_LABEL[p.pose]}</span>
      </div>
      <dl className="ofc-dl">
        <dt>현재 작업</dt><dd>{p.task}{p.since ? <span className="muted small"> · {hhmm(p.since)}부터</span> : null}</dd>
        {blocked.length > 0 && <><dt className="bad">막힌 이유</dt><dd><ul className="ofc-blocked">{blocked.slice(0, 3).map((b, i) => <li key={i}>{b}</li>)}</ul>{blocked.length > 3 && <span className="muted small">외 {blocked.length - 3}건</span>}</dd></>}
        <dt>최근 결과물</dt>
        <dd>
          {files === null ? <span className="muted small">불러오는 중…</span> : files.length === 0 ? <span className="muted small">{p.external ? '외부 리뷰어의 보고서는 결과물 탭에서 확인합니다.' : '최근 실행에서 바꾼 파일이 없습니다.'}</span> : (
            <ul className="ofc-files">{files.map((f) => (
              <li key={f.rel}><button className="btn btn-sm" disabled={act.busy} onClick={() => void act.run(() => opener.open(`${folder}/${f.rel}`, 'file', f.rel.split('/').pop()))}>열기</button><span className="mono small ofc-file" title={f.rel}>{f.rel}</span>{f.at && <span className="muted small">{hhmm(f.at)}</span>}</li>
            ))}</ul>
          )}
        </dd>
      </dl>
      {p.agent && <button className="btn-link small" onClick={() => setMore(true)}>상세 보기</button>}
      {act.error && <Banner>{act.error}</Banner>}
      {opener.viewer}
      {more && p.agent && (
        <Modal title={`${p.code} ${p.name}`} onClose={() => setMore(false)}>
          <div className="modal-body ofc-more">
            <p><span className="muted small">역할</span><br />{p.role}</p>
            <p><span className="muted small">상태</span><br />{POSE_LABEL[p.pose]} — {p.task}</p>
            {blocked.length > 0 && <div><span className="muted small">막힌 이유</span><ul>{blocked.map((b, i) => <li key={i}>{b}</li>)}</ul></div>}
            <p><span className="muted small">업무 지시</span></p>
            <pre className="pre small">{p.agent.instructions}</pre>
            <p className="muted small">모델 {p.agent.model || '기본'} · 도구 {p.agent.tools.join(', ')}</p>
          </div>
        </Modal>
      )}
    </section>
  );
}


/** 리뷰 그룹 상세: 작업명·참여자(역할)·검토 상태·결과물 */
function GroupCard({ g, mission, onPick, onResults }: { g: Group; mission: Mission | null; onPick: (k: string) => void; onResults: () => void }) {
  const results = (mission?.results ?? []).filter((r) => g.task && (r.task?.includes(g.task) || g.task.includes(r.task ?? '\u0000') || r.title?.includes(g.task)));
  const since = [g.author, ...g.reviewers].filter(Boolean).map((p) => p!.since).filter(Boolean).sort()[0];
  return (
    <section className="ofc-detail" aria-label="리뷰 그룹 상세">
      <div className="ofc-detail-head"><span /><div className="ofc-detail-id"><div><strong>{g.task || '검토 작업'}</strong></div><div className="muted small">리뷰 그룹 · 참여 {(g.author ? 1 : 0) + g.reviewers.length}명</div></div><span className="ofc-state ofc-state-review">검토 중</span></div>
      <dl className="ofc-dl">
        <dt>리뷰받는 직원</dt><dd>{g.authorRef ? <button className="btn-link" onClick={() => onPick(g.authorRef!.key)}>{g.authorRef.code} {g.authorRef.name}{!g.author && <span className="muted small"> (다른 리뷰 탁자에 앉아 있음)</span>}</button> : <span className="muted small">실행 기록에 대상 직원이 없습니다</span>}</dd>
        <dt>검토자</dt><dd>{g.reviewers.map((r) => <div key={r.key}><button className="btn-link" onClick={() => onPick(r.key)}>{r.code} {r.name}</button>{r.external && <span className="ofc-ext">외부</span>} <span className="muted small">{r.task}</span></div>)}</dd>
        <dt>검토 상태</dt><dd>진행 중{since ? <span className="muted small"> · {hhmm(since)}부터</span> : null}</dd>
        <dt>결과물</dt><dd>{results.length ? results.slice(0, 4).map((r, i) => <div key={i} className="small">{r.title}</div>) : <span className="muted small">이 작업의 결과물은 아직 없습니다.</span>} <button className="btn-link small" onClick={onResults}>결과물 탭</button></dd>
      </dl>
    </section>
  );
}
