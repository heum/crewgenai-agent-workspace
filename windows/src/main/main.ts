// Electron 메인 프로세스 — 창·메뉴·IPC·파일 선택·탐색기·격리 미리보기·종료 처리
import { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, safeStorage, session, shell, type MenuItemConstructorOptions } from 'electron';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LiveEvent } from '../shared/types';
import { createTracer } from './langsmith';
import { Service } from './service';
import { TelegramBridge } from './telegram';
import { loadTemplates } from './docset';
import { publicWebUrl } from './refs';
import { looksSecretName } from './git';

app.setName('CREWGENAI 개발팀 관리');
const dataDir = process.env.CREWGENAI_DATA_DIR || app.getPath('userData');
// 시험·화면 캡처용 데이터 폴더를 지정하면 Electron 저장소(로컬 저장·단일 실행 잠금)도 그 폴더를 써서, 켜져 있는 앱과 섞이지 않고 함께 실행된다
if (process.env.CREWGENAI_DATA_DIR) app.setPath('userData', dataDir);
mkdirSync(dataDir, { recursive: true });
const resDir = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources');
const logFile = join(dataDir, 'app.log');
const log = (m: string) => { try { writeFileSync(logFile, `${new Date().toISOString()} ${m}\n`, { flag: 'a' }); } catch { /* 무시 */ } };

// 이 Electron의 내장 fetch(undici)가 일부 macOS에서 소켓 설정(setTypeOfService EINVAL)으로 던지는 예외는 기록만 하고 오류 창을 띄우지 않는다
// (앱 요청은 http.ts의 safeFetch를 쓰므로 해당 없음. 다른 라이브러리가 fetch를 써도 앱이 멈추지 않게). 그 밖의 예기치 않은 오류는 그대로 알린다.
process.on('uncaughtException', (e) => {
  log(`uncaught: ${String((e as Error)?.stack ?? e).slice(0, 2000)}`);
  if (/setTypeOfService/.test(String((e as Error)?.message ?? ''))) return;
  try { dialog.showErrorBox('앱 오류', String((e as Error)?.stack ?? e).slice(0, 2000)); } catch { /* 창을 띄울 수 없음 */ }
});
let win: BrowserWindow | null = null;
let tg: TelegramBridge | null = null;
// 같은 앱을 두 번 띄우면 같은 봇을 두 곳에서 받게 되므로(충돌) 하나만 실행한다
if (!app.requestSingleInstanceLock()) app.quit();
else app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); } });
const emit = (e: LiveEvent) => { tg?.onLive(e); if (win && !win.isDestroyed()) win.webContents.send('ws:live', e); if (e.type === 'mission' || e.type === 'run' || e.type === 'learning') scheduleBadge(); };
// 확인이 필요한 항목 수를 Dock 아이콘에 표시한다(macOS. 다른 운영체제에서는 무시됨)
let badgeTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleBadge() {
  if (badgeTimer) return;
  badgeTimer = setTimeout(() => {
    badgeTimer = null;
    try { const a = svc?.attention(); if (a) app.setBadgeCount(a.items.length); } catch { /* 표시 실패는 무시 */ }
  }, 500);
}

const secretFile = join(dataDir, 'langsmith.key.enc');
const secretStore = {
  get(): string | null {
    try { if (!existsSync(secretFile) || !safeStorage.isEncryptionAvailable()) return null; return safeStorage.decryptString(readFileSync(secretFile)); } catch { return null; }
  },
  set(v: string | null) {
    if (!v) { try { writeFileSync(secretFile, ''); } catch { /* 무시 */ } return; }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 데이터 보호(DPAPI) 암호화를 사용할 수 없어 키를 저장하지 않았습니다.');
    writeFileSync(secretFile, safeStorage.encryptString(v), { mode: 0o600 });
  },
};

