// 진척 메뉴: 미션 작업 목록(단원·완료 기준·상태·확인 근거)과 계획 변경 기록. 진척 관리(PM) 직원이 사이클마다 갱신한다.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LiveEvent, Mission, Project, WorkItem, WorkStatus } from '../../shared/types';
import { fmtDate, useAction, useLoad, ws } from '../api';
import { Badge, Banner, Empty, Loading } from './common';

const LABEL: Record<WorkStatus, string> = { todo: '시작 전', doing: '진행', verifying: '검증 중', done: '완료', blocked: '막힘' };
const TONE: Record<WorkStatus, 'neutral' | 'ok' | 'warn' | 'bad' | 'info'> = { todo: 'neutral', doing: 'info', verifying: 'warn', done: 'ok', blocked: 'bad' };
const ORDER: WorkStatus[] = ['blocked', 'doing', 'verifying', 'todo', 'done'];
const OPEN = ['planning', 'running', 'evaluating', 'waiting_user', 'done'];
const STATUS_TEXT: Record<string, string> = { planning: '계획 중', running: '실행 중', evaluating: '판단 중', waiting_user: '확인 대기', done: '완료 보고', failed: '실패', stopped: '종료' };

export default function ProgressTab({ project, onOpenMission }: { project: Project; onOpenMission?: (missionId: string) => void }) {
  const list = useLoad(() => ws().listMissions(project.id), [project.id]);
  const agents = useLoad(() => ws().listAgents(project.id), [project.id]);
  const reloadRef = useRef(list.reload); reloadRef.current = list.reload;
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = ws().onLive((e: LiveEvent) => {
      if (e.type !== 'mission' || e.mission.projectId !== project.id) return;
      if (t) clearTimeout(t); t = setTimeout(() => void reloadRef.current(), 500);
    });
    return () => { off(); if (t) clearTimeout(t); };
  }, [project.id]);
  const missions = list.data ?? [];
  const [pick, setPick] = useState<string | null>(null);
  const m: Mission | undefined = missions.find((x) => x.id === pick) ?? missions.find((x) => OPEN.includes(x.status)) ?? missions[0];
  const pm = (agents.data ?? []).find((a) => a.code === 'PM');
  if (list.loading && !list.data) return <Loading />;
  if (list.error) return <Banner>{list.error}</Banner>;
  if (!m) return <Empty title="미션이 없습니다">운영 메뉴에서 지시하면 진척 관리 직원이 작업 목록을 만듭니다.</Empty>;
  return (
    <div className="progress-tab">
      <div className="row gap wrap progress-head">
        <select value={m.id} onChange={(e) => setPick(e.target.value)} aria-label="미션 고르기">
          {missions.map((x) => <option key={x.id} value={x.id}>{`${STATUS_TEXT[x.status] ?? x.status} · ${x.prompt.replace(/\s+/g, ' ').slice(0, 50)}`}</option>)}
        </select>
        <span className="muted small">사이클 {m.cycle} · {STATUS_TEXT[m.status] ?? m.status}</span>
        {onOpenMission && <button className="btn-link small" onClick={() => onOpenMission(m.id)}>운영에서 보기</button>}
        <span className="muted small progress-owner">{pm ? `담당: ${pm.code} ${pm.name}${pm.active ? '' : '(휴가 중 — 갱신 멈춤)'}` : '담당: 진척 관리 직원(다음 판단 때 채용)'}</span>
      </div>
      <PlanView mission={m} />
    </div>
  );
}

