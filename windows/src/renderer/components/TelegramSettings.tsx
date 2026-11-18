// 설정 > 텔레그램: 봇 연결(토큰은 넣기만 하고 다시 보여 주지 않음), 내 계정 연결(일회용 코드 → 앱에서 확인), 알림 범위·종류·묶음, 프로젝트별 소스 상세·화면 미리보기.
// 여기서 바꾼 것은 바로 적용된다(설정 창의 저장 버튼과 별개).
import { useEffect, useState } from 'react';
import type { Project, TgOptionsView, TgStatusView } from '../../shared/types';
import { fmtDate, useAction, useLoad, ws } from '../api';
import { Banner, Field } from './common';

const STATE: Record<TgStatusView['state'], string> = { off: '꺼짐', 'no-token': '토큰 없음', connecting: '연결 중', connected: '연결됨', error: '연결 오류', conflict: '다른 곳과 충돌', unavailable: '사용할 수 없음' };
const KIND: [keyof TgStatusView['settings']['kinds'], string][] = [['review', '결정·검토가 필요할 때'], ['commits', '커밋 승인 요청'], ['results', '큰 결과물 준비·완료 보고'], ['failures', '중요한 실패(같은 실패는 한 번만)'], ['limit', 'Claude 한도 대기·복구'], ['cycle', '사이클 시작·종료(상세, 많음)']];