// 텔레그램 봇 토큰: 운영체제 보안 저장소(Windows DPAPI)로 암호화한 파일에만 둔다. 암호화를 쓸 수 없으면 저장하지 않는다(평문으로 바꾸지 않음).
const tgTokenFile = join(dataDir, 'telegram.token.enc');
const tgToken = {
  get(): string | null { try { if (!existsSync(tgTokenFile) || !safeStorage.isEncryptionAvailable()) return null; const b = readFileSync(tgTokenFile); return b.length ? safeStorage.decryptString(b) : null; } catch { return null; } },
  set(v: string | null) {
    if (!v) { try { writeFileSync(tgTokenFile, ''); } catch { /* 무시 */ } return; }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('운영체제 보안 저장소(Windows DPAPI)를 쓸 수 없어 토큰을 저장하지 않았습니다.');
    writeFileSync(tgTokenFile, safeStorage.encryptString(v), { mode: 0o600 });
  },
  available: () => safeStorage.isEncryptionAvailable(),
};
/** 시연 화면 미리보기: 창을 띄우지 않고 이 컴퓨터 안의 시연 주소만 찍는다(별도 세션, 앱 코드 접근 없음) */
async function captureLocal(url: string): Promise<Buffer> {
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) throw new Error('이 컴퓨터 안의 시연 주소만 찍습니다.');
  const local = (u: string) => /^(http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/|data:|blob:|about:blank)/.test(u);
  const ses = session.fromPartition('crewgenai-tg-preview');
  // 리디렉션·스크립트 이동·외부 자원 요청까지 이 컴퓨터 안의 주소로만(밖으로 나가는 요청은 막음)
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !local(d.url) }));
  const w = new BrowserWindow({ show: false, width: 1280, height: 860, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, session: ses } });
  w.webContents.on('will-navigate', (e, u) => { if (!local(u)) e.preventDefault(); });
  w.webContents.on('will-redirect', (e, u) => { if (!local(u)) e.preventDefault(); });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try { await w.loadURL(url); await new Promise((r) => setTimeout(r, 2500)); return (await w.webContents.capturePage()).toPNG(); }
  finally { w.destroy(); }
}

/**
 * 참고 사이트 스냅샷: 공개 페이지를 새 빈 세션(로그인·쿠키 없음)으로 열어 전체 화면 사진과 본문·링크를 저장한다.
 * 이 컴퓨터·사설망 주소 요청, 내려받기, 새 창, 권한 요청은 막는다. 직원은 저장된 파일만 읽는다(직원 실행은 계속 네트워크 없음).
 */
async function captureReference(url: string, dir: string): Promise<{ title: string; finalUrl: string }> {
  if (!publicWebUrl(url)) throw new Error('공개 웹 주소(http·https)만 참고할 수 있습니다.');
  const ses = session.fromPartition(`crewgenai-ref-${Date.now()}-${Math.random().toString(16).slice(2)}`); // 저장되지 않는 새 세션
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !(publicWebUrl(d.url) || /^(data:|blob:|about:blank)/.test(d.url)) }));
  ses.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  ses.on('will-download', (e) => e.preventDefault());
  const w = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, session: ses, offscreen: false } });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e, u) => { if (!publicWebUrl(u)) e.preventDefault(); });
  try {
    await Promise.race([w.loadURL(url), new Promise((_, rej) => setTimeout(() => rej(new Error('30초 안에 열리지 않았습니다.')), 30000))]);
    await new Promise((r) => setTimeout(r, 3000)); // 스크립트로 그려지는 화면을 기다린다
    const info = await w.webContents.executeJavaScript(`(() => ({ title: document.title, h: Math.min(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0), 8000),
      text: (document.body ? document.body.innerText : '').slice(0, 40000),
      links: [...document.querySelectorAll('a[href]')].slice(0, 300).map((a) => [(a.innerText || a.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 60), a.href]).filter((x) => x[0]).slice(0, 150) }))()`, true) as { title: string; h: number; text: string; links: [string, string][] };
    w.setContentSize(1440, Math.max(900, info.h)); await new Promise((r) => setTimeout(r, 800));
    const png = (await w.webContents.capturePage()).toPNG();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'page.png'), png);
    const finalUrl = w.webContents.getURL();
    writeFileSync(join(dir, 'page.md'), [`# ${info.title || finalUrl}`, '', `- 주소: ${finalUrl}`, `- 저장: ${new Date().toLocaleString('ko-KR')} (로그인 없이 본 공개 화면)`, '- 화면 사진: page.png (가로 1440, 세로 최대 8000px)', '', '## 본문', '', info.text, '', '## 링크(최대 150개)', '', ...info.links.map(([t, h]) => `- ${t} — ${h}`)].join('\n'));
    return { title: (info.title || '').slice(0, 200), finalUrl };
  } finally { w.destroy(); }
}