function PlanView({ mission: m }: { mission: Mission }) {
  const act = useAction();
  const wp = m.workPlan;
  const [showDone, setShowDone] = useState(false);
  const items = useMemo(() => [...(wp?.items ?? [])].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || Number(a.id.slice(1)) - Number(b.id.slice(1))), [wp]);
  if (!wp?.items.length) return <Empty title="아직 작업 목록이 없습니다">이번 사이클 판단이 끝나면 진척 관리 직원이 지시·완료 조건·지금까지 한 일을 보고 단원별 작업 목록을 만듭니다(개발은 멈추지 않음).</Empty>;
  const n = (s: WorkStatus) => wp.items.filter((i) => i.status === s).length;
  const total = wp.items.length; const done = n('done'); const pct = Math.round((done / total) * 100);
  const fresh = wp.changes.slice(wp.reviewedChanges ?? 0);
  const shown = showDone ? items : items.filter((i) => i.status !== 'done');
  return (
    <>
      <div className="card progress-summary">
        <div className="row gap wrap" style={{ alignItems: 'baseline' }}>
          <strong className="progress-pct">{pct}%</strong>
          <span>단원 {total}개 중 <b>{done}개 완료</b></span>
          {(['doing', 'verifying', 'blocked', 'todo'] as WorkStatus[]).map((s) => n(s) ? <Badge key={s} tone={TONE[s]}>{LABEL[s]} {n(s)}</Badge> : null)}
        </div>
        <div className="progress-bar" role="img" aria-label={`완료 ${pct}%`}>
          {(['done', 'verifying', 'doing', 'blocked'] as WorkStatus[]).map((s) => <span key={s} className={`seg seg-${s}`} style={{ width: `${(n(s) / total) * 100}%` }} />)}
        </div>
        <p className="muted small">완료 비율은 확인 근거가 있는 완료 단원 수로만 셉니다(시간 추정 아님). 모든 단원이 완료되면 미션이 완료 검토로 멈춥니다.</p>
      </div>
      {fresh.length > 0 && (
        <div className="banner banner-warn progress-review">
          <div>
            <strong>{wp.reviewedAt ? `확인하지 않은 계획 변경 ${fresh.length}건` : '처음 만든 작업 목록 — 아직 확인하지 않음'}</strong>
            <ul className="small">{fresh.slice(-8).map((c, i) => <li key={i}>사이클 {c.cycle} · {c.kind === 'create' ? '목록 생성' : c.kind === 'add' ? '추가' : c.kind === 'remove' ? '제외' : '변경'} {c.id} {c.title} — {c.reason}</li>)}</ul>
            <div className="muted small">개발은 이 목록으로 계속 진행 중입니다. 범위·완료 기준이 다르면 운영 메뉴에서 추가 지시하면 진척 관리 직원이 목록에 반영합니다.</div>
          </div>
          <button className="btn btn-primary" disabled={act.busy} onClick={() => void act.run(() => ws().reviewWorkPlan(m.id))}>확인함</button>
        </div>
      )}
      {act.error && <Banner>{act.error}</Banner>}
      <div className="row gap" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: '12px 0 6px' }}>작업 목록</h3>
        {done > 0 && <label className="small"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> 완료 {done}개도 보기</label>}
      </div>
      <table className="progress-table">
        <thead><tr><th>ID</th><th>단원</th><th>상태</th><th>완료 기준</th><th>근거·메모</th><th>갱신</th></tr></thead>
        <tbody>{shown.map((i) => <Row key={i.id} item={i} />)}</tbody>
      </table>
      {wp.removed.length > 0 && (
        <details className="small" style={{ marginTop: 10 }}><summary>뺀 단원 {wp.removed.length}개</summary>
          <ul>{wp.removed.map((i) => <li key={i.id}>{i.id} {i.title} — {[...wp.changes].reverse().find((c) => c.kind === 'remove' && c.id === i.id)?.reason ?? ''}</li>)}</ul>
        </details>
      )}
      <details className="small" style={{ marginTop: 6 }}><summary>계획 변경 기록 {wp.changes.length}건</summary>
        <ul>{[...wp.changes].reverse().map((c, i) => <li key={i}>{fmtDate(c.at)} · 사이클 {c.cycle} · {c.kind === 'create' ? '목록 생성' : c.kind === 'add' ? '추가' : c.kind === 'remove' ? '제외' : '변경'} {c.id} {c.title} — {c.reason}</li>)}</ul>
      </details>
    </>
  );
}

function Row({ item: i }: { item: WorkItem }) {
  return (
    <tr className={`st-${i.status}`}>
      <td className="mono">{i.id}</td>
      <td><b>{i.title}</b></td>
      <td><Badge tone={TONE[i.status]}>{LABEL[i.status]}</Badge></td>
      <td className="small">{i.criteria}</td>
      <td className="small">{i.evidence && <div>근거: {i.evidence}</div>}{i.note && <div className="muted">{i.note}</div>}</td>
      <td className="small muted">사이클 {i.updatedCycle}</td>
    </tr>
  );
}
