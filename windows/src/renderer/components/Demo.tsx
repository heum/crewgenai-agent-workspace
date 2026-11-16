// 시연: 결과물 카드의 '시연 열기'로 실제 기능을 바로 써 본다. 서비스가 꺼져 있으면 앱 안에서 켠다(처음 한 번은 실행 승인).
// 화면이면 기본 브라우저로 그 화면 주소를, API면 앱 안 API 시연 화면(요청 예시·직접 호출·실제 응답)을 연다.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DemoApi, DemoData, DemoInfo, DemoResponse, DemoState, ResultDemo } from '../../shared/types';
import { useAction, ws } from '../api';
import { Banner, Modal } from './common';

export const DATA_LABEL: Record<DemoData, string> = { 'api+db': 'API·DB 연결', 'screen-only': '화면만(API·DB 미연결)', mock: '예시·대체 데이터' };
const STATUS_LABEL: Record<DemoState['status'], string> = { running: '실행 중', starting: '시작 중', stopped: '중지됨', needs_approval: '준비 필요(실행 승인)' };

export function useDemo(projectId: string) {
  const [info, setInfo] = useState<DemoInfo | null>(null);
  const reload = useCallback(() => ws().demoInfo(projectId).then(setInfo).catch(() => {}), [projectId]);
  useEffect(() => { void reload(); const iv = setInterval(() => void reload(), 5000); return () => clearInterval(iv); }, [reload]);
  return { info, setInfo, reload };
}

function StatusPill({ st }: { st: DemoState | undefined }) {
  if (!st) return <span className="demo-pill demo-pill-missing">시연 목록에 없음</span>;
  return <span className={`demo-pill demo-pill-${st.status}`}>{STATUS_LABEL[st.status]}</span>;
}

