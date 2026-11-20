// 문의 대화창: 개발을 멈추지 않고 문의 응대(HD) 직원에게 프로젝트·진행 상황을 바로 묻는다.
// 대화는 프로젝트별로 이 PC에만 저장된다. 직원이 제안한 추가 지시는 사용자가 눌러야 오퍼레이터에게 전달된다.
import { useEffect, useRef, useState } from 'react';
import type { LiveEvent, Project, QaMessage } from '../../shared/types';
import { fmtDate, isComposingEnter, useAction, ws } from '../api';
import { Markdown } from '../markdown';
import { Banner } from './common';

const OPEN_KEY = 'crewgenai.qaOpen';

export default function QaChat({ project }: { project: Project }) {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; } });
  const toggle = (v: boolean) => { setOpen(v); try { localStorage.setItem(OPEN_KEY, v ? '1' : '0'); } catch { /* 저장 안 됨 */ } };
  if (!open) return <button className="qa-fab" onClick={() => toggle(true)} title="문의 응대 직원에게 궁금한 것을 묻기(개발은 멈추지 않음)">💬 문의</button>;
  return <QaPanel key={project.id} project={project} onClose={() => toggle(false)} />;
}

function QaPanel({ project, onClose }: { project: Project; onClose: () => void }) {
  const [msgs, setMsgs] = useState<QaMessage[]>([]);
  const [text, setText] = useState('');
  const [waiting, setWaiting] = useState<string | null>(null);
  const act = useAction();
  const box = useRef<HTMLDivElement | null>(null);
  const load = () => ws().qaList(project.id).then(setMsgs).catch(() => {});
  useEffect(() => {
    void load();
    const off = ws().onLive((e: LiveEvent) => { if (e.type === 'qa' && e.projectId === project.id) void load(); });
    return off;
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const el = box.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs.length, waiting]);
  const send = () => {
    const q = text.trim(); if (!q || waiting) return;
    setText(''); setWaiting(q);
    void act.run(async () => { try { setMsgs(await ws().qaAsk(project.id, q)); } catch (e) { setText(q); throw e; } finally { setWaiting(null); } });
  };
  return (
    <aside className="qa-panel" aria-label="문의 대화">
      <header className="qa-head">
        <div><strong>문의</strong> <span className="muted small">HD 문의 응대 · {project.plan.name}</span></div>
        <div className="row gap">
          <button className="btn-link small" disabled={!!waiting || !msgs.length} onClick={() => { if (window.confirm('이 프로젝트의 문의 대화를 지울까요?')) void act.run(async () => { await ws().qaClear(project.id); setMsgs([]); }); }}>지우기</button>
          <button className="btn-link" onClick={onClose} aria-label="닫기">✕</button>
        </div>
      </header>
      <div className="qa-body" ref={box}>
        {!msgs.length && !waiting && (
          <div className="muted small qa-empty">
            지금 무엇을 하는지, 왜 그렇게 했는지, 파일이 어디 있는지처럼 궁금한 것을 물어보세요. 개발은 멈추지 않습니다.
            답은 진행 기록·작업 목록·프로젝트 파일을 읽고 만들며, 이 대화는 미션 지시로 전달되지 않습니다(직원이 제안한 추가 지시만 버튼으로 보낼 수 있음).
          </div>
        )}
        {msgs.map((m) => (
          <div key={m.seq} className={`qa-msg ${m.role === 'user' ? 'mine' : ''} ${m.error ? 'is-error' : ''}`}>
            <div className="qa-meta small muted">{m.role === 'user' ? '나' : m.who ?? '문의 응대'} · {fmtDate(m.at)}</div>
            {m.role === 'user' ? <div className="qa-text">{m.text}</div> : <div className="qa-text"><Markdown text={m.text} /></div>}
            {m.directive && (
              <div className="qa-directive">
                <div className="small"><b>추가 지시 제안</b> — 누르기 전에는 전달되지 않습니다</div>
                <div className="qa-directive-text">{m.directive}</div>
                <button className="btn btn-sm" disabled={!!m.directiveSent || act.busy} onClick={() => void act.run(async () => setMsgs(await ws().qaSendDirective(project.id, m.seq)))}>
                  {m.directiveSent ? '보냄' : '추가 지시로 보내기'}
                </button>
              </div>
            )}
          </div>
        ))}
        {waiting && (
          <>
            <div className="qa-msg mine"><div className="qa-meta small muted">나</div><div className="qa-text">{waiting}</div></div>
            <div className="qa-msg"><div className="qa-meta small muted">문의 응대</div><div className="qa-text muted">답을 찾는 중… (보통 수십 초)</div></div>
          </>
        )}
      </div>
      {act.error && <Banner onClose={() => act.setError(null)}>{act.error}</Banner>}
      <div className="qa-input">
        <textarea className="input" rows={2} value={text} placeholder="궁금한 것을 입력하세요 (Enter 보내기, Shift+Enter 줄바꿈)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !isComposingEnter(e)) { e.preventDefault(); send(); } }} />
        <button className="btn btn-primary" disabled={!text.trim() || !!waiting} onClick={send}>보내기</button>
      </div>
    </aside>
  );
}
