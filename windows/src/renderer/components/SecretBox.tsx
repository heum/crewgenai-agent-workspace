// 확인함의 비밀값(API 키 등) 입력: 값은 앱 본체가 연결 폴더의 .env 파일에만 저장한다(화면·기록·텔레그램에 남기지 않음).
import { useState } from 'react';
import type { PendingDecision } from '../../shared/types';

const ws = () => window.workspace;
/** 비밀값을 넣어야 하는 결정처럼 보이는가(오퍼레이터가 저장 위치를 주지 않은 예전 항목용) */
export const KEYISH = /API\s*키|api[\s_-]*key|시크릿|secret|토큰|token|\.env|비밀값|접속 정보|자격 증명|credential/i;
export const wantsSecret = (it: PendingDecision) => it.kind === 'gap' && (!!it.secret || KEYISH.test(`${it.question}\n${it.explain}`));

export function SecretBox({ it, onSaved }: { it: PendingDecision; onSaved: (line: string) => void }) {
  const given = it.secret;
  const [open, setOpen] = useState(!!given);
  const [file, setFile] = useState(given?.file ?? '.env');
  const [name, setName] = useState(given?.name ?? '');
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) return <button className="btn-link small secret-open" onClick={() => setOpen(true)}>🔑 API 키를 앱에서 입력해 .env 파일에 저장</button>;
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await ws().saveSecret({ key: it.key, file, name, value });
      if (r.ok) { setValue(''); onSaved(r.line); } else setErr(r.error);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="secret-box small">
      <div className="secret-head"><b>🔑 비밀값 넣기</b>{given?.saved && <span className="badge badge-info">지금 값이 들어 있음 — 저장하면 바꿉니다</span>}</div>
      {given?.source && <div className="muted">발급 받는 곳: {given.source}</div>}
      <div className="secret-row">
        <label>파일 <input className="input mono" value={file} onChange={(e) => setFile(e.target.value)} disabled={!!given} placeholder="저장소/.env" spellCheck={false} /></label>
        <label>변수 이름 <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} disabled={!!given} placeholder="OPENAI_API_KEY" spellCheck={false} /></label>
      </div>
      <div className="secret-row">
        <input className="input mono secret-value" type={show ? 'text' : 'password'} value={value} onChange={(e) => setValue(e.target.value)} placeholder="값을 붙여 넣으세요" autoComplete="off" spellCheck={false}
          onKeyDown={(e) => { if (e.key === 'Enter' && value.trim() && !busy) void save(); }} />
        <button className="btn btn-sm" type="button" onClick={() => setShow((x) => !x)}>{show ? '가리기' : '보기'}</button>
        <button className="btn btn-sm btn-primary" disabled={busy || !value.trim() || !name.trim() || !file.trim()} onClick={() => void save()}>파일에 저장</button>
      </div>
      {err && <div className="secret-err">{err}</div>}
      <div className="muted">값은 이 PC의 그 파일에만 저장됩니다(커밋 제외 확인 후 저장, 미션 기록·텔레그램에는 남지 않음). 저장하면 이 항목은 '넣었음'으로 처리됩니다.</div>
    </div>
  );
}