let svc: Service;

function createWindow() {
  // 화면 시험용: CREWGENAI_WINDOW_SIZE=가로x세로(내용 영역 크기)로 창 크기를 정한다(예: 13인치 MacBook Air 최대화 1470x895)
  const size = /^(\d{3,4})x(\d{3,4})$/.exec(process.env.CREWGENAI_WINDOW_SIZE ?? '');
  win = new BrowserWindow({
    width: size ? Number(size[1]) : 1440, height: size ? Number(size[2]) : 900, useContentSize: !!size, minWidth: 1000, minHeight: 640, title: 'CREWGENAI 개발팀 관리', backgroundColor: '#f6f7f9',
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  void win.loadFile(join(__dirname, '../renderer/index.html'));
  win.on('closed', () => { win = null; });
  win.webContents.on('console-message', (ev) => { const e = ev as unknown as { level?: string; message?: string }; if (e.level === 'error' || e.level === 'warning') log(`renderer: ${e.message}`); });
  // 검증용 스모크 모드: 환경 변수와 실행 인자를 모두 지정한 경우에만 동작한다.
  const smoke = process.env.CREWGENAI_SMOKE_SCRIPT;
  if (smoke && process.argv.includes('--crewgenai-smoke')) win.webContents.once('did-finish-load', () => void runSmoke(smoke));
}

function buildMenu() {
  const t: MenuItemConstructorOptions[] = [
    { label: app.name, submenu: [{ role: 'about', label: `${app.name} 정보` }, { type: 'separator' }, { role: 'hide', label: '숨기기' }, { role: 'hideOthers', label: '다른 앱 숨기기' }, { type: 'separator' }, { role: 'quit', label: '종료' }] },
    { label: '파일', submenu: [
      { label: '데이터 폴더 탐색기에서 보기', click: () => void shell.openPath(dataDir) },
      { label: '앱 로그 보기', click: () => void shell.openPath(logFile) },
      { type: 'separator' }, { role: 'close', label: '창 닫기' }] },
    { label: '편집', submenu: [{ role: 'undo', label: '실행 취소' }, { role: 'redo', label: '다시 실행' }, { type: 'separator' }, { role: 'cut', label: '잘라내기' }, { role: 'copy', label: '복사' }, { role: 'paste', label: '붙여넣기' }, { role: 'selectAll', label: '모두 선택' }] },
    { label: '보기', submenu: [{ role: 'reload', label: '새로 고침' }, { role: 'resetZoom', label: '실제 크기' }, { role: 'zoomIn', label: '확대' }, { role: 'zoomOut', label: '축소' }, { type: 'separator' }, { role: 'togglefullscreen', label: '전체 화면' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const, label: '개발자 도구' }])] },
    { role: 'windowMenu', label: '윈도우' },
    { role: 'help', label: '도움말', submenu: [{ label: '사용법·검증 결과 문서 폴더 열기', click: () => void shell.openPath(join(resDir, 'docs')) }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(t));
}

function guard(p: string) { if (!svc.allowedPath(p, [join(resDir, 'docs')])) throw new Error('프로젝트·참고 자료 밖의 경로는 열 수 없습니다.'); }

function previewWindow(p: string) {
  guard(p);
  const ses = session.fromPartition('crewgenai-preview'); // 앱과 분리된 세션, 영속 저장 없음
  const allowed = pathToFileURL(p).href;
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !(d.url === allowed || d.url.startsWith('data:')) })); // 외부·다른 파일 요청 차단
  ses.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  const w = new BrowserWindow({ width: 1000, height: 760, title: `미리보기(격리) — ${p.split(sep).pop()}`, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, session: ses, webSecurity: true } });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  void w.loadURL(allowed);
}

