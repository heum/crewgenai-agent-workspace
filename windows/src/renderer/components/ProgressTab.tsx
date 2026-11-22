// 진척 메뉴: 프로젝트 전체 완성도. 큰 단계별 진행률과 단계 안의 기능 목록(근거 문서 ID·완료 기준·상태·확인 근거), 계획 변경 기록.
// 진척 관리(PM) 직원이 사이클마다 갱신하며, 미션이 바뀌어도 프로젝트에 하나로 이어진다.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LiveEvent, MissionWorkPlan, Project, WorkItem, WorkStatus } from '../../shared/types';
import { fmtDate, useAction, useLoad, ws } from '../api';
import { Badge, Banner, Empty, Loading } from './common';

const LABEL: Record<WorkStatus, string> = { todo: '시작 전', doing: '진행', verifying: '검증 중', done: '완료', blocked: '막힘' };
const TONE: Record<WorkStatus, 'neutral' | 'ok' | 'warn' | 'bad' | 'info'> = { todo: 'neutral', doing: 'info', verifying: 'warn', done: 'ok', blocked: 'bad' };
const ORDER: WorkStatus[] = ['blocked', 'doing', 'verifying', 'todo', 'done'];
const KIND: Record<string, string> = { create: '목록 생성', add: '추가', remove: '제외', edit: '변경' };

function count(items: WorkItem[]) {
  const n = (s: WorkStatus) => items.filter((i) => i.status === s).length;
  const total = items.length; const done = n('done');
  return { total, done, doing: n('doing'), verifying: n('verifying'), blocked: n('blocked'), todo: n('todo'), pct: total ? Math.round((done / total) * 100) : 0 };
}
function Bar({ items }: { items: WorkItem[] }) {
  const c = count(items); if (!c.total) return <div className="progress-bar" />;
  return (
    <div className="progress-bar" role="img" aria-label={`완료 ${c.pct}%`}>
      {(['done', 'verifying', 'doing', 'blocked'] as WorkStatus[]).map((s) => <span key={s} className={`seg seg-${s}`} style={{ width: `${(c[s] / c.total) * 100}%` }} title={`${LABEL[s]} ${c[s]}개`} />)}
    </div>
  );
}
/** 막대 색 설명: 색마다 무엇인지와 개수 */
function Legend({ items }: { items: WorkItem[] }) {
  const c = count(items);
  return (
    <div className="progress-legend small" aria-label="색 설명">
      {(['done', 'verifying', 'doing', 'blocked', 'todo'] as WorkStatus[]).map((s) => (
        <span key={s} className="legend-item"><span className={`legend-dot seg-${s}`} />{LABEL[s]} <b>{c[s]}</b></span>
      ))}
    </div>
  );
}

export default function ProgressTab({ project }: { project: Project }) {
  const prog = useLoad(() => ws().projectProgress(project.id), [project.id]);
  const agents = useLoad(() => ws().listAgents(project.id), [project.id]);
  const reloadRef = useRef(prog.reload); reloadRef.current = prog.reload;
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = ws().onLive((e: LiveEvent) => {
      if (e.type !== 'progress' || e.projectId !== project.id) return;
      if (t) clearTimeout(t); t = setTimeout(() => void reloadRef.current(), 500);
    });
    return () => { off(); if (t) clearTimeout(t); };
  }, [project.id]);
  const pm = (agents.data ?? []).find((a) => a.code === 'PM');
  if (prog.loading && !prog.data) return <Loading />;
  if (prog.error) return <Banner>{prog.error}</Banner>;
  return (
    <div className="progress-tab">
      <div className="row gap wrap progress-head">
        <strong>프로젝트 완성도</strong>
        <span className="muted small">{project.plan.name}</span>
        <span className="muted small progress-owner">{pm ? `담당: ${pm.code} ${pm.name}${pm.active ? '' : '(휴가 중 — 갱신 멈춤)'}` : '담당: 진척 관리 직원(다음 판단 때 채용)'}</span>
      </div>
      {prog.data?.items.length ? <PlanView projectId={project.id} wp={prog.data} onChanged={() => void prog.reload()} />
        : <Empty title="아직 진척 목록이 없습니다">미션의 다음 사이클 판단이 끝나면 진척 관리 직원이 기획의 목표·완료 조건과 근거 문서를 읽고, 프로젝트 전체를 큰 단계와 기능 목록으로 만듭니다(개발은 멈추지 않음).</Empty>}
    </div>
  );
}

