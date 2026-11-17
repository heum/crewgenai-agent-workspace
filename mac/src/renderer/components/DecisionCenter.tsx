// 결정 팝업: 사용자가 정해야 하는 것이 생기면 어느 탭에서든 팝업으로 알리고, 그 자리에서 버튼으로 고르게 한다.
// 추천안은 '추천' 표시와 이유만 보여 주고 자동으로 고르지 않는다. 닫아도 오른쪽 아래 '결정 대기'로 다시 열 수 있다.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CommitPreview, LiveEvent, PendingDecision } from '../../shared/types';
import { useAction, ws } from '../api';
import { Banner } from './common';

export default function DecisionCenter({ onOpenMission }: { onOpenMission: (projectId: string, missionId: string) => void }) {
  const [items, setItems] = useState<PendingDecision[]>([]);
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const [own, setOwn] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const seen = useRef<Set<string>>(new Set()); // 이미 팝업으로 보여 준 결정(닫으면 같은 결정으로 다시 띄우지 않음)
  const handled = useRef<Set<string>>(new Set()); // 이번에 정한 권한 항목(보류 유지 포함) — 다시 묻지 않음
  const act = useAction();

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      ws().pendingDecisions().then((all) => {
        const list = all.filter((x) => !handled.current.has(x.key));
        setItems(list);
        const fresh = list.filter((d) => !seen.current.has(d.key));
        if (fresh.length) { for (const d of fresh) seen.current.add(d.key); setIdx(Math.max(0, list.findIndex((d) => d.key === fresh[0].key))); setDone(null); setOpen(true); }
      }).catch(() => {});
    };
    load();
    const off = ws().onLive((e: LiveEvent) => { if (e.type === 'mission') { if (t) clearTimeout(t); t = setTimeout(load, 400); } });
    // 다른 화면(사무실의 '확인 필요' 등)에서 결정 팝업을 연다
    const openNow = () => { ws().pendingDecisions().then((all) => { const list = all.filter((x) => !handled.current.has(x.key)); for (const d of list) seen.current.add(d.key); setItems(list); setIdx(0); setDone(null); setOpen(true); }).catch(() => {}); };
    window.addEventListener('crewgenai:open-decisions', openNow);
    return () => { off(); if (t) clearTimeout(t); window.removeEventListener('crewgenai:open-decisions', openNow); };
  }, []);

  const cur = items[Math.min(idx, items.length - 1)] ?? null;
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
    const list = (await ws().pendingDecisions()).filter((x) => !handled.current.has(x.key));
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
    const list = (await ws().pendingDecisions()).filter((x) => !handled.current.has(x.key));
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
      const list = (await ws().pendingDecisions()).filter((x) => !handled.current.has(x.key));
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
    const list = (await ws().pendingDecisions()).filter((x) => !handled.current.has(x.key));
    for (const d of list) seen.current.add(d.key);
    setItems(list);
    setDone(action === 'stop' ? `'${label.trim()}' — 미션을 종료했습니다.` : `'${label.trim()}'로 정했습니다. ${cur.kind === 'question' || cur.waiting ? '미션이 이 결정으로 이어서 진행합니다.' : '다음 계획부터 이 결정을 따릅니다.'}`);
    setIdx(0);
    if (!list.length) setTimeout(() => setOpen(false), 1800);
  });

  if (!items.length && !open) return null;
  return (
    <>
      {items.length > 0 && !open && (
        <button className="decision-badge" onClick={() => { setDone(null); setIdx(0); setOpen(true); }} title="정해야 할 결정을 다시 엽니다">
          결정 대기 {items.length}
        </button>
      )}
      {open && (
        <div className="modal-back" role="presentation">
          <div className="modal decision-modal" role="dialog" aria-modal="true" aria-label="결정이 필요합니다">
            <div className="modal-head">
              <h2>결정이 필요합니다{items.length > 1 ? ` (${Math.min(idx, items.length - 1) + 1}/${items.length})` : ''}</h2>
              <button className="btn" onClick={() => setOpen(false)}>나중에</button>
            </div>
            {cur ? (
              <>
              <div className="decision-body">
                {done && <div className="decision-done">{done}</div>}
                <div className="decision-where">
                  <div><span className="muted small">미션</span> <strong>{cur.projectName}</strong> · {cur.missionTitle}</div>
                  <div><span className="muted small">작업</span> {cur.task}</div>
                  {cur.waiting && <div className="muted small decision-wait">미션이 이 결정을 기다리며 멈춰 있습니다. 고르기 전에는 진행하지 않습니다.</div>}
                </div>
                <div className="decision-q">{cur.question}</div>
                {cur.explain && <div className="decision-explain small">{cur.explain}</div>}
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
                {cur.kind === 'checkpoint' && (
                  <div className="row gap">
                    <button className="btn btn-primary" onClick={() => { onOpenMission(cur.projectId, cur.missionId); setOpen(false); }}>검토 화면 열기</button>
                    <span className="muted small">시연·확인 순서·미검증 범위·정할 것을 한 화면에서 보고 피드백을 한 번에 보냅니다.</span>
                  </div>
                )}
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