export default function TelegramSettings() {
  const act = useAction();
  const [st, setSt] = useState<TgStatusView | null>(null);
  const [token, setToken] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const projects = useLoad(() => ws().listProjects(), []);
  const reload = () => ws().telegramStatus().then(setSt).catch(() => {});
  useEffect(() => {
    void reload();
    const off = ws().onLive((e) => { if (e.type === 'telegram') void reload(); });
    const iv = setInterval(() => void reload(), 5000); // 연결 요청·마지막 통신 시각 갱신
    return () => { off(); clearInterval(iv); };
  }, []);
  if (!st) return <p className="muted small">텔레그램 상태를 읽는 중…</p>;
  const s = st.settings;
  const run = (f: () => Promise<TgStatusView | string | void>) => act.run(async () => { setNote(null); const r = await f(); if (typeof r === 'string') setNote(r); else if (r) setSt(r); });
  const opts = (o: Partial<TgOptionsView>) => run(() => ws().telegramSetOptions(o));
  const ps: Project[] = projects.data ?? [];
  const tone = st.state === 'connected' ? 'ok' : st.state === 'error' || st.state === 'conflict' ? 'bad' : '';

  return (
    <div className="tg-settings">
      <div className={`status-card ${tone}`}>
        <strong>{STATE[st.state]}{s.bot ? ` · @${s.bot.username}` : ''}</strong>
        {st.reason && <p>이유: {st.reason}</p>}
        <dl className="kv">
          <dt>마지막 통신</dt><dd>{st.lastOkAt ? fmtDate(st.lastOkAt) : '없음'}</dd>
          <dt>연결한 계정</dt><dd>{s.link ? s.link.name : '없음'}</dd>
          <dt>보낼 알림</dt><dd>{st.pendingOut ? `${st.pendingOut}건 대기(연결되면 보냄)` : '없음'}</dd>
          {st.lastDenied && <><dt>차단한 접근</dt><dd>{st.lastDenied}</dd></>}
        </dl>
        <p className="muted small">봇은 이 컴퓨터에서 실행 중인 앱이 텔레그램에 직접 묻는 방식(롱 폴링)으로 동작합니다. 별도 서버·공개 포트가 필요 없습니다. 창을 닫거나 앱을 완전히 종료하면, 그리고 컴퓨터가 꺼져 있으면 명령을 처리하지 못합니다. 그동안 보낸 명령은 텔레그램이 24시간까지만 보관합니다. 다시 켜지면 오래된(10분 넘은) 상태 변경 명령은 실행하지 않고 다시 확인합니다.</p>
      </div>

      <h4>1. 봇 연결</h4>
      <details className="muted small"><summary>봇 만드는 방법</summary>
        <ol>
          <li>텔레그램에서 <b>@BotFather</b>를 찾아 대화를 열고 <code>/newbot</code>을 보냅니다.</li>
          <li>봇 이름과 아이디(끝이 <code>bot</code>)를 정하면 BotFather가 <b>토큰</b>을 보내 줍니다(숫자:영문 형태).</li>
          <li>그 토큰을 아래 칸에 직접 붙여 넣고 ‘저장·확인’을 누르세요. 토큰은 채팅·문서에 붙여 넣지 마세요.</li>
        </ol>
      </details>
      {!st.secureStore && <Banner>이 컴퓨터에서 운영체제 보안 저장소(Windows DPAPI)를 쓸 수 없어 토큰을 저장할 수 없습니다. 평문으로는 저장하지 않습니다.</Banner>}
      <Field label="봇 토큰" hint={st.tokenSet ? `저장됨 — ${st.tokenHint}. 새로 넣으면 교체됩니다.` : '저장된 토큰 없음. Windows DPAPI로 암호화해 이 컴퓨터에만 저장합니다.'}>
        <input className="input" type="password" autoComplete="off" spellCheck={false} value={token} placeholder={st.tokenSet ? '••••••••(저장됨)' : '123456789:AA…'} onChange={(e) => setToken(e.target.value)} />
      </Field>
      <div className="row gap">
        <button className="btn btn-primary" disabled={act.busy || !token.trim() || !st.secureStore} onClick={() => run(async () => { const r = await ws().telegramSetToken(token); setToken(''); return r; })}>저장·확인</button>
        <button className="btn" disabled={act.busy || !st.tokenSet} onClick={() => run(async () => { const r = await ws().telegramTest(); return r.detail; })}>연결 검사</button>
        {st.tokenSet && <button className="btn danger" disabled={act.busy} onClick={() => { if (confirm('저장된 봇 토큰을 지울까요? 텔레그램 연동이 멈춥니다.')) void run(() => ws().telegramSetToken(null)); }}>토큰 삭제</button>}
      </div>
      <label className="check">
        <input type="checkbox" checked={s.enabled} disabled={!st.tokenSet} onChange={(e) => void opts({ enabled: e.target.checked })} /> 텔레그램 연동 켜기
      </label>

      <h4>2. 내 텔레그램 계정 연결</h4>
      {s.link ? (
        <div className="row gap"><span>연결됨: <b>{s.link.name}</b> ({fmtDate(s.link.at)})</span>
          <button className="btn small" disabled={act.busy} onClick={() => run(() => ws().telegramSendTest())}>테스트 메시지</button>
          <button className="btn small danger" disabled={act.busy} onClick={() => { if (confirm('연결을 해제할까요? 이전 메시지의 버튼으로도 조작할 수 없게 됩니다.')) void run(() => ws().telegramUnlink()); }}>연결 해제</button></div>
      ) : (
        <>
          <p className="muted small">일회용 연결 코드를 만든 뒤 휴대폰 텔레그램에서 링크를 열고 ‘시작’을 누르세요. 그 계정이 아래에 나타나면 여기서 확인해야 연결됩니다(처음 메시지를 보낸 사람을 자동으로 등록하지 않음). 등록한 계정과 봇의 1:1 대화에서만 조작할 수 있습니다.</p>
          <div className="row gap">
            <button className="btn" disabled={act.busy || st.state !== 'connected'} onClick={() => run(() => ws().telegramLinkCode())}>연결 코드 만들기</button>
            {st.state !== 'connected' && <span className="muted small">먼저 봇을 저장하고 연동을 켜서 ‘연결됨’ 상태로 만드세요.</span>}
          </div>
          {s.linkCode && (
            <div className="tg-code">
              <div>코드 <code className="mono">{s.linkCode.code}</code> · {fmtDate(new Date(s.linkCode.expires).toISOString())}까지</div>
              {s.linkCode.link && <div className="small">휴대폰에서 열기: <a href={s.linkCode.link} onClick={(e) => { e.preventDefault(); void ws().openLocalUrl(s.linkCode!.link!).catch(() => navigator.clipboard?.writeText(s.linkCode!.link!)); }}>{s.linkCode.link}</a> (또는 봇에게 <code>/start {s.linkCode.code}</code> 보내기)</div>}
            </div>
          )}
          {s.candidate && (
            <div className="status-card">
              <strong>연결 요청: {s.candidate.name}</strong>
              <p className="small">본인 계정이 맞으면 확인하세요. 아니면 거절하세요.</p>
              <div className="row gap"><button className="btn btn-primary" disabled={act.busy} onClick={() => run(() => ws().telegramLinkConfirm(true, s.candidate!.userId))}>이 계정 연결</button><button className="btn" disabled={act.busy} onClick={() => run(() => ws().telegramLinkConfirm(false))}>거절</button></div>
            </div>
          )}
        </>
      )}

      <h4>3. 알림</h4>
      <Field label="알림 받을 프로젝트" hint="고르지 않으면 모든 프로젝트">
        <div className="tg-projects">{ps.map((p) => (
          <label key={p.id} className="check"><input type="checkbox" checked={!s.projects || s.projects.includes(p.id)} onChange={(e) => { const cur = s.projects ?? ps.map((x) => x.id); const next = e.target.checked ? [...new Set([...cur, p.id])] : cur.filter((x) => x !== p.id); void opts({ projects: next.length === ps.length ? null : next }); }} /> {p.plan.name}</label>
        ))}</div>
      </Field>
      <Field label="알림 종류" hint="작은 작업 완료나 같은 실패는 반복해서 알리지 않습니다.">
        <div className="tg-kinds">{KIND.map(([k, label]) => (
          <label key={k} className="check"><input type="checkbox" checked={s.kinds[k]} onChange={(e) => void opts({ kinds: { ...s.kinds, [k]: e.target.checked } })} /> {label}</label>
        ))}</div>
      </Field>
      <Field label="묶음 알림(분)" hint="0이면 바로. 결정·커밋 승인 요청은 늘 바로 보냅니다.">
        <input className="input" type="number" min={0} max={240} value={s.batchMinutes} onChange={(e) => void opts({ batchMinutes: Number(e.target.value) })} />
      </Field>

      <h4>4. 프로젝트별 전송 범위</h4>
      <p className="muted small">커밋 ‘변경 상세’에 코드 차이까지 보낼지, 결과물의 시연 화면 미리보기(사진)를 보낼지 프로젝트별로 정합니다. 허용해도 비밀값 파일·비밀값으로 보이는 줄은 보내지 않습니다. 민감한 자료가 보이는 화면은 허용하지 마세요.</p>
      {ps.map((p) => <ProjectScope key={p.id} p={p} st={st} onSet={(o) => void opts(o)} />)}
      {note && <div className="ok-line small">{note}</div>}
      {act.error && <Banner>{act.error}</Banner>}
    </div>
  );
}

function ProjectScope({ p, st, onSet }: { p: Project; st: TgStatusView; onSet: (o: Partial<TgOptionsView>) => void }) {
  const demo = useLoad(() => ws().demoInfo(p.id), [p.id]);
  const s = st.settings; const allowed = s.preview[p.id] ?? [];
  return (
    <div className="tg-scope">
      <b>{p.plan.name}</b>
      <label className="check"><input type="checkbox" checked={!!s.sourceDetail[p.id]} onChange={(e) => onSet({ sourceDetail: { ...s.sourceDetail, [p.id]: e.target.checked } })} /> 커밋 변경 상세에 코드 차이 보내기</label>
      {(demo.data?.services ?? []).filter((x) => x.service.kind !== 'api').map((x) => (
        <label key={x.service.id} className="check"><input type="checkbox" checked={allowed.includes(x.service.id)} onChange={(e) => onSet({ preview: { ...s.preview, [p.id]: e.target.checked ? [...new Set([...allowed, x.service.id])] : allowed.filter((y) => y !== x.service.id) } })} /> 화면 미리보기 허용: {x.service.name}</label>
      ))}
    </div>
  );
}