function register() {
  const h = (name: string, fn: (...a: never[]) => unknown) => ipcMain.handle(`ws:${name}`, async (_e, ...args) => {
    try { return await (fn as (...x: unknown[]) => unknown)(...args); } catch (err) { log(`${name}: ${(err as Error).message}`); throw err; }
  });
  const s = () => svc;
  h('listProjects', () => s().store.listProjects());
  h('createProject', (p) => s().createProject(p));
  h('updatePlan', (id, p) => s().updatePlan(id, p));
  h('planHistory', (id) => s().store.planHistory(id));
  h('pickFolder', async () => { const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], title: '연결할 프로젝트 폴더 선택' }); return r.canceled ? null : r.filePaths[0]; });
  h('pickFiles', async () => { const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'openDirectory', 'multiSelections'], title: '참고 자료·기존 산출물 선택' }); return r.canceled ? [] : r.filePaths; });
  h('pickSubfolder', async (base: string) => {
    const r = await dialog.showOpenDialog(win!, { defaultPath: base, properties: ['openDirectory', 'createDirectory'], title: '프로젝트 안의 폴더 선택' });
    if (r.canceled) return null;
    const rel = relative(base, r.filePaths[0]);
    if (rel.startsWith('..')) throw new Error('프로젝트 폴더 안의 폴더만 선택할 수 있습니다.');
    return rel.split(sep).join('/') || '.';
  });
  h('revealInFinder', (p: string) => { guard(p); shell.showItemInFolder(p); });
  h('openPath', (p: string) => { guard(p); return shell.openPath(p); });
  h('openLocalUrl', (u: string) => { if (typeof u !== 'string' || !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?(\/[^\s]*)?$/i.test(u)) throw new Error('이 컴퓨터(localhost)의 화면 주소만 열 수 있습니다.'); return shell.openExternal(u); });
  h('demoInfo', (id: string) => s().demoInfo(id));
  h('demoApprove', (id: string, sid: string, hash: string) => s().demoApprove(id, sid, hash));
  h('demoStart', (id: string, sid: string) => s().demoStart(id, sid));
  h('demoStop', (id: string, sid: string) => s().demoStop(id, sid));
  h('demoLog', (id: string, sid: string) => s().demoLog(id, sid));
  h('demoRequest', (id: string, sid: string, req: { method: string; path: string; headers: Record<string, string>; body: string; capture?: Record<string, string> }) => s().demoRequest(id, sid, req));
  h('demoReset', (id: string, sid: string) => s().demoReset(id, sid));
  h('previewFile', (p: string) => previewWindow(p));
  h('readTextFile', (p: string) => { guard(p); if (statSync(p).size > 2_000_000) throw new Error('파일이 너무 커서 미리 볼 수 없습니다.'); return readFileSync(p, 'utf8'); });
  h('listAgents', (id, includeFired) => s().store.listAgents(id, !!includeFired));
  h('fireAgent', (id) => s().fireAgent(id));
  h('saveAgent', (pid, aid, f) => s().saveAgent(pid, aid, f));
  h('duplicateAgent', (id) => s().duplicateAgent(id));
  h('setAgentActive', (id, a) => s().setAgentActive(id, a));
  h('loadAgentTemplates', (id, setId) => s().loadAgentTemplates(id, setId));
  h('agentTemplateSets', () => s().agentTemplateSets());
  h('latestGraph', (id) => s().store.latestGraph(id));
  h('listGraphVersions', (id) => s().store.listGraphVersions(id));
  h('validateGraph', (id, g) => s().validate(id, g));
  h('saveGraph', (id, g, note) => s().saveGraph(id, g, note));
  h('defaultGraph', (id) => s().defaultGraph(id));
  h('startRun', (pid, gid) => s().startRun(pid, gid));
  h('rerunFrom', (rid, nid) => s().engine.rerunFrom(rid, nid));
  h('pauseRun', (rid) => s().engine.pause(rid));
  h('resumeRun', (rid) => s().engine.resume(rid));
  h('cancelRun', (rid) => s().engine.cancel(rid));
  h('resolveInterrupted', (rid, nid, a) => s().engine.resolveInterrupted(rid, nid, a));
  h('listRuns', (pid) => s().store.listRuns(pid));
  h('runDetail', (rid) => s().engine.detail(rid));
  h('attemptEvents', (aid) => s().store.events(aid));
  h('submitReview', (rid, nid, v, c, t, sh) => s().submitReview(rid, nid, v, c, t, sh));
  h('cliStatus', (refresh) => s().cliStatus(!!refresh));
  h('pickCliPath', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'treatPackageAsDirectory'], title: 'Claude CLI 실행 파일 선택' });
    if (!r.canceled) s().saveSettings({ cliPath: r.filePaths[0] });
    return s().cliStatus(true);
  });
  h('openLoginTerminal', async () => {
    const st = await s().cliStatus(false);
    if (!st.path) throw new Error('먼저 Claude CLI를 설치하거나 선택하세요.');
    // Windows: 명령 프롬프트 창에서 claude auth login을 실행하는 .cmd 파일을 만들어 연다(경로의 특수 문자는 그대로 따옴표로 감싼다)
    if (/["%^&|<>]/.test(st.path)) throw new Error('CLI 경로에 특수 문자가 있어 로그인 창을 열 수 없습니다. 명령 프롬프트에서 직접 claude auth login을 실행하세요.');
    const f = join(tmpdir(), `crewgenai-claude-login-${Date.now()}.cmd`);
    writeFileSync(f, `@echo off\r\nchcp 65001 >nul\r\ncall "${st.path}" auth login\r\necho.\r\necho 로그인이 끝나면 이 창을 닫고 앱에서 '다시 확인'을 누르세요.\r\npause\r\n`, 'utf8');
    await shell.openPath(f);
  });
  h('getSettings', () => s().settings());
  // 지시 첨부 파일: 고른 파일을 앱 데이터 폴더로 복사한다(저장소에 들어가지 않음). 비밀값 파일·큰 파일은 받지 않는다
  h('pickAttachments', async (projectId: string) => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'], title: '지시에 첨부할 파일 선택(최대 10개, 파일마다 20MB까지)' });
    if (r.canceled) return [];
    const dir = join(dataDir, 'references', 'attachments', String(projectId).replace(/[^\w-]/g, '').slice(0, 8) || 'project', `${Date.now()}`);
    const out: { name: string; path: string; size: number; skipped?: string }[] = [];
    for (const f of r.filePaths.slice(0, 10)) {
      const name = basename(f).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'file';
      let size = 0; try { const st = statSync(f); if (!st.isFile()) { out.push({ name, path: '', size: 0, skipped: '파일이 아님' }); continue; } size = st.size; } catch { out.push({ name, path: '', size: 0, skipped: '읽을 수 없음' }); continue; }
      if (looksSecretName(name)) { out.push({ name, path: '', size, skipped: '비밀값 파일로 보여 첨부하지 않음' }); continue; }
      if (size > 20 * 1024 * 1024) { out.push({ name, path: '', size, skipped: '20MB를 넘음' }); continue; }
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const dst = join(dir, name); copyFileSync(f, dst); out.push({ name, path: dst, size });
    }
    return out;
  });
  // 붙여 넣은 클립보드 파일·이미지: 내용을 받아 같은 첨부 폴더에 저장한다
  h('saveAttachmentData', async (projectId: string, rawName: string, data: Uint8Array) => {
    const name = String(rawName || 'clipboard').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'clipboard';
    const size = data?.byteLength ?? 0;
    if (!size) return { name, path: '', size: 0, skipped: '빈 내용' };
    if (looksSecretName(name)) return { name, path: '', size, skipped: '비밀값 파일로 보여 첨부하지 않음' };
    if (size > 20 * 1024 * 1024) return { name, path: '', size, skipped: '20MB를 넘음' };
    const dir = join(dataDir, 'references', 'attachments', String(projectId).replace(/[^\w-]/g, '').slice(0, 8) || 'project', `${Date.now()}-${Math.random().toString(16).slice(2, 6)}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dst = join(dir, name); writeFileSync(dst, Buffer.from(data)); return { name, path: dst, size };
  });
  h('pickSkillFolder', async () => { const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'showHiddenFiles'], title: '스킬 폴더 선택(SKILL.md가 있는 폴더 또는 그 상위 폴더)' }); return r.canceled ? null : r.filePaths[0]; });
  h('skillSources', (dirs) => s().skillSources(Array.isArray(dirs) ? (dirs as unknown[]).filter((x): x is string => typeof x === 'string') : null));
  h('saveSettings', (p, key) => s().saveSettings(p, key));
  h('codexStatus', (refresh) => s().codexStatus(!!refresh));
  h('listMissions', (pid) => s().missions.list(pid));
  h('projectProgress', (pid) => s().missions.progress(pid));
  h('reviewProjectProgress', (pid) => s().missions.reviewProgress(pid));
  h('cancelDirective', (id, seq) => s().missions.cancelDirective(id, Number(seq)));
  h('qaList', (pid) => s().missions.qaList(pid));
  h('qaAsk', (pid, text) => s().missions.qaAsk(pid, String(text ?? '')));
  h('qaClear', (pid) => s().missions.qaClear(pid));
  h('qaSendDirective', (pid, seq) => s().missions.qaSendDirective(pid, Number(seq)));
  h('attention', () => s().attention());
  h('pendingDecisions', (all) => s().pendingDecisions(all === true));
  h('commitPreview', (id: string, rid: string) => s().commitPreview(id, rid));
  h('commitApprove', (id: string, rid: string, hash: string) => s().commitApprove(id, rid, hash));
  h('commitDecline', (id: string, rid: string) => s().commitDecline(id, rid));
  h('listLearnings', () => s().learnings.list());
  h('saveLearning', (id, f) => { const r = s().saveLearning(id, f); emit({ type: 'learning' }); return r; });
  h('deleteLearning', (id) => { s().learnings.remove(id); emit({ type: 'learning' }); });
  h('markLearningsReviewed', (ids) => { s().learnings.markReviewed(ids); emit({ type: 'learning' }); });
  h('workingNow', (pid) => s().missions.working(pid));
  h('missionReadiness', (pid, refresh) => s().missionReadiness(pid, !!refresh));
  h('suggestNextMission', (pid) => s().missions.suggestNext(pid));
  h('startMission', (pid, prompt, limits) => s().startMission(pid, prompt, limits && typeof limits === 'object' ? limits as never : null));
  h('missionDetail', (id, n) => s().missions.detail(id, typeof n === 'number' && n >= 0 ? Math.floor(n) : 150));
  h('reviewMission', (id, picks, feedback, action) => s().missions.review(id, Array.isArray(picks) ? picks : [], String(feedback ?? ''), action === 'stop' ? 'stop' : 'continue'));
  h('answerMission', (id, text, action, keepPending) => s().missions.answer(id, text, action, keepPending === true ? 'pending' : undefined));
  h('stopMission', (id) => s().missions.stop(id));
  h('retryParked', (id, sigs) => s().missions.retryParked(id, Array.isArray(sigs) ? (sigs as unknown[]).map(String) : undefined));
  h('resolveStaffProposal', (id, pid, action, edit) => s().resolveStaffProposal(String(id), String(pid), action === 'apply' ? 'apply' : 'dismiss', (() => { const e = edit as unknown as Record<string, unknown> | null; return e && typeof e === 'object' ? { name: String(e.name ?? ''), role: String(e.role ?? ''), instructions: String(e.instructions ?? '') } : null; })()));
  h('refSnippet', (id, p, line) => s().refSnippet(String(id), String(p ?? ''), typeof line === 'number' ? line : null));
  h('decideMission', (id, picks, resume) => s().missions.decide(id, picks, resume));
  // 텔레그램(토큰은 화면으로 돌려주지 않는다)
  const T = () => { if (!tg) throw new Error('텔레그램 연동이 아직 준비되지 않았습니다.'); return tg; };
  h('telegramStatus', () => T().status());
  h('telegramSetToken', (t) => T().setToken(t === null ? null : String(t ?? '')));
  h('telegramTest', () => T().test());
  h('telegramSetOptions', (o) => T().setOptions(o && typeof o === 'object' ? o as never : {}));
  h('telegramLinkCode', () => T().newLinkCode());
  h('telegramLinkConfirm', (ok, uid) => T().confirmLink(ok === true, typeof uid === 'number' ? uid : undefined));
  h('telegramUnlink', () => T().unlink());
  h('telegramSendTest', () => T().sendTest());
  h('saveSecret', (inp) => { const o = (inp ?? {}) as Record<string, unknown>; return s().saveSecret({ key: String(o.key ?? ''), file: String(o.file ?? ''), name: String(o.name ?? ''), value: typeof o.value === 'string' ? o.value : '' }); });
  h('applyDecisions', (picks) => s().applyDecisions(Array.isArray(picks) ? (picks as { key: string; choice: string; version?: string }[]) : [], '앱'));
  h('pauseMission', (id) => s().missions.pause(String(id)));
  h('resumeMission', (id) => s().missions.resume(String(id)));
  h('retryMissionLimit', (id) => s().missions.retryLimitNow(id));
  h('usagePace', () => s().usagePace());
  h('devSyncStatus', () => s().devSyncStatus());
  h('devSyncNow', () => s().devSyncNow());
  h('missionSnapshots', (id) => s().missions.snapshots(id));
  h('rollbackMission', (id, tag) => s().missions.rollback(id, tag));
  h('addDirective', (id, text, mode) => s().missions.addDirective(id, text, mode === 'now' ? 'now' : mode === 'priority' ? 'priority' : 'next'));
  // 권장 기획 문서 템플릿: resources/docs/prompts/*.md
  h('listPromptTemplates', () => loadTemplates(join(resDir, 'docs', 'prompts')));
  h('projectDocs', (pid) => s().projectDocs(pid));
  h('saveProjectDocs', (pid, items) => s().saveProjectDocs(pid, items));
  h('reviewProjectDoc', (pid, id, r) => s().reviewProjectDoc(pid, id, r));
  h('resetProjectDocs', (pid) => s().resetProjectDocs(pid));
  h('uploadProjectDoc', async (pid, id) => {
    const doc = s().projectDocs(pid).find((d) => d.id === id);
    if (!doc) throw new Error('문서를 찾을 수 없습니다.');
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], title: `'${doc.title}' 파일 올리기 — 프로젝트 폴더로 복사합니다`, filters: [{ name: '문서(Markdown·텍스트·PDF·CSV·JSON)', extensions: ['md', 'markdown', 'txt', 'pdf', 'csv', 'json'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    if (doc.exists) {
      const c = await dialog.showMessageBox(win!, { type: 'question', buttons: ['덮어쓰기', '취소'], defaultId: 1, cancelId: 1, message: `${doc.path} 파일이 이미 있습니다. 올린 파일로 바꿀까요?`, detail: '기존 내용은 git에 커밋돼 있지 않으면 되돌릴 수 없습니다.' });
      if (c.response !== 0) return null;
    }
    return s().uploadProjectDoc(pid, id, r.filePaths[0]);
  });
  h('helpDocs', () => {
    const rd = (n: string) => { try { return readFileSync(join(resDir, 'docs', n), 'utf8'); } catch { return `(${n} 없음)`; } };
    // 앱에 포함된 docs/images의 PNG만 data URL로 넘긴다(화면은 이 목록에 있는 이름만 표시, 외부 주소는 표시하지 않음)
    const images: Record<string, string> = {};
    try {
      for (const f of readdirSync(join(resDir, 'docs', 'images'))) if (/^[\w.-]+\.png$/.test(f)) images[`images/${f}`] = `data:image/png;base64,${readFileSync(join(resDir, 'docs', 'images', f)).toString('base64')}`;
    } catch { /* 이미지 없음 */ }
    return { guide: rd('GUIDE.md'), verification: rd('VERIFICATION.md'), changelog: rd('CHANGELOG.md'), images };
  });
}

async function runSmoke(script: string) {
  // 스크립트: [{ name, js, waitMs }] — 각 단계를 실제 창에서 실행하고 화면을 캡처한다.
  const outDir = process.env.CREWGENAI_SMOKE_OUT || join(dataDir, 'smoke');
  mkdirSync(outDir, { recursive: true });
  const results: { name: string; ok: boolean; value?: unknown; error?: string }[] = [];
  try {
    const steps = JSON.parse(readFileSync(script, 'utf8')) as { name: string; js: string; waitMs?: number }[];
    for (const st of steps) {
      try {
        const value = await win!.webContents.executeJavaScript(`(async () => { try { ${st.js} } catch (e) { return { __error: String((e && e.message) || e) }; } })()`, true);
        const err = value && typeof value === 'object' && '__error' in value ? String((value as { __error: unknown }).__error) : null;
        results.push(err ? { name: st.name, ok: false, error: err } : { name: st.name, ok: true, value });
      } catch (e) { results.push({ name: st.name, ok: false, error: String(e) }); }
      await new Promise((r) => setTimeout(r, st.waitMs ?? 600));
      const img = await win!.webContents.capturePage();
      writeFileSync(join(outDir, `${String(results.length).padStart(2, '0')}-${st.name}.png`), img.toPNG());
    }
  } catch (e) { results.push({ name: 'script', ok: false, error: String(e) }); }
  writeFileSync(join(outDir, 'result.json'), JSON.stringify(results, null, 2));
  quitting = true; svc.close(); app.exit(0);
}

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting || !svc) return;
  const active = svc.store.runsWithStatus(['running', 'paused']).filter((r) => svc.engine.isActive(r.id));
  if (active.length) {
    const c = dialog.showMessageBoxSync({ type: 'warning', buttons: ['종료', '취소'], defaultId: 1, cancelId: 1, message: `실행 중인 업무 ${active.length}개가 있습니다.`,
      detail: '종료하면 앱이 시작한 Claude 프로세스를 정리하고 실행을 "재개 확인 필요"로 저장합니다. 완료된 단계는 다시 실행하지 않습니다.' });
    if (c === 1) { e.preventDefault(); return; }
  }
  quitting = true;
  tg?.close(); // 앱을 완전히 종료하면 텔레그램 수신도 멈춘다
  e.preventDefault(); // 프로세스 종료를 기다린 뒤 DB를 닫고 다시 종료한다
  void svc.closeGracefully().finally(() => app.quit());
});

void app.whenReady().then(async () => {
  svc = new Service({
    dbFile: join(dataDir, 'workspace.db'), captureRef: captureReference, mockScript: join(resDir, 'mock-claude.cjs'), mockCodexScript: join(resDir, 'mock-codex.cjs'), emit, secretStore, promptsDir: join(resDir, 'docs', 'prompts'),
    tracer: (sv) => createTracer(() => { const st = sv.settings(); return { enabled: st.langsmithEnabled, apiKey: sv.langsmithKey(), endpoint: st.langsmithEndpoint, project: st.langsmithProject }; }, log),
  });
  // 멈춘 실행을 자동으로 이어 가기 전에 Claude CLI 위치를 먼저 찾는다(찾기 전에 이어 가면 'CLI 경로 없음'으로 실패)
  if (svc.settings().executor === 'claude') await svc.cliStatus(false).catch(() => null);
  // 검증 방식이 Codex 검증이면, 멈춘 실행을 이어 계획하기 전에 Codex 준비 상태도 먼저 확인한다(모르는 채로 준비된 것으로 보지 않는다)
  if (svc.settings().reviewMode === 'codex') await svc.codexStatus(false).catch(() => null);
  await svc.engine.recoverOnStartup();
  await svc.missions.recoverProcesses();
  svc.missions.recoverOnStartup();
  svc.startDevSyncTimer(); // 매일 dev 반영(정해진 시각, 꺼져 있었으면 켜진 뒤)
  await svc.recoverCommits().catch(() => null); // 커밋하던 중 꺼진 승인 요청을 실제 커밋 여부로 정리
  tg = new TelegramBridge({ svc, token: tgToken, capture: captureLocal, onStatus: () => { if (win && !win.isDestroyed()) win.webContents.send('ws:live', { type: 'telegram' }); } });
  tg.start();
  // 잠자기 해제·네트워크 복구 뒤 바로 다시 연결(놓친 예약을 몰아서 실행하지 않음)
  powerMonitor.on('resume', () => tg?.kick());
  register();
  buildMenu();
  createWindow();
  void svc.cliStatus(true).catch((e) => log(`cli check: ${(e as Error).message}`));
  void svc.codexStatus(true).catch((e) => log(`codex check: ${(e as Error).message}`));
  app.on('activate', () => { if (!win) createWindow(); });
});
app.on('window-all-closed', () => { app.quit(); });