function ApproveDialog({ st, onOk, onClose, busy }: { st: DemoState; onOk: () => void; onClose: () => void; busy: boolean }) {
  const s = st.service;
  return (
    <Modal title={`시연 실행 승인 — ${s.name}`} onClose={onClose}>
      <div className="modal-body demo-approve">
        <p>이 서비스를 시연하려면 아래 명령을 <b>이 PC에서 직접 실행</b>합니다. 직원 작업과 달리 격리(샌드박스) 밖에서 돌며, 그 저장소의 빌드 폴더 등에 파일이 생길 수 있습니다. 명령·폴더·환경값이 바뀌면 다시 묻습니다.</p>
        <dl className="demo-dl">
          <dt>폴더</dt><dd className="mono">{s.repo || '(프로젝트 폴더)'}</dd>
          <dt>명령</dt><dd className="mono">{s.start.join(' ')}</dd>
          {s.port && <><dt>주소</dt><dd className="mono">http://127.0.0.1:{s.port} (상태 확인 {s.health})</dd></>}
          {Object.keys(s.env).length > 0 && <><dt>환경값</dt><dd className="mono">{Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join('  ')}</dd></>}
          {s.needs.length > 0 && <><dt>먼저 켤 서비스</dt><dd>{s.needs.join(', ')}</dd></>}
          <dt>데이터</dt><dd>{DATA_LABEL[s.data]}{s.note ? ` — ${s.note}` : ''}</dd>
        </dl>
        <div className="row gap demo-approve-actions">
          <button className="btn" onClick={onClose}>취소</button>
          <button className="btn btn-primary" disabled={busy} onClick={onOk}>허용하고 시작</button>
        </div>
      </div>
    </Modal>
  );
}

export function useDemoOpener(projectId: string, demo: ReturnType<typeof useDemo>) {
  const act = useAction();
  const [approve, setApprove] = useState<{ st: DemoState; then: () => void } | null>(null);
  const [consoleFor, setConsoleFor] = useState<{ service: string; api: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const chain = (id: string, info: DemoInfo, seen = new Set<string>()): DemoState[] => {
    const st = info.services.find((x) => x.service.id === id); if (!st || seen.has(id)) return [];
    seen.add(id);
    return [...st.service.needs.flatMap((n) => chain(n, info, seen)), st];
  };
  const open = (d: ResultDemo): Promise<void | undefined> => act.run(async () => {
    const info = await ws().demoInfo(projectId); demo.setInfo(info);
    const need = chain(d.service, info);
    if (!need.length) throw new Error(`시연 목록에 '${d.service}' 서비스가 없습니다.`);
    const unapproved = need.find((x) => !x.approved);
    if (unapproved) { setApprove({ st: unapproved, then: () => void open(d) }); return; }
    const target = need[need.length - 1];
    if (target.status !== 'running') {
      setNote(`'${target.service.name}'을(를) 켜는 중입니다(최대 ${target.service.startupSec}초)…`);
      try { demo.setInfo(await ws().demoStart(projectId, d.service)); } finally { setNote(null); }
    }
    if (d.api) { setConsoleFor({ service: d.service, api: d.api }); return; }
    const st = (await ws().demoInfo(projectId)).services.find((x) => x.service.id === d.service);
    if (!st?.url) throw new Error('이 서비스에는 열 화면 주소가 없습니다.');
    await ws().openLocalUrl(`${st.url}${d.path || '/'}`);
  });
  const doApprove = () => act.run(async () => {
    if (!approve) return;
    demo.setInfo(await ws().demoApprove(projectId, approve.st.service.id, approve.st.hash));
    const next = approve.then; setApprove(null); next();
  });
  const ui = (
    <>
      {note && <div className="demo-note">{note}</div>}
      {approve && <ApproveDialog st={approve.st} busy={act.busy} onOk={() => void doApprove()} onClose={() => setApprove(null)} />}
      {consoleFor && demo.info && <ApiConsole projectId={projectId} info={demo.info} service={consoleFor.service} focus={consoleFor.api} onClose={() => setConsoleFor(null)} />}
    </>
  );
  return { open, act, ui, openConsole: (service: string) => setConsoleFor({ service, api: '' }) };
}

export function DemoBlock({ d, info, onOpen, busy }: { d: ResultDemo; info: DemoInfo | null; onOpen: () => void; busy: boolean }) {
  const st = info?.services.find((x) => x.service.id === d.service);
  const api = d.api ? info?.apis.find((a) => a.service === d.service && a.id === d.api) : undefined;
  return (
    <div className="demo-block">
      <div className="demo-block-head">
        <button className="btn btn-primary btn-sm" disabled={busy || !st} onClick={onOpen}>시연 열기</button>
        <span className="demo-target">{st?.service.name ?? d.service}{api ? ` · API: ${api.title}` : d.path && d.path !== '/' ? ` · 화면 ${d.path}` : ''}</span>
        <StatusPill st={st} />
        <span className={`demo-data demo-data-${d.data.replace('+', '')}`}>{DATA_LABEL[d.data]}</span>
      </div>
      {d.steps && <div className="small demo-steps"><span className="muted">확인 순서</span> {d.steps}</div>}
      {d.expected && <div className="small"><span className="muted">예상 결과</span> {d.expected}</div>}
    </div>
  );
}

export function DemoBar({ projectId, demo, onConsole }: { projectId: string; demo: ReturnType<typeof useDemo>; onConsole: (service: string) => void }) {
  const act = useAction();
  const [log, setLog] = useState<{ name: string; text: string } | null>(null);
  const info = demo.info;
  if (!info) return null;
  if (!info.exists) return <div className="demo-bar muted small">시연 목록이 아직 없습니다({info.relPath}). 실행 가능한 기능을 만드는 작업에서 직원이 마련합니다.</div>;
  return (
    <div className="demo-bar">
      <div className="demo-bar-head"><strong>시연 환경</strong><span className="muted small">{info.services.length}개 서비스 · API {info.apis.length}개</span></div>
      {info.errors.length > 0 && <div className="demo-errors small">시연 목록 오류: {info.errors.slice(0, 3).join(' / ')}</div>}
      <ul className="demo-services">
        {info.services.map((st) => (
          <li key={st.service.id}>
            <span className="demo-svc-name">{st.service.name}</span>
            <StatusPill st={st} />
            {st.url && <span className="muted small mono">{st.url.replace('http://', '')}</span>}
            <span className="demo-svc-actions">
              {st.status === 'running' && st.url && <button className="btn-link small" onClick={() => void act.run(() => ws().openLocalUrl(st.url!))}>열기</button>}
              {st.service.port && info.apis.some((a) => a.service === st.service.id) && <button className="btn-link small" onClick={() => onConsole(st.service.id)}>API 시연</button>}
              {st.ours && st.status !== 'stopped' && <button className="btn-link small" onClick={() => void act.run(async () => { demo.setInfo(await ws().demoStop(projectId, st.service.id)); })}>중지</button>}
              {st.ours && <button className="btn-link small" onClick={() => void act.run(async () => { setLog({ name: st.service.name, text: await ws().demoLog(projectId, st.service.id) }); })}>기록</button>}
            </span>
          </li>
        ))}
      </ul>
      {act.error && <Banner>{act.error}</Banner>}
      {log && <Modal title={`시연 기록 — ${log.name}`} wide onClose={() => setLog(null)}><div className="modal-body"><pre className="pre small result-view">{log.text || '(기록 없음)'}</pre></div></Modal>}
    </div>
  );
}

function ApiConsole({ projectId, info, service, focus, onClose }: { projectId: string; info: DemoInfo; service: string; focus: string; onClose: () => void }) {
  const apis = useMemo(() => info.apis.filter((a) => a.service === service), [info.apis, service]);
  const svc = info.services.find((x) => x.service.id === service);
  const [sel, setSel] = useState<DemoApi | null>(() => apis.find((a) => a.id === focus) ?? apis[0] ?? null);
  const [method, setMethod] = useState(''); const [path, setPath] = useState(''); const [headers, setHeaders] = useState(''); const [body, setBody] = useState('');
  const [res, setRes] = useState<DemoResponse | null>(null);
  const act = useAction();
  useEffect(() => { if (!sel) return; setMethod(sel.method); setPath(sel.path); setHeaders(JSON.stringify(sel.headers, null, 2)); setBody(sel.body); setRes(null); }, [sel]);
  const groups = [...new Set(apis.map((a) => a.group))];
  const send = () => act.run(async () => {
    let h: Record<string, string> = {};
    try { h = headers.trim() ? JSON.parse(headers) : {}; } catch { throw new Error('헤더는 JSON 객체로 적어 주세요. 예: {"Authorization": "Bearer {{token}}"}'); }
    setRes(await ws().demoRequest(projectId, service, { method, path, headers: h, body, capture: sel?.capture }));
  });
  let pretty = res?.body ?? '';
  try { const t = res?.body.trim() ?? ''; if (t.startsWith('{') || t.startsWith('[')) pretty = JSON.stringify(JSON.parse(t), null, 2); } catch { /* JSON 아님 */ }
  return (
    <Modal title={`API 시연 — ${svc?.service.name ?? service}`} wide onClose={onClose}>
      <div className="api-console">
        <nav className="api-list" aria-label="API 목록">
          {groups.map((g) => (
            <div key={g}>
              <div className="api-group">{g}</div>
              {apis.filter((a) => a.group === g).map((a) => (
                <button key={a.id} className={`api-item${sel?.id === a.id ? ' is-on' : ''}`} onClick={() => setSel(a)}>
                  <span className={`api-m api-m-${a.method.toLowerCase()}`}>{a.method}</span><span className="api-t">{a.title}</span>
                </button>
              ))}
            </div>
          ))}
          <button className="btn-link small" onClick={() => void act.run(async () => { await ws().demoReset(projectId, service); setRes(null); })}>로그인 상태 초기화</button>
        </nav>
        <section className="api-main">
          {svc && svc.status !== 'running' && <div className="demo-errors small">이 서비스가 {STATUS_LABEL[svc.status]} 상태입니다. 결과물 카드의 '시연 열기'로 켠 뒤 보내세요.</div>}
          {sel?.description && <p className="small api-desc">{sel.description}</p>}
          {sel?.expect && <p className="small"><span className="muted">예상 응답</span> {sel.expect}</p>}
          <div className="row gap api-line">
            <select value={method} onChange={(e) => setMethod(e.target.value)}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m}>{m}</option>)}</select>
            <span className="muted mono small">{svc?.url ?? ''}</span>
            <input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} aria-label="경로" />
            <button className="btn btn-primary" disabled={act.busy} onClick={() => void send()}>보내기</button>
          </div>
          <label className="small muted">헤더(JSON · {'{{이름}}'}은 앞 응답에서 잡아 둔 값)</label>
          <textarea className="input mono small" rows={3} value={headers} onChange={(e) => setHeaders(e.target.value)} />
          {method !== 'GET' && method !== 'DELETE' && <><label className="small muted">본문</label><textarea className="input mono small" rows={6} value={body} onChange={(e) => setBody(e.target.value)} /></>}
          {act.error && <Banner>{act.error}</Banner>}
          {res && (
            <div className="api-res">
              <div className="row gap"><span className={`api-status api-status-${Math.floor(res.status / 100)}xx`}>{res.status}</span><span className="muted small">{res.ms}ms</span>{res.vars.length > 0 && <span className="muted small">잡아 둔 값: {res.vars.join(', ')}</span>}{res.cookies.length > 0 && <span className="muted small">쿠키: {res.cookies.join(', ')}</span>}</div>
              <pre className="pre small result-view">{pretty || '(빈 응답)'}</pre>
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
