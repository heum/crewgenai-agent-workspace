// Electron 메인 프로세스 — 창·메뉴·IPC·파일 선택·Finder·격리 미리보기·종료 처리
import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, session, shell, type MenuItemConstructorOptions } from 'electron';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LiveEvent } from '../shared/types';
import { createTracer } from './langsmith';
import { Service } from './service';
import { loadTemplates } from './docset';

app.setName('CREWGENAI 개발팀 관리');
const dataDir = process.env.CREWGENAI_DATA_DIR || app.getPath('userData');
mkdirSync(dataDir, { recursive: true });
const resDir = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources');
const logFile = join(dataDir, 'app.log');
const log = (m: string) => { try { writeFileSync(logFile, `${new Date().toISOString()} ${m}\n`, { flag: 'a' }); } catch { /* 무시 */ } };

let win: BrowserWindow | null = null;
const emit = (e: LiveEvent) => { if (win && !win.isDestroyed()) win.webContents.send('ws:live', e); if (e.type === 'mission' || e.type === 'run' || e.type === 'learning') scheduleBadge(); };
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
    if (!safeStorage.isEncryptionAvailable()) throw new Error('macOS 키체인 암호화를 사용할 수 없어 키를 저장하지 않았습니다.');
    writeFileSync(secretFile, safeStorage.encryptString(v), { mode: 0o600 });
  },
};

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
      { label: '데이터 폴더 Finder에서 보기', click: () => void shell.openPath(dataDir) },
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
    const f = join(tmpdir(), `crewgenai-claude-login-${Date.now()}.command`);
    const q = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`;
    writeFileSync(f, `#!/bin/zsh\n${q(st.path)} auth login\necho\necho "로그인이 끝나면 이 창을 닫고 앱에서 '다시 확인'을 누르세요."\n`, { mode: 0o700 });
    chmodSync(f, 0o700);
    await shell.openPath(f);
  });
  h('getSettings', () => s().settings());
  h('saveSettings', (p, key) => s().saveSettings(p, key));
  h('codexStatus', (refresh) => s().codexStatus(!!refresh));
  h('listMissions', (pid) => s().missions.list(pid));
  h('attention', () => s().attention());
  h('listLearnings', () => s().learnings.list());
  h('saveLearning', (id, f) => { const r = s().saveLearning(id, f); emit({ type: 'learning' }); return r; });
  h('deleteLearning', (id) => { s().learnings.remove(id); emit({ type: 'learning' }); });
  h('markLearningsReviewed', (ids) => { s().learnings.markReviewed(ids); emit({ type: 'learning' }); });
  h('workingNow', (pid) => s().missions.working(pid));
  h('missionReadiness', (pid, refresh) => s().missionReadiness(pid, !!refresh));
  h('startMission', (pid, prompt) => s().startMission(pid, prompt));
  h('missionDetail', (id) => s().missions.detail(id));
  h('answerMission', (id, text, action) => s().missions.answer(id, text, action));
  h('stopMission', (id) => s().missions.stop(id));
  h('retryMissionLimit', (id) => s().missions.retryLimitNow(id));
  h('missionSnapshots', (id) => s().missions.snapshots(id));
  h('rollbackMission', (id, tag) => s().missions.rollback(id, tag));
  h('addDirective', (id, text, mode) => s().missions.addDirective(id, text, mode === 'now' ? 'now' : 'next'));
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
    return { guide: rd('GUIDE.md'), verification: rd('VERIFICATION.md'), images };
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
  e.preventDefault(); // 프로세스 종료를 기다린 뒤 DB를 닫고 다시 종료한다
  void svc.closeGracefully().finally(() => app.quit());
});

void app.whenReady().then(async () => {
  svc = new Service({
    dbFile: join(dataDir, 'workspace.db'), mockScript: join(resDir, 'mock-claude.cjs'), mockCodexScript: join(resDir, 'mock-codex.cjs'), emit, secretStore, promptsDir: join(resDir, 'docs', 'prompts'),
    tracer: (sv) => createTracer(() => { const st = sv.settings(); return { enabled: st.langsmithEnabled, apiKey: sv.langsmithKey(), endpoint: st.langsmithEndpoint, project: st.langsmithProject }; }, log),
  });
  await svc.engine.recoverOnStartup();
  await svc.missions.recoverProcesses();
  svc.missions.recoverOnStartup();
  register();
  buildMenu();
  createWindow();
  void svc.cliStatus(true).catch((e) => log(`cli check: ${(e as Error).message}`));
  void svc.codexStatus(true).catch((e) => log(`codex check: ${(e as Error).message}`));
  app.on('activate', () => { if (!win) createWindow(); });
});
app.on('window-all-closed', () => { app.quit(); });
