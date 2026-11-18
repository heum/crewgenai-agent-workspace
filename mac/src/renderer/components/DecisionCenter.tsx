// 사용자 확인함: 결정·승인이 필요한 것을 한곳에 모은다. 진행 중 미션은 그동안 다른 작업을 계속한다.
// 팝업은 미션 전체가 그 결정을 기다릴 때(긴급)와 오래 비웠다 돌아왔을 때만 요약으로 띄운다. 질문마다 연속 팝업을 띄우지 않는다.
// 추천안은 표시만 하고, '추천안으로 채우기'로 골라도 '선택 항목 일괄 적용'을 누르기 전에는 아무것도 승인·반영되지 않는다.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CommitPreview, LiveEvent, Mission, PendingDecision } from '../../shared/types';
import ReviewCheckpoint from './ReviewCheckpoint';
import { decisionVersion } from '../../shared/decisions';
import { useAction, ws } from '../api';
import { Banner } from './common';

export default function DecisionCenter({ onOpenMission }: { onOpenMission: (projectId: string, missionId: string) => void }) {
  const [items, setItems] = useState<PendingDecision[]>([]);
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const [own, setOwn] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'item'>('list'); // 확인함 목록 / 한 항목 자세히
  const [sel, setSel] = useState<Record<string, string>>({}); // 항목별로 고른 선택지(적용 전)
  const [ownMap, setOwnMap] = useState<Record<string, string>>({}); // 항목별 직접 적은 답(적용 전)
  const seen = useRef<Set<string>>(new Set()); // 이미 팝업으로 보여 준 결정(닫으면 같은 결정으로 다시 띄우지 않음)
  const handled = useRef<Set<string>>(new Set()); // 이번에 정한 권한 항목(보류 유지 포함) — 다시 묻지 않음
  const act = useAction();
  const explicit = useRef(false); // '지금 확인'으로 직접 연 동안에는 진행 중이라 미뤄 둔 항목도 계속 보여 준다
  useEffect(() => { if (!open) explicit.current = false; }, [open]);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      ws().pendingDecisions(explicit.current).then((all) => {
        const list = all.filter((x) => !handled.current.has(x.key));
        setItems(list);
        const fresh = list.filter((d) => !seen.current.has(d.key));
        for (const d of fresh) seen.current.add(d.key);
        // 미션 전체가 기다리는 새 결정만 팝업(확인함 요약)으로 알린다. 나머지는 확인함 배지에 쌓는다.
        if (fresh.some((d) => d.urgent)) { setView('list'); setDone(null); setOpen(true); }
      }).catch(() => {});
    };
    load();
    const off = ws().onLive((e: LiveEvent) => { if (e.type === 'mission') { if (t) clearTimeout(t); t = setTimeout(load, 400); } });
    // 다른 화면(사무실의 '확인 필요' 등)에서 결정 팝업을 연다
    // detail.missionId가 있으면 그 미션의 결정부터 보여 주고, 팝업에 그 미션 항목이 없으면 detail.fallback(해당 화면으로 이동)
    const openNow = (e: Event) => {
      const d = (e as CustomEvent<{ missionId?: string | null; fallback?: () => void } | undefined>).detail;
      ws().pendingDecisions(true).then((all) => {
        const list = all.filter((x) => !handled.current.has(x.key));
        const at = d?.missionId ? list.findIndex((x) => x.missionId === d.missionId) : 0;
        if ((d?.missionId && at < 0) || !list.length) { d?.fallback?.(); return; }
        explicit.current = true; for (const x of list) seen.current.add(x.key); setItems(list); setIdx(Math.max(0, at)); setDone(null);
        setView(d?.missionId && list[Math.max(0, at)]?.kind === 'checkpoint' ? 'item' : 'list'); setOpen(true);
      }).catch(() => d?.fallback?.());
    };
    window.addEventListener('crewgenai:open-decisions', openNow);
    // 앱으로 돌아왔을 때(10분 이상 비움) 미결 항목이 있으면 확인함 요약을 한 번 보여 준다
    let awayAt = 0;
    const onBlur = () => { awayAt = Date.now(); };
    const onFocus = () => {
      if (!awayAt || Date.now() - awayAt < 10 * 60_000) { awayAt = 0; return; }
      awayAt = 0;
      ws().pendingDecisions(true).then((all) => { const list = all.filter((x) => !handled.current.has(x.key)); if (list.length) { setItems(list); setView('list'); setDone(null); setOpen(true); } }).catch(() => {});
    };
    window.addEventListener('blur', onBlur); window.addEventListener('focus', onFocus);
    return () => { off(); if (t) clearTimeout(t); window.removeEventListener('crewgenai:open-decisions', openNow); window.removeEventListener('blur', onBlur); window.removeEventListener('focus', onFocus); };
  }, []);

  const cur = items[Math.min(idx, items.length - 1)] ?? null;
  // 검토 지점은 팝업 안에서 검토 카드 그대로 보여 준다(미션 화면으로 옮겨 가지 않아도 됨)
  const [cpMission, setCpMission] = useState<Mission | null>(null);
  useEffect(() => {
    if (!open || cur?.kind !== 'checkpoint') return;
    let live = true;
    ws().missionDetail(cur.missionId).then((d) => { if (live) setCpMission(d.mission); }).catch(() => {});
    return () => { live = false; };
  }, [open, cur?.key]);
  const afterCheckpoint = async () => {
    if (cur) handled.current.add(cur.key);
    const list = (await ws().pendingDecisions(explicit.current)).filter((x) => !handled.current.has(x.key));
    setItems(list); setIdx(0); setDone('검토 결과를 보냈습니다. 미션이 이어서 진행합니다.');
    if (!list.length) setTimeout(() => setOpen(false), 1800);
  };
  useEffect(() => { setOwn(''); }, [cur?.key]);
  // 승인 커밋: 지금 저장소 상태로 파일·변경 줄 수·막힘을 다시 읽어 보여 준다(승인할 때 이 내용과 같아야 커밋)
  const [preview, setPreview] = useState<CommitPreview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const loadPreview = () => {
    setPreview(null); setPreviewErr(null);
    if (cur?.kind !== 'commit' || !cur.commit) return;
    const key = cur.key;
    ws().commitPreview(cur.missionId, cur.commit.id).then((p) => { if (curKey.current === key) setPreview(p); }).catch((e: Error) => { if (curKey.current === key) setPreviewErr(e.message); });
  };
  const curKey = useRef<string | null>(null);
  useEffect(() => { curKey.current = cur?.key ?? null; loadPreview(); }, [cur?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const afterCommit = async (msg: string) => {
    const list = (await ws().pendingDecisions(explicit.current)).filter((x) => !handled.current.has(x.key));
    for (const d of list) seen.current.add(d.key);
    setItems(list); setIdx(0); setDone(msg);
    if (!list.length) setTimeout(() => setOpen(false), 2200);
  };
  const approveCommit = () => act.run(async () => {
    if (!cur?.commit || !preview) return;
    try {
      const r = await ws().commitApprove(cur.missionId, cur.commit.id, preview.hash);
      await afterCommit(`커밋했습니다: ${r.branch ?? ''} ${r.sha?.slice(0, 8) ?? ''} · "${cur.commit.message}" (push하지 않음)${r.error ? ` — ${r.error}` : ''}`);
    } catch (e) { loadPreview(); throw e; }
  });
  const declineCommit = () => act.run(async () => {
    if (!cur?.commit) return;
    await ws().commitDecline(cur.missionId, cur.commit.id);
    await afterCommit('커밋하지 않기로 기록했습니다. 오퍼레이터는 이 결정을 따릅니다.');
  });
  const rec = useMemo(() => cur?.choices.find((c) => c.recommended) ?? null, [cur]);

  // 고른 안의 설명(고르면 달라지는 것)도 함께 넘겨 다음 계획이 사용자가 승인한 내용 그대로 따르게 한다
  // 권한 보류: 허용이면 그 직원(또는 기획 참고 자료)에만 넣고, 그 미션에 남은 권한 항목이 없으면 다시 시도한다
  const resolvePermissionFor = async (it: PendingDecision, allow: boolean) => {
    if (!it.denial) return;
    const d = it.denial; const cur = it;
    if (allow && d.kind === 'command' && d.suggestion) {
      const a = (await ws().listAgents(cur.projectId)).find((x) => x.id === d.agentId);
      if (!a) throw new Error('직원을 찾을 수 없습니다(해고됐을 수 있음).');
      const { id: _i, projectId: _p, version: _v, updatedAt: _u, fired: _f, ...fields } = a;
      const tools = fields.tools.includes('Bash') ? fields.tools : [...fields.tools, 'Bash' as const];
      const allowedCommands = fields.allowedCommands.includes(d.suggestion) ? fields.allowedCommands : [...fields.allowedCommands, d.suggestion];
      await ws().saveAgent(cur.projectId, a.id, { ...fields, tools, allowedCommands });
    } else if (allow && d.kind === 'path' && d.suggestion) {
      const pr = (await ws().listProjects()).find((x) => x.id === cur.projectId);
      if (!pr) throw new Error('프로젝트를 찾을 수 없습니다.');
      if (!pr.plan.referenceDocs.includes(d.suggestion)) await ws().updatePlan(pr.id, { ...pr.plan, referenceDocs: [...pr.plan.referenceDocs, d.suggestion] });
    }
    handled.current.add(it.key);
  };
  const resolvePermission = async (allow: boolean) => {
    if (!cur?.denial) return;
    await resolvePermissionFor(cur, allow);
    const left = items.filter((x) => x.kind === 'permission' && x.missionId === cur.missionId && !handled.current.has(x.key));
    if (!left.length) await ws().retryParked(cur.missionId, items.filter((x) => x.kind === 'permission' && x.missionId === cur.missionId && x.denial).map((x) => x.denial!.sig)); // 그 미션의 권한 항목을 모두 정했으면 그 항목만 풀고 다음 계획부터 다시 시도
  };
  // 같은 미션의 권한 항목을 한 번에: 보여 준 목록 그대로 각 직원에게만 허용하고, 다 정하면 보류한 업무를 다시 시도한다
  const allowAll = () => act.run(async () => {
    if (!cur) return;
    const mine = items.filter((x) => x.kind === 'permission' && x.missionId === cur.missionId && !!x.denial?.suggestion && x.denial.kind !== 'other');
    for (const it of mine) await resolvePermissionFor(it, true);
    await ws().retryParked(cur.missionId, mine.map((x) => x.denial!.sig)); // 허용한 항목만 푼다(다른 보류·결정은 그대로)
    const list = (await ws().pendingDecisions(explicit.current)).filter((x) => !handled.current.has(x.key));
    for (const d of list) seen.current.add(d.key);
    setItems(list); setIdx(0);
    setDone(`권한 ${mine.length}건을 허용했습니다. 보류한 업무를 다음 계획부터 다시 시도합니다.`);
    if (!list.length) setTimeout(() => setOpen(false), 1800);
  });
  const choose = (label: string, action?: 'stop', effect?: string) => act.run(async () => {
    if (!cur) return;
    if (cur.kind === 'permission') {
      const allow = !label.startsWith('허용하지 않');
      await resolvePermission(allow);
      const list = (await ws().pendingDecisions(explicit.current)).filter((x) => !handled.current.has(x.key));
      for (const d of list) seen.current.add(d.key);
      setItems(list); setIdx(0);
      setDone(allow ? `허용했습니다. ${list.some((x) => x.kind === 'permission' && x.missionId === cur.missionId) ? '남은 권한 항목을 정하면 보류한 업무를 다시 시도합니다.' : '보류한 업무를 다음 계획부터 다시 시도합니다.'}` : '보류를 유지합니다. 나머지 작업은 계속 진행합니다.');
      if (!list.length) setTimeout(() => setOpen(false), 1800);
      return;
    }
    const choice = (effect?.trim() ? `${label.trim()} — ${effect.trim()}` : label.trim()).slice(0, 600);
    if (!choice) throw new Error('고를 내용을 입력하세요.');
    if (action === 'stop') await ws().answerMission(cur.missionId, '', 'stop');
    else if (cur.kind === 'question') await ws().answerMission(cur.missionId, choice, 'continue', true);
    else await ws().decideMission(cur.missionId, [{ doc: cur.doc, issue: cur.issue, choice }], cur.waiting);
    const list = (await ws().pendingDecisions(explicit.current)).filter((x) => !handled.current.has(x.key));
    for (const d of list) seen.current.add(d.key);
    setItems(list);
    setDone(action === 'stop' ? `'${label.trim()}' — 미션을 종료했습니다.` : `'${label.trim()}'로 정했습니다. ${cur.kind === 'question' || cur.waiting ? '미션이 이 결정으로 이어서 진행합니다.' : '다음 계획부터 이 결정을 따릅니다.'}`);
    setIdx(0);
    if (!list.length) setTimeout(() => setOpen(false), 1800);
  });

  // ───── 확인함: 선택 항목 일괄 적용 ─────
  const batchable = (it: PendingDecision) => it.kind === 'question' || it.kind === 'gap' || it.kind === 'permission';
  const answerOf = (it: PendingDecision) => (ownMap[it.key]?.trim() || sel[it.key] || '').trim();
  const picked = items.filter((it) => batchable(it) && answerOf(it));
  // 추천안으로 채우기: 추천이 있는 결정만 고른다(권한 허용은 직접 골라야 함). 고르기만 할 뿐 적용 전에는 반영되지 않는다.
  const fillRec = () => setSel((cur) => { const n = { ...cur }; for (const it of items) { if (it.kind === 'permission' || !batchable(it) || n[it.key]) continue; const r = it.choices.find((c) => c.recommended); if (r) n[it.key] = r.label; } return n; });
  // 적용은 앱 본체의 공통 처리(텔레그램과 같은 로직)로: 적용 직전에 각 항목이 아직 유효한지 다시 확인하고 유효한 것만 반영한다
  const applySelected = () => act.run(async () => {
    const r = await ws().applyDecisions(picked.map((it) => ({ key: it.key, choice: answerOf(it), version: decisionVersion(it) })));
    for (const it of picked) handled.current.add(it.key);
    const list = (await ws().pendingDecisions(true)).filter((x) => !handled.current.has(x.key));
    setItems(list); setSel({}); setOwnMap({});
    setDone(`${r.applied}건을 적용했습니다.${r.stale ? ` 이미 처리됐거나 내용이 바뀐 ${r.stale}건은 적용하지 않았습니다.` : ''}\n${r.lines.join('\n')}`);
  });
  const urgentN = items.filter((x) => x.urgent).length;
  const KIND: Record<PendingDecision['kind'], string> = { question: '질문', gap: '결정', permission: '권한', commit: '커밋 승인', checkpoint: '결과 검토' };

  if (!items.length && !open) return null;
  return (
    <>
      {items.length > 0 && !open && (
        <button className={`decision-badge${urgentN ? ' is-urgent' : ''}`} onClick={() => { setDone(null); setIdx(0); setView('list'); setOpen(true); }} title="사용자 확인함을 엽니다">
          확인함 {items.length}{urgentN ? ` · 대기 ${urgentN}` : ''}
        </button>
      )}
      {open && (
        <div className="modal-back" role="presentation">
          <div className={`modal decision-modal${view === 'list' || cur?.kind === 'checkpoint' ? ' is-wide' : ''}`} role="dialog" aria-modal="true" aria-label="사용자 확인함">
            <div className="modal-head">
              {view === 'list'
                ? <h2>사용자 확인함 <span className="muted small">{items.length}건{urgentN ? ` · 미션을 멈춘 결정 ${urgentN}건` : ' · 진행 중인 미션은 계속 작업 중'}</span></h2>
                : <h2><button className="btn-link" onClick={() => { setView('list'); setDone(null); }}>← 확인함</button> {cur ? KIND[cur.kind] : ''}</h2>}
              <button className="btn" onClick={() => setOpen(false)}>나중에</button>
            </div>
            {view === 'list' ? (
              <div className="decision-body inbox">
                {done && <div className="decision-done" style={{ whiteSpace: 'pre-line' }}>{done}</div>}
                {!items.length && <div className="muted">남은 항목이 없습니다.</div>}
                {items.length > 0 && <div className="row gap inbox-tools"><button className="btn btn-sm" onClick={fillRec}>추천안으로 채우기</button><span className="muted small">채우기·고르기만으로는 아무것도 승인·반영되지 않습니다. 아래 '선택 항목 일괄 적용'을 눌러야 적용됩니다. 고르지 않은 항목은 그대로 남습니다.</span></div>}
                <ul className="inbox-list">
                  {items.map((it, i) => (
                    <li key={it.key} className={`inbox-item${it.urgent ? ' is-urgent' : ''}`}>
                      <div className="inbox-meta small"><span className={`badge ${it.urgent ? 'badge-warn' : 'badge-info'}`}>{KIND[it.kind]}{it.urgent ? ' · 미션 대기' : ''}</span> <b>{it.missionTitle}</b> · {it.task}</div>
                      <div className="inbox-q">{it.question}</div>
                      {it.held && <div className="small muted">보류 사유: {it.held}</div>}
                      {it.explain && <div className="small inbox-explain">{it.explain}</div>}
                      {it.grants && <div className="small inbox-grants">허용하면: {it.grants}</div>}
                      {it.resumes && <div className="small muted">재개될 작업: {it.resumes}</div>}
                      {batchable(it) ? (
                        <div className="inbox-choices" role="radiogroup" aria-label={it.question}>
                          {it.choices.map((c) => (
                            <label key={c.label} className={`review-cp-choice${sel[it.key] === c.label && !ownMap[it.key]?.trim() ? ' is-on' : ''}`}>
                              <input type="radio" name={`ib-${it.key}`} checked={sel[it.key] === c.label && !ownMap[it.key]?.trim()} onChange={() => { setSel((x) => ({ ...x, [it.key]: c.label })); setOwnMap((x) => ({ ...x, [it.key]: '' })); }} />
                              <span><b>{c.label}</b>{c.recommended && <span className="badge badge-info">추천</span>}{c.effect && <span className="muted small"> — {c.effect}</span>}{c.recommended && c.why && <span className="small review-cp-why">추천 이유: {c.why}</span>}</span>
                            </label>
                          ))}
                          {it.kind !== 'permission' && <input className="input" placeholder={it.choices.length ? '직접 적기(선택)' : '답을 적어 주세요'} value={ownMap[it.key] ?? ''} onChange={(e) => setOwnMap((x) => ({ ...x, [it.key]: e.target.value }))} />}
                          {answerOf(it) && <span className="small inbox-picked">선택됨(적용 전): {answerOf(it).slice(0, 80)} <button className="btn-link small" onClick={() => { setSel((x) => { const n = { ...x }; delete n[it.key]; return n; }); setOwnMap((x) => ({ ...x, [it.key]: '' })); }}>선택 해제</button></span>}
                        </div>
                      ) : (
                        <div className="row gap"><button className="btn btn-sm btn-primary" onClick={() => { setIdx(i); setView('item'); setDone(null); }}>{it.kind === 'checkpoint' ? '결과 보고 시연 열기' : '자세히 보고 정하기'}</button></div>
                      )}
                    </li>
                  ))}
                </ul>
                {items.some(batchable) && (
                  <div className="row gap inbox-foot">
                    <button className="btn btn-primary" disabled={act.busy || !picked.length} onClick={() => void applySelected()}>선택 항목 일괄 적용({picked.length})</button>
                    <span className="muted small">적용 직전에 각 항목이 아직 유효한지 다시 확인합니다.</span>
                  </div>
                )}
                {act.error && <Banner>{act.error}</Banner>}
              </div>
            ) : cur ? (
              <>
              <div className="decision-body">
                {done && <div className="decision-done">{done}</div>}
                <div className="decision-where">
                  <div><span className="muted small">미션</span> <strong>{cur.projectName}</strong> · {cur.missionTitle}</div>
                  <div><span className="muted small">작업</span> {cur.task}</div>
                  {cur.waiting && <div className="muted small decision-wait">미션이 이 결정을 기다리며 멈춰 있습니다. 고르기 전에는 진행하지 않습니다.</div>}
                </div>
                {cur.kind !== 'checkpoint' && <div className="decision-q">{cur.question}</div>}
                {cur.explain && cur.kind !== 'checkpoint' && <div className="decision-explain small">{cur.explain}</div>}
                {cur.kind === 'commit' && cur.commit && (
                  <div className="decision-commit" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 16px', borderRadius: 10, background: 'var(--bg-soft, #f5f6f8)', lineHeight: 1.6 }}>
                    <div className="small"><span className="muted">저장소</span> {cur.commit.repo || '(연결 폴더)'}
                      {preview && <> · <span className="muted">받을 브랜치</span> <b>{preview.target ?? '—'}</b>{preview.target && preview.target !== preview.branch ? <span className="muted"> (지금 {preview.branch}에는 바로 커밋하지 않음{preview.target ? ', 같은 이름이 있으면 번호를 붙임' : ''})</span> : null}</>}
                    </div>
                    <div className="small"><span className="muted">커밋 메시지</span> <code>{cur.commit.message}</code></div>
                    {!preview && !previewErr && <div className="muted small">저장소 상태를 확인하는 중…</div>}
                    {previewErr && <Banner>{previewErr}</Banner>}
                    {preview?.error && <Banner>{preview.error}</Banner>}
                    {preview && preview.files.length > 0 && (
                      <ul className="decision-files" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
                        {preview.files.map((f) => (
                          <li key={f.path} className={f.flags.length ? 'is-bad' : ''} style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', color: f.flags.length ? 'var(--danger, #b42318)' : undefined }}>
                            <span className="mono small">{f.path}</span>
                            <span className="small decision-num muted">{f.status.trim() === '??' ? '새 파일' : f.status.includes('D') ? '삭제' : '수정'}{f.added !== null ? ` +${f.added}` : ''}{f.removed !== null ? ` −${f.removed}` : ''}</span>
                            {f.flags.map((fl) => <span key={fl} className="badge badge-warn">{preview.flagLabels[fl] ?? fl}</span>)}
                          </li>
                        ))}
                      </ul>
                    )}
                    {preview && preview.blocked.length > 0 && <div className="small decision-blocked" style={{ color: 'var(--danger, #b42318)' }}>표시된 파일 때문에 커밋할 수 없습니다. 거절하면 오퍼레이터가 다른 방법을 찾습니다.</div>}
                    <div className="muted small">승인하면 위 파일만 커밋합니다(다른 변경은 그대로 둠). push·PR·병합은 하지 않습니다. 화면을 연 뒤 파일이 바뀌면 커밋하지 않고 다시 보여 줍니다.</div>
                    <div className="row gap">
                      <button className="btn btn-primary" disabled={act.busy || !preview || !!preview.error || preview.blocked.length > 0} onClick={() => void approveCommit()}>커밋 승인</button>
                      <button className="btn" disabled={act.busy} onClick={() => void declineCommit()}>커밋하지 않음</button>
                      <button className="btn-link small" disabled={act.busy} onClick={loadPreview}>다시 확인</button>
                    </div>
                  </div>
                )}
                {cur.kind === 'checkpoint' && (cpMission?.id === cur.missionId && cpMission.checkpoint
                  ? <ReviewCheckpoint mission={cpMission} onChanged={afterCheckpoint} />
                  : <div className="muted small">검토 카드를 불러오는 중…</div>)}
                {cur.kind === 'permission' && items.filter((x) => x.kind === 'permission' && x.missionId === cur.missionId && !!x.denial?.suggestion && x.denial.kind !== 'other').length > 1 && (
                  <div className="decision-batch small">
                    <span>이 미션의 권한 항목 {items.filter((x) => x.kind === 'permission' && x.missionId === cur.missionId).length}건: </span>
                    {items.filter((x) => x.kind === 'permission' && x.missionId === cur.missionId).map((x) => <span key={x.key} className="mono">{x.denial?.suggestion ?? x.denial?.target} </span>)}
                    <button className="btn btn-sm" disabled={act.busy} onClick={() => void allowAll()}>모두 허용(각 직원에게만)</button>
                  </div>
                )}
                {rec && <div className="decision-rec small"><span className="badge badge-info">추천</span> {rec.label}{rec.why ? ` — ${rec.why}` : ''} <span className="muted">(자동으로 고르지 않습니다)</span></div>}
                <ul className="decision-choices">
                  {cur.choices.map((c, i) => (
                    <li key={i} className={c.recommended ? 'is-rec' : ''}>
                      <button className="btn decision-choice" disabled={act.busy} onClick={() => void choose(c.label, c.action, c.effect)}>
                        <span className="decision-label">{c.label}{c.recommended && <span className="badge badge-info">추천</span>}</span>
                        {c.effect && <span className="decision-effect small">고르면: {c.effect}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
                {cur.choices.length === 0 && cur.kind !== 'commit' && cur.kind !== 'checkpoint' && <div className="muted small">고를 선택지가 없는 질문입니다. 아래에 답을 적어 보내면 미션이 그 답으로 이어서 진행합니다.</div>}
                {cur.kind !== 'permission' && cur.kind !== 'commit' && cur.kind !== 'checkpoint' && <div className="row gap decision-own">
                  <input className="input" value={own} placeholder={cur.choices.length ? '다른 답을 직접 적기' : '답을 적어 주세요'} onChange={(e) => setOwn(e.target.value)} />
                  <button className="btn" disabled={act.busy || !own.trim()} onClick={() => void choose(own)}>이 답으로 정하기</button>
                </div>}
                {act.error && <Banner>{act.error}</Banner>}
              </div>
              <div className="decision-foot">
                <button className="btn-link small" onClick={() => { onOpenMission(cur.projectId, cur.missionId); setOpen(false); }}>미션 화면에서 자세히</button>
                <div className="decision-foot-nav">
                  {items.length > 1 && <button className="btn" onClick={() => setIdx((i) => (i - 1 + items.length) % items.length)}>이전</button>}
                  {items.length > 1 && <button className="btn" onClick={() => setIdx((i) => (i + 1) % items.length)}>다음 결정</button>}
                </div>
              </div>
              </>
            ) : (
              <div className="decision-body">{done && <div className="decision-done">{done}</div>}<div className="muted">남은 결정이 없습니다.</div></div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