function PlanView({ projectId, wp, onChanged }: { projectId: string; wp: MissionWorkPlan; onChanged: () => void }) {
  const act = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const phases = wp.phases?.length ? wp.phases : [{ id: '', title: '전체', goal: '' }];
  const byPhase = useMemo(() => new Map(phases.map((p) => [p.id, wp.items.filter((i) => (p.id ? i.phase === p.id : true))])), [wp]); // eslint-disable-line react-hooks/exhaustive-deps
  const all = count(wp.items);
  // 지금 단계: 완료되지 않은 기능이 있는 첫 단계
  const current = phases.find((p) => (byPhase.get(p.id) ?? []).some((i) => i.status !== 'done'))?.id ?? null;
  const shownPhase = open ?? current;
  const fresh = wp.changes.slice(wp.reviewedChanges ?? 0);
  const askUser = wp.items.filter((i) => (i.note ?? '').trimStart().startsWith('사용자 확인:'));
  return (
    <>
      <div className="card progress-summary">
        <div className="row gap wrap" style={{ alignItems: 'baseline' }}>
          <strong className="progress-pct">{all.pct}%</strong>
          <span>기능 {all.total}개 중 <b>{all.done}개 완료</b> · 단계 {wp.phases?.length ?? 0}개</span>
          {(['doing', 'verifying', 'blocked', 'todo'] as WorkStatus[]).map((s) => all[s] ? <Badge key={s} tone={TONE[s]}>{LABEL[s]} {all[s]}</Badge> : null)}
        </div>
        <Bar items={wp.items} />
        <Legend items={wp.items} />
        <p className="muted small">완성도는 확인 근거가 있는 완료 기능 수로만 셉니다(시간 추정 아님). 미션이 바뀌어도 이 목록은 이어집니다.</p>
      </div>
      {fresh.length > 0 && (
        <div className="banner banner-warn progress-review">
          <div>
            <strong>{wp.reviewedAt ? `확인하지 않은 계획 변경 ${fresh.length}건` : '처음 만든 진척 목록 — 아직 확인하지 않음'}</strong>
            <ul className="small">{fresh.slice(-8).map((c, i) => <li key={i}>사이클 {c.cycle} · {KIND[c.kind]} {c.id} {c.title} — {c.reason}</li>)}</ul>
            <div className="muted small">개발은 이 목록으로 계속 진행 중입니다. 단계·기능·완료 기준이 다르면 운영 메뉴에서 추가 지시하면 진척 관리 직원이 반영합니다.</div>
          </div>
          <button className="btn btn-primary" disabled={act.busy} onClick={() => void act.run(async () => { await ws().reviewProjectProgress(projectId); onChanged(); })}>확인함</button>
        </div>
      )}
      {askUser.length > 0 && (
        <div className="banner banner-info progress-review">
          <div>
            <strong>직접 봐 주시면 되는 것 {askUser.length}개</strong>
            <ul className="small">{askUser.map((i) => <li key={i.id}><span className="mono">{i.id}</span> {i.title} <Badge tone={TONE[i.status]}>{LABEL[i.status]}</Badge> — {(i.note ?? '').replace(/^\s*사용자 확인:\s*/, '')}</li>)}</ul>
            <div className="muted small">자동으로 확인할 수 없는 것만 모았습니다. 보시고 다르면 운영 메뉴에서 추가 지시하면 됩니다. 답이 없다고 승인으로 치지 않으며, 개발은 멈추지 않습니다.</div>
          </div>
        </div>
      )}
      {act.error && <Banner>{act.error}</Banner>}
      <div className="phase-list" role="list">
        {phases.map((p, idx) => {
          const items = byPhase.get(p.id) ?? []; const c = count(items); const isOpen = shownPhase === p.id;
          const shown = [...items].filter((i) => showDone || i.status !== 'done').sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || Number(a.id.slice(1)) - Number(b.id.slice(1)));
          return (
            <div key={p.id || idx} role="listitem" className={`card phase ${p.id === current ? 'is-current' : ''} ${c.total && c.done === c.total ? 'is-done' : ''}`}>
              <button className="phase-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? '' : p.id)}>
                <span className="phase-no">{idx + 1}</span>
                <span className="phase-title"><b>{p.title}</b>{p.id === current && <Badge tone="info">지금 단계</Badge>}<span className="muted small">{p.goal}</span></span>
                <span className="phase-stat small">{c.done}/{c.total} · {c.pct}%{c.blocked ? <> · <span className="bad">막힘 {c.blocked}</span></> : null}</span>
              </button>
              <Bar items={items} />
              {isOpen && (
                <>
                  {c.done > 0 && <label className="small" style={{ display: 'block', margin: '8px 0 0' }}><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> 완료한 기능도 보기</label>}
                  {shown.length ? (
                    <table className="progress-table">
                      <thead><tr><th>ID</th><th>기능</th><th>상태</th><th>완료 기준</th><th>근거·메모</th><th>갱신</th></tr></thead>
                      <tbody>{shown.map((i) => <Row key={i.id} item={i} />)}</tbody>
                    </table>
                  ) : <div className="muted small pad">{c.total ? '이 단계의 기능은 모두 완료됐습니다.' : '아직 기능이 없습니다.'}</div>}
                </>
              )}
            </div>
          );
        })}
      </div>
      {wp.removed.length > 0 && (
        <details className="small" style={{ marginTop: 10 }}><summary>뺀 기능 {wp.removed.length}개</summary>
          <ul>{wp.removed.map((i) => <li key={i.id}>{i.id} {i.title} — {[...wp.changes].reverse().find((c) => c.kind === 'remove' && c.id === i.id)?.reason ?? ''}</li>)}</ul>
        </details>
      )}
      <details className="small" style={{ marginTop: 6 }}><summary>계획 변경 기록 {wp.changes.length}건</summary>
        <ul>{[...wp.changes].reverse().map((c, i) => <li key={i}>{fmtDate(c.at)} · 사이클 {c.cycle} · {KIND[c.kind]} {c.id} {c.title} — {c.reason}</li>)}</ul>
      </details>
    </>
  );
}

function Row({ item: i }: { item: WorkItem }) {
  return (
    <tr className={`st-${i.status}`}>
      <td className="mono">{i.id}</td>
      <td><b>{i.title}</b>{i.refs?.length ? <div className="muted small mono">{i.refs.join(' · ')}</div> : null}</td>
      <td><Badge tone={TONE[i.status]}>{LABEL[i.status]}</Badge></td>
      <td className="small">{i.criteria}</td>
      <td className="small">{i.evidence && <div>근거: {i.evidence}</div>}{i.note && <div className="muted">{i.note}</div>}</td>
      <td className="small muted">사이클 {i.updatedCycle}</td>
    </tr>
  );
}
