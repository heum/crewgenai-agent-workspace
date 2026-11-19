// 텔레그램 연동: 앱이 이 컴퓨터에서 Telegram Bot API에 롱 폴링으로 연결한다(별도 서버·공개 포트·터널 없음).
// 앱 화면과 같은 처리 로직·같은 상태를 쓴다: 확인함(pendingDecisions·applyDecisions), 커밋 승인(commitPreview·commitApprove),
// 추가 지시(addDirective), 미션 제어(pause·resume·stop), 결과물(mission.results·시연 목록). 별도 승인 목록·미션 상태를 만들지 않는다.
// 등록한 내 계정(사용자 ID + 1:1 대화방 ID)만 조회·조작할 수 있다. 버튼을 누를 때도 같은 확인을 하고, 연결을 해제하면 이전 버튼은 쓸 수 없다.
// 토큰은 운영체제 보안 저장소에만 두고, 화면·로그·오류·설정 파일에 남기지 않는다. 상태 조회는 저장된 앱 상태만 읽는다(Claude를 부르지 않음).
import { randomBytes } from 'node:crypto';
import type { Mission, MissionEvent, PendingDecision, LiveEvent, MissionCommitRequest, CommitPreview, Project } from '../shared/types';
import { RESULT_STATUS_LABEL } from '../shared/types';
import { decisionVersion } from '../shared/decisions';
import { redact } from './cli/claudeCli';
import { safeFetch } from './http';
import type { Service } from './service';

// ───── 설정·상태 ─────
export interface TgKinds { review: boolean; results: boolean; commits: boolean; failures: boolean; limit: boolean; cycle: boolean }
export interface TgSettings {
  enabled: boolean;
  bot: { id: number; username: string; name: string } | null;
  link: { userId: number; chatId: number; name: string; at: string } | null; // 등록한 내 계정(1:1 대화)
  epoch: number; // 연결·해제할 때마다 바뀜: 이전 버튼을 무효로
  linkCode: { code: string; expires: number } | null; // 앱에서 만든 일회용 연결 코드
  candidate: { userId: number; chatId: number; name: string; at: string } | null; // 연결 코드로 들어온 계정(앱에서 확인해야 등록)
  projects: string[] | null; // 알림 받을 프로젝트(null=전체)
  missions: string[] | null; // 알림 받을 미션(null=전체)
  kinds: TgKinds;
  batchMinutes: number; // 0=바로, 그 밖에는 이 간격으로 묶어서(검토·커밋 승인은 늘 바로)
  sourceDetail: Record<string, boolean>; // 프로젝트별: 커밋 '변경 상세'에 코드 차이까지 보낼지
  preview: Record<string, string[]>; // 프로젝트별: 화면 미리보기를 보내도 되는 시연 서비스
  target: { projectId: string; missionId: string } | null; // 지금 조작 대상
}
export const DEFAULT_TG: TgSettings = {
  enabled: false, bot: null, link: null, epoch: 1, linkCode: null, candidate: null, projects: null, missions: null,
  kinds: { review: true, results: true, commits: true, failures: true, limit: true, cycle: false }, batchMinutes: 0, sourceDetail: {}, preview: {}, target: null,
};
export type TgState = 'off' | 'no-token' | 'connecting' | 'connected' | 'error' | 'conflict' | 'unavailable';
export interface TgStatus {
  state: TgState; reason: string | null; lastOkAt: string | null; tokenSet: boolean; tokenHint: string | null; secureStore: boolean;
  settings: Omit<TgSettings, 'linkCode'> & { linkCode: { code: string; link: string | null; expires: number } | null };
  pendingOut: number; lastDenied: string | null;
}
export interface TokenStore { get(): string | null; set(v: string | null): void; available(): boolean }
export interface TgDeps {
  svc: Service;
  token: TokenStore;
  fetchImpl?: typeof fetch;
  capture?: (url: string) => Promise<Buffer>; // 화면 미리보기(앱 창 없이 시연 화면을 찍음)
  now?: () => number;
  onStatus?: () => void; // 상태가 바뀌면 화면에 알림
  pollTimeoutSec?: number;
}

class TgError extends Error { constructor(public code: number, desc: string, public retryAfter?: number) { super(desc); this.name = 'TgError'; } }
type Btn = { text: string; cb: object } | { text: string; url: string };
type Out = { text: string; rows?: Btn[][]; kind?: string; ref?: object; replyTo?: number; forceReply?: boolean };
const STALE_SEC = 10 * 60; // 이보다 오래된 상태 변경 명령은 실행하지 않고 다시 확인(앱이 꺼져 있던 동안 쌓인 명령)
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstLine = (s: string) => s.replace(/\*\*/g, '').split('\n').map((l) => l.replace(/^#+\s*/, '').replace(/^한\s*줄\s*요약\s*[:：]\s*/, '').trim()).find(Boolean) ?? '';
const hhmm = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const STATUS_KO: Record<string, string> = { planning: '계획 중', running: '실행 중', evaluating: '판단 중', waiting_user: '결정 대기', done: '완료 보고', stopped: '중지됨', failed: '실패' };

export class TelegramBridge {
  private s(): TgSettings { return { ...DEFAULT_TG, ...this.d.svc.store.getSetting<Partial<TgSettings>>('telegram', {}) }; }
  private save(p: Partial<TgSettings>) { this.d.svc.store.setSetting('telegram', { ...this.s(), ...p }); this.d.onStatus?.(); }
  private state: TgState = 'off'; private reason: string | null = null; private lastOkAt: string | null = null; private lastDenied: string | null = null;
  private running = false; private gen = 0; private abort: AbortController | null = null; private closed = false; private syncTimer: ReturnType<typeof setInterval> | null = null;
  private now() { return this.d.now ? this.d.now() : Date.now(); }
  private backlog = false; // 지금 처리하는 업데이트가 오래 끊겼던 동안 쌓인 것인가

  constructor(private d: TgDeps) {
    d.svc.store.db.exec(`CREATE TABLE IF NOT EXISTS tg_kv (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS tg_updates (update_id INTEGER PRIMARY KEY, at INTEGER);
      CREATE TABLE IF NOT EXISTS tg_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, dkey TEXT UNIQUE, payload TEXT, due INTEGER, created INTEGER, sent INTEGER);
      CREATE TABLE IF NOT EXISTS tg_cb (token TEXT PRIMARY KEY, payload TEXT, epoch INTEGER, created INTEGER, used INTEGER);
      CREATE TABLE IF NOT EXISTS tg_msg (message_id INTEGER PRIMARY KEY, kind TEXT, ref TEXT, created INTEGER, done INTEGER);
      CREATE TABLE IF NOT EXISTS tg_draft (item TEXT PRIMARY KEY, choice TEXT, version TEXT, kind TEXT);
      CREATE TABLE IF NOT EXISTS tg_watch (mission_id TEXT, seq INTEGER, mode TEXT, text TEXT, PRIMARY KEY(mission_id, seq));`);
  }
  private db() { return this.d.svc.store.db; }
  private kv(k: string): string | null { const r = this.db().prepare('SELECT value FROM tg_kv WHERE key=?').get(k) as { value: string } | undefined; return r?.value ?? null; }
  private setKv(k: string, v: string) { this.db().prepare('INSERT OR REPLACE INTO tg_kv VALUES(?,?)').run(k, v); }

  // ───── 토큰(보안 저장소에만) ─────
  /** 토큰이 들어간 문자열을 가린다(오류·기록에 토큰이 남지 않게) */
  private hide(s: string): string { const t = this.d.token.get(); let o = String(s ?? ''); if (t) o = o.split(t).join('***'); return redact(o.replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, 'bot***')); }
  async setToken(token: string | null): Promise<TgStatus> {
    if (token === null || !token.trim()) { this.stop(); this.d.token.set(null); this.save({ bot: null, enabled: false }); this.state = 'no-token'; return this.status(); }
    const t = token.trim();
    if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(t)) throw new Error('봇 토큰 형식이 아닙니다. BotFather가 준 "숫자:영문" 형태의 토큰 전체를 넣어 주세요.');
    if (!this.d.token.available()) throw new Error('운영체제 보안 저장소(Windows DPAPI)를 쓸 수 없어 토큰을 저장하지 않았습니다. 평문으로는 저장하지 않습니다.');
    const me = await this.rawCall<{ id: number; username: string; first_name: string; is_bot: boolean }>(t, 'getMe', {}).catch((e: Error) => { throw new Error(`토큰 확인 실패: ${this.hideWith(e.message, t)}`); });
    if (!me.is_bot) throw new Error('봇 토큰이 아닙니다.');
    const prev = this.d.token.get();
    this.d.token.set(t);
    // 다른 봇으로 바꾸면 이전 봇의 계정 연결·버튼은 무효
    const changed = !!prev && prev !== t;
    this.save({ bot: { id: me.id, username: me.username, name: me.first_name }, ...(changed ? { link: null, candidate: null, epoch: this.s().epoch + 1 } : {}) });
    if (changed) this.setKv('offset', '0');
    this.restart();
    return this.status();
  }
  private hideWith(s: string, t: string) { return redact(String(s ?? '').split(t).join('***')); }
  async test(): Promise<{ ok: boolean; bot: string | null; detail: string }> {
    const t = this.d.token.get(); if (!t) return { ok: false, bot: null, detail: '토큰이 없습니다.' };
    try { const me = await this.rawCall<{ username: string; first_name: string }>(t, 'getMe', {}); return { ok: true, bot: `@${me.username}`, detail: `${me.first_name} (@${me.username}) 연결 확인` }; }
    catch (e) { return { ok: false, bot: null, detail: this.hide((e as Error).message) }; }
  }
  status(): TgStatus {
    const s = this.s(); const t = this.d.token.get();
    const code = s.linkCode && s.linkCode.expires > this.now() ? { code: s.linkCode.code, expires: s.linkCode.expires, link: s.bot ? `https://t.me/${s.bot.username}?start=${s.linkCode.code}` : null } : null;
    const pendingOut = (this.db().prepare('SELECT COUNT(*) n FROM tg_outbox WHERE sent IS NULL').get() as { n: number }).n;
    return { state: !t ? 'no-token' : !s.enabled ? 'off' : this.state, reason: this.reason, lastOkAt: this.lastOkAt, tokenSet: !!t, tokenHint: t ? `봇 ID ${t.split(':')[0]} · 토큰 ••••••••(가림)` : null, secureStore: this.d.token.available(), settings: { ...s, linkCode: code }, pendingOut, lastDenied: this.lastDenied };
  }
  setOptions(p: Partial<Pick<TgSettings, 'enabled' | 'projects' | 'missions' | 'kinds' | 'batchMinutes' | 'sourceDetail' | 'preview'>>): TgStatus {
    const cur = this.s();
    const next: Partial<TgSettings> = {};
    if (typeof p.enabled === 'boolean') next.enabled = p.enabled;
    if (p.projects !== undefined) next.projects = Array.isArray(p.projects) ? p.projects.map(String) : null;
    if (p.missions !== undefined) next.missions = Array.isArray(p.missions) ? p.missions.map(String) : null;
    if (p.kinds) next.kinds = { ...cur.kinds, ...Object.fromEntries(Object.entries(p.kinds).map(([k, v]) => [k, !!v])) } as TgKinds;
    if (p.batchMinutes !== undefined) next.batchMinutes = Math.min(240, Math.max(0, Math.floor(Number(p.batchMinutes) || 0)));
    if (p.sourceDetail) next.sourceDetail = Object.fromEntries(Object.entries(p.sourceDetail).map(([k, v]) => [k, !!v]));
    if (p.preview) next.preview = Object.fromEntries(Object.entries(p.preview).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : []]));
    this.save(next);
    if (next.enabled === true) this.restart(); else if (next.enabled === false) this.stop();
    return this.status();
  }

  // ───── 계정 연결(일회용 코드 → 앱에서 확인) ─────
  newLinkCode(): TgStatus {
    const code = randomBytes(6).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase();
    this.save({ linkCode: { code, expires: this.now() + 10 * 60_000 }, candidate: null });
    return this.status();
  }
  /** expectUserId: 화면에 보여 준 후보의 사용자 ID(그 사이 후보가 바뀌었으면 연결하지 않음) */
  async confirmLink(accept: boolean, expectUserId?: number): Promise<TgStatus> {
    const s = this.s(); const c = s.candidate;
    if (!c) throw new Error('확인할 연결 요청이 없습니다.');
    if (accept && expectUserId !== undefined && c.userId !== expectUserId) throw new Error('연결 요청이 바뀌었습니다. 화면을 새로 고친 뒤 다시 확인하세요.');
    if (!accept) { this.save({ candidate: null }); return this.status(); }
    this.save({ link: c, candidate: null, linkCode: null, epoch: s.epoch + 1 });
    this.db().exec('DELETE FROM tg_draft');
    await this.send({ text: `✅ 이 대화가 CREWGENAI 앱에 연결됐습니다.\n지금부터 이 계정(${esc(c.name)})만 조회·조작할 수 있습니다.\n\n/menu 로 메뉴를 열 수 있습니다.` }).catch(() => null);
    return this.status();
  }
  unlink(): TgStatus {
    const s = this.s();
    this.save({ link: null, candidate: null, linkCode: null, epoch: s.epoch + 1 }); // 이전 버튼은 모두 무효
    this.db().exec('DELETE FROM tg_draft; DELETE FROM tg_outbox WHERE sent IS NULL;');
    return this.status();
  }
  async sendTest(): Promise<string> {
    if (!this.s().link) throw new Error('먼저 내 텔레그램 계정을 연결하세요.');
    await this.send({ text: `🔔 CREWGENAI 테스트 메시지입니다(${new Date(this.now()).toLocaleString('ko-KR')}).` });
    return '테스트 메시지를 보냈습니다.';
  }

  // ───── 연결(롱 폴링) ─────
  start() { if (this.closed) return; if (!this.s().enabled || !this.d.token.get()) { this.state = this.d.token.get() ? 'off' : 'no-token'; return; } if (this.running) return; this.running = true; void this.loop(++this.gen); this.startSync(); }
  stop() { this.running = false; this.abort?.abort(); if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = null; } this.state = this.d.token.get() ? 'off' : 'no-token'; this.d.onStatus?.(); }
  restart() { this.stop(); this.start(); }
  /** 잠자기 해제·네트워크 복구: 기다리던 수신을 끊고 바로 다시 연결한다(놓친 예약을 몰아서 실행하지 않음) */
  kick() { if (this.running) this.abort?.abort(); else this.start(); }
  close() { this.closed = true; this.stop(); }

  private async loop(gen: number) {
    let backoff = 2000; let wasDown = true;
    const alive = () => this.running && !this.closed && gen === this.gen; // 다시 시작하면 이전 루프는 끝난다(같은 봇을 두 곳에서 받지 않게)
    while (alive()) {
      const t = this.d.token.get(); if (!t) { this.state = 'no-token'; break; }
      if (this.state !== 'connected') {
        this.state = 'connecting'; this.d.onStatus?.();
        // 첫 수신(최대 50초 대기)을 기다리지 않고, 짧은 확인으로 바로 '연결됨'을 표시한다
        try { await this.call('getMe', {}, 15); if (alive()) this.ok(); } catch { /* 아래 수신에서 다시 판단 */ }
      }
      if (!alive()) break; // 확인하는 사이 다시 시작·중지됐으면 이 루프는 끝낸다
      try {
        const offset = Number(this.kv('offset') ?? '0');
        const ups = await this.call<TgUpdate[]>('getUpdates', { offset, timeout: this.d.pollTimeoutSec ?? 50, allowed_updates: ['message', 'callback_query'] }, (this.d.pollTimeoutSec ?? 50) + 15);
        this.ok();
        if (wasDown) { wasDown = false; void this.resync(); }
        if (!alive()) break;
        // 앱이 꺼져 있거나 연결이 끊긴 동안(10분 넘게) 쌓인 업데이트인가: 그 사이 누른 버튼의 상태 변경은 실행하지 않고 다시 누르게 한다
        const lastOk = Number(this.kv('lastOk') ?? '0'); this.backlog = !lastOk || this.now() - lastOk > STALE_SEC * 1000; this.setKv('lastOk', String(this.now()));
        for (const u of ups) {
          if (!alive()) break;
          // 수신 기록: 이미 처리한 업데이트는 다시 처리하지 않는다(앱 재시작·통신 재시도)
          if (this.db().prepare('SELECT 1 FROM tg_updates WHERE update_id=?').get(u.update_id)) { this.setKv('offset', String(u.update_id + 1)); continue; }
          this.db().prepare('INSERT INTO tg_updates VALUES(?,?)').run(u.update_id, this.now());
          this.setKv('offset', String(u.update_id + 1));
          await this.handle(u).catch((e) => this.send({ text: `⚠️ 처리 중 오류: ${esc(this.hide((e as Error).message)).slice(0, 300)}` }).catch(() => null));
        }
        this.db().prepare('DELETE FROM tg_updates WHERE at < ?').run(this.now() - 3 * 86400_000);
        this.backlog = false;
        await this.flush();
        backoff = 2000;
      } catch (e) {
        if (!alive()) break;
        const err = e as TgError; wasDown = true;
        if (err.name === 'AbortError') continue; // 잠자기 해제 등으로 다시 연결
        if (err.code === 401 || err.code === 404) { this.fail('error', '봇 토큰이 맞지 않거나 폐기됐습니다. 설정에서 토큰을 다시 넣어 주세요.'); if (gen === this.gen) this.running = false; break; }
        if (err.code === 409) this.fail('conflict', /webhook/i.test(err.message) ? '이 봇에 웹훅이 설정돼 있어 앱이 메시지를 받을 수 없습니다(다른 서비스가 같은 봇을 쓰는 중일 수 있음). 같은 봇을 다른 곳에서 쓰지 않는지 확인하세요.' : '같은 봇 토큰으로 다른 곳(다른 컴퓨터·다른 앱 실행)에서 메시지를 받고 있습니다. 한 곳에서만 실행하세요.');
        else this.fail('error', `텔레그램 연결 실패: ${this.hide(err.message).slice(0, 200)} — 자동으로 다시 연결합니다.`);
        await this.sleep(err.retryAfter ? err.retryAfter * 1000 : err.code === 409 ? 60_000 : backoff);
        backoff = Math.min(60_000, backoff * 2);
      }
    }
  }
  private ok() { const was = this.state; this.state = 'connected'; this.reason = null; this.lastOkAt = new Date(this.now()).toISOString(); if (was !== 'connected') this.d.onStatus?.(); }
  private fail(st: TgState, why: string) { this.state = st; this.reason = why; this.d.onStatus?.(); }
  private sleep(ms: number) { return new Promise<void>((res) => { const ac = new AbortController(); this.abort = ac; const t = setTimeout(res, ms); ac.signal.addEventListener('abort', () => { clearTimeout(t); res(); }); }); }
  private startSync() { if (this.syncTimer) return; this.syncTimer = setInterval(() => { if (this.state === 'connected') void this.flush().then(() => this.retireButtons()).catch(() => null); }, 30_000); }

  // ───── Bot API ─────
  private async rawCall<T>(token: string, method: string, body: object, timeoutSec = 20, form?: FormData): Promise<T> {
    const f = this.d.fetchImpl ?? (safeFetch as unknown as typeof fetch);
    const ac = new AbortController(); this.abort = method === 'getUpdates' ? ac : this.abort;
    const timer = setTimeout(() => ac.abort(), timeoutSec * 1000);
    try {
      const r = await f(`https://api.telegram.org/bot${token}/${method}`, form ? { method: 'POST', body: form, signal: ac.signal } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
      const j = await r.json() as { ok: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
      if (!j.ok) throw new TgError(j.error_code ?? r.status, String(j.description ?? 'Bot API 오류'), j.parameters?.retry_after);
      return j.result as T;
    } catch (e) {
      if ((e as Error).name === 'AbortError') { const a = new Error('aborted'); a.name = 'AbortError'; throw a; }
      if (e instanceof TgError) throw e;
      throw new TgError(0, this.hideWith((e as Error).message, token));
    } finally { clearTimeout(timer); }
  }
  private call<T>(method: string, body: object, timeoutSec?: number, form?: FormData): Promise<T> {
    const t = this.d.token.get(); if (!t) return Promise.reject(new Error('토큰 없음'));
    return this.rawCall<T>(t, method, body, timeoutSec, form);
  }

  // ───── 보내기(콜백 토큰·메시지 대응 기록) ─────
  private cbToken(payload: object): string {
    const token = randomBytes(9).toString('base64url');
    this.db().prepare('INSERT INTO tg_cb VALUES(?,?,?,?,NULL)').run(token, JSON.stringify(payload), this.s().epoch, this.now());
    return token;
  }
  private markup(rows?: Btn[][], forceReply?: boolean) {
    if (forceReply) return { force_reply: true, selective: true };
    if (!rows?.length) return undefined;
    return { inline_keyboard: rows.map((r) => r.map((b) => ('url' in b ? { text: b.text, url: b.url } : { text: b.text, callback_data: this.cbToken(b.cb) }))) };
  }
  private async send(o: Out): Promise<number | null> {
    const link = this.s().link; if (!link) return null;
    const chunks = splitText(o.text, 3800);
    let id: number | null = null;
    for (let i = 0; i < chunks.length; i++) {
      const last = i === chunks.length - 1;
      const r = await this.call<{ message_id: number }>('sendMessage', { chat_id: link.chatId, text: chunks[i], parse_mode: 'HTML', disable_web_page_preview: true, ...(o.replyTo && i === 0 ? { reply_to_message_id: o.replyTo, allow_sending_without_reply: true } : {}), ...(last && this.markup(o.rows, o.forceReply) ? { reply_markup: this.markup(o.rows, o.forceReply) } : {}) });
      id = r.message_id;
    }
    if (id && o.kind) this.db().prepare('INSERT OR REPLACE INTO tg_msg VALUES(?,?,?,?,NULL)').run(id, o.kind, JSON.stringify(o.ref ?? {}), this.now());
    return id;
  }
  /** 알림은 로컬에 먼저 쌓고(연결이 끊겨도 잃지 않음) 보낼 때 아직 유효한지 다시 확인한다. 같은 키는 한 번만. */
  private enqueue(dkey: string, o: Out, batchable: boolean) {
    const due = this.now() + (batchable ? this.s().batchMinutes * 60_000 : 0);
    this.db().prepare('INSERT OR IGNORE INTO tg_outbox (dkey, payload, due, created, sent) VALUES(?,?,?,?,NULL)').run(dkey, JSON.stringify({ ...o, batchable }), due, this.now());
    if (this.state === 'connected') void this.flush().catch(() => null);
  }
  private flushing = false;
  async flush() {
    if (this.flushing || !this.s().link || this.state !== 'connected') return;
    this.flushing = true;
    try {
      const rows = this.db().prepare('SELECT id, dkey, payload FROM tg_outbox WHERE sent IS NULL AND due <= ? ORDER BY id').all(this.now()) as { id: number; dkey: string; payload: string }[];
      const batch: { id: number; o: Out }[] = [];
      for (const r of rows) {
        const o = JSON.parse(r.payload) as Out & { batchable: boolean; valid?: { item?: string; version?: string; commit?: [string, string] } };
        if (!this.stillValid(o.valid)) { this.db().prepare('UPDATE tg_outbox SET sent=? WHERE id=?').run(-1, r.id); continue; } // 그사이 처리된 질문·커밋은 보내지 않음
        if (o.batchable && !o.rows?.length) { batch.push({ id: r.id, o }); continue; }
        await this.send(o);
        this.db().prepare('UPDATE tg_outbox SET sent=? WHERE id=?').run(this.now(), r.id);
      }
      if (batch.length) {
        await this.send({ text: batch.length === 1 ? batch[0].o.text : `🗂 알림 ${batch.length}건\n\n${batch.map((b) => b.o.text).join('\n\n— — —\n\n')}` });
        for (const b of batch) this.db().prepare('UPDATE tg_outbox SET sent=? WHERE id=?').run(this.now(), b.id);
      }
      this.db().prepare('DELETE FROM tg_outbox WHERE sent IS NOT NULL AND created < ?').run(this.now() - 7 * 86400_000);
    } finally { this.flushing = false; }
  }
  private stillValid(v?: { item?: string; version?: string; commit?: [string, string] }): boolean {
    if (!v) return true;
    if (v.item) { const it = this.d.svc.pendingDecisions().find((x) => x.key === v.item); return !!it && (!v.version || decisionVersion(it) === v.version); }
    if (v.commit) return this.commitReq(v.commit[0], v.commit[1])?.status === 'pending';
    return true;
  }
  /** 앱에서 이미 처리한 질문·커밋 메시지의 버튼을 거둔다(앱과 텔레그램 상태를 맞춤) */
  async retireButtons() {
    const rows = this.db().prepare("SELECT message_id, kind, ref FROM tg_msg WHERE done IS NULL AND kind IN ('item','commit') AND created > ?").all(this.now() - 7 * 86400_000) as { message_id: number; kind: string; ref: string }[];
    const link = this.s().link; if (!link) return;
    for (const r of rows) {
      const ref = JSON.parse(r.ref) as { item?: string; version?: string; m?: string; r?: string };
      const valid = r.kind === 'item' ? this.stillValid({ item: ref.item, version: ref.version }) : this.stillValid({ commit: [ref.m!, ref.r!] });
      if (valid) continue;
      this.db().prepare('UPDATE tg_msg SET done=? WHERE message_id=?').run(this.now(), r.message_id);
      await this.call('editMessageReplyMarkup', { chat_id: link.chatId, message_id: r.message_id, reply_markup: { inline_keyboard: [[{ text: '✓ 처리됨(앱 또는 텔레그램)', callback_data: this.cbToken({ a: 'noop' }) }]] } }).catch(() => null);
    }
  }
  /** 다시 연결됐을 때: 현재 대기 목록을 한 번 맞춘다(앱이 꺼져 있던 동안의 알림을 몰아서 보내지 않음) */
  private async resync() {
    if (!this.s().link) return;
    const last = Number(this.kv('lastSync') ?? '0'); this.setKv('lastSync', String(this.now()));
    await this.retireButtons().catch(() => null);
    if (this.now() - last < 30 * 60_000) return;
    const items = this.pending();
    if (items.length) await this.send({ text: `🔄 앱과 다시 연결됐습니다. 지금 확인할 항목 ${items.length}건이 있습니다. /pending\n(앱이 꺼져 있던 동안 보낸 명령은 24시간이 지나면 텔레그램이 보관하지 않아 처리되지 않습니다.)` }).catch(() => null);
  }

  // ───── 앱 이벤트 → 의미 있는 변화만 알림 ─────
  onLive(e: LiveEvent) {
    if (e.type !== 'missionEvent' || !this.s().link || !this.s().enabled) return;
    try { this.notify(e.event); } catch { /* 알림 실패가 개발을 막지 않음 */ }
  }
  private wants(m: Mission): boolean { const s = this.s(); return (!s.projects || s.projects.includes(m.projectId)) && (!s.missions || s.missions.includes(m.id)); }
  private notify(ev: MissionEvent) {
    const svc = this.d.svc; let m: Mission; try { m = svc.missions.get(ev.missionId); } catch { return; }
    // 텔레그램으로 넣은 지시가 실제 계획에 반영되면 알린다(접수와 적용을 구분)
    if (ev.kind === 'operator_plan') {
      const w = this.db().prepare('SELECT seq, mode, text FROM tg_watch WHERE mission_id=? AND seq < ?').all(m.id, ev.seq) as { seq: number; mode: string; text: string }[];
      for (const x of w) { this.enqueue(`applied:${m.id}:${x.seq}`, { text: `${this.head(m)}\n✅ 지시가 사이클 ${ev.cycle} 계획에 반영됐습니다${x.mode === 'priority' ? '(우선 지시)' : ''}: ${esc(cut(x.text, 200))}` }, false); this.db().prepare('DELETE FROM tg_watch WHERE mission_id=? AND seq=?').run(m.id, x.seq); }
    }
    if (!this.wants(m)) return;
    const k = this.s().kinds;
    if (ev.kind === 'question' && ev.text.startsWith('완료 보고')) { if (k.results) this.enqueue(`done:${m.id}:${ev.seq}`, { text: `${this.head(m)}\n🏁 미션이 목표 달성을 보고했습니다. 결과물: /results`, rows: [[{ text: '결과물 보기', cb: { a: 'cmd', c: 'results', m: m.id } }]] }, false); return; }
    if (ev.kind === 'question' && k.review) { for (const it of this.pending(m.id).filter((x) => x.urgent)) this.enqueueItem(it); return; }
    if (ev.kind === 'system' && ev.text.includes('확인함에 올렸습니다') && k.results && m.checkpoint) { this.enqueue(`cp:${m.id}:${m.checkpoint.at}`, this.checkpointMsg(m), true); return; }
    if (ev.kind === 'system' && ev.text.startsWith('커밋 승인 요청') && k.commits) { for (const r of (m.commitRequests ?? []).filter((x) => x.status === 'pending')) void this.enqueueCommit(m, r); return; }
    if (ev.kind === 'cycle_end' && /: failed/.test(ev.text) && k.failures) { const sig = ev.text.replace(/사이클 \d+/g, '').replace(/\d+/g, '#').slice(0, 160); this.enqueue(`fail:${m.id}:${sig}`, { text: `${this.head(m)}\n❗ ${esc(cut(ev.text, 400))}\n(같은 실패는 다시 알리지 않습니다. 다른 작업은 계속됩니다.)` }, true); return; }
    if (ev.kind === 'system' && /^(Claude 한도 대기|사용 한도 도달|연결·서비스 일시 장애)/.test(ev.text) && k.limit) { this.enqueue(`limit:${m.id}:${ev.seq}`, { text: `${this.head(m)}\n⏳ ${esc(cut(ev.text, 400))}\n텔레그램 조회·지시 접수·결정 처리는 계속 됩니다.` }, true); return; }
    if (ev.kind === 'system' && /(한도가 풀려|연결이 회복돼)/.test(ev.text) && k.limit) { this.enqueue(`limitok:${m.id}:${ev.seq}`, { text: `${this.head(m)}\n▶️ ${esc(cut(ev.text, 300))}` }, true); return; }
    if ((ev.kind === 'cycle_start' || ev.kind === 'cycle_end') && k.cycle) this.enqueue(`cyc:${m.id}:${ev.seq}`, { text: `${this.head(m)}\n· ${esc(cut(ev.text, 300))}` }, true);
  }

  // ───── 받기: 권한 확인 → 명령·버튼·답장 ─────
  private authorized(fromId: number | undefined, chatId: number | undefined, chatType?: string): boolean {
    const l = this.s().link; return !!l && fromId === l.userId && chatId === l.chatId && (chatType === undefined || chatType === 'private');
  }
  private async handle(u: TgUpdate) {
    if (u.callback_query) return this.onCallback(u.callback_query);
    const msg = u.message; if (!msg || !msg.chat || !msg.from) return;
    if (msg.chat.type !== 'private') return; // 최초 범위: 1:1 대화만(그룹·채널은 무시)
    const text = String(msg.text ?? '').trim();
    if (!this.authorized(msg.from.id, msg.chat.id, msg.chat.type)) {
      // 일회용 연결 코드: 앱에서 만든 코드일 때만 '연결 요청'으로 받고, 앱에서 사용자가 확인해야 등록된다(처음 보낸 사람을 자동 관리자로 두지 않음)
      const m = /^\/start\s+([A-Za-z0-9]{6,12})$/.exec(text); const s = this.s();
      const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') + (msg.from.username ? ` (@${msg.from.username})` : '') + ` · ID ${msg.from.id}`;
      if (m && s.linkCode && s.linkCode.expires > this.now() && m[1] === s.linkCode.code && !s.link) {
        // 코드는 받는 즉시 쓰고 버린다(다른 계정이 같은 코드로 후보를 바꿔치지 못하게)
        this.save({ candidate: { userId: msg.from.id, chatId: msg.chat.id, name, at: new Date(this.now()).toISOString() }, linkCode: null });
        await this.rawSend(msg.chat.id, '연결 요청을 받았습니다. 컴퓨터의 CREWGENAI 앱 설정 > 텔레그램에서 이 계정을 확인하면 연결됩니다.');
      } else {
        this.lastDenied = `${new Date(this.now()).toLocaleString('ko-KR')} · ${name}`; this.d.onStatus?.();
        await this.rawSend(msg.chat.id, '이 봇은 등록된 계정만 사용할 수 있습니다.');
      }
      return;
    }
    const age = this.now() / 1000 - Number(msg.date ?? 0);
    const reply = msg.reply_to_message?.message_id;
    if (reply && !text.startsWith('/')) return this.onReply(reply, text, age);
    const cmd = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text);
    if (cmd) return this.command(cmd[1].toLowerCase(), (cmd[2] ?? '').trim(), age);
    if (text) return this.plainText(text, age);
  }
  private async rawSend(chatId: number, text: string) { await this.call('sendMessage', { chat_id: chatId, text }).catch(() => null); }
  private stale(age: number): boolean { return age > STALE_SEC; }
  private async staleNotice(what: string) { await this.send({ text: `⏱ ${what} 명령을 보낸 지 오래돼(10분 넘음) 실행하지 않았습니다. 지금 대상이 맞는지 확인한 뒤 다시 보내 주세요.\n${this.head(this.target())}` }); }

  private async command(c: string, arg: string, age: number) {
    const m = this.target();
    switch (c) {
      case 'start': case 'menu': case 'help': return this.menu();
      case 'projects': return this.projects();
      case 'status': return this.send({ text: this.statusText(m), rows: this.ctlRows(m) });
      case 'tasks': return this.send({ text: this.tasksText(m) });
      case 'pending': return this.pendingList();
      case 'commits': return this.commitsList();
      case 'results': return this.resultsList(m);
      case 'usage': return this.send({ text: this.usageText(m) });
      case 'health': return this.send({ text: await this.healthText() });
      case 'next': case 'now': {
        if (this.stale(age)) return this.staleNotice(`/${c}`);
        if (!arg) return this.send({ text: `사용법: /${c} 지시 내용` });
        return this.directive(m, arg, c === 'now' ? 'priority' : 'next');
      }
      case 'pause': case 'resume': case 'stop': {
        if (this.stale(age)) return this.staleNotice(`/${c}`);
        if (!m) return this.send({ text: '대상 미션이 없습니다. /projects 에서 고르세요.' });
        return this.control(m.id, c as 'pause' | 'resume' | 'stop');
      }
      default: return this.send({ text: '모르는 명령입니다. /menu' });
    }
  }
  private async plainText(text: string, age: number) {
    const m = this.target();
    if (!m) return this.send({ text: '어느 미션에 대한 지시인지 정해 주세요.', rows: this.missionButtons({ a: 'dt', text: cut(text, 1500) }) });
    if (this.stale(age)) return this.staleNotice('지시');
    const urgentQ = this.pending(m.id).filter((x) => x.urgent && (x.kind === 'question' || x.kind === 'gap'));
    if (m.status === 'waiting_user' && urgentQ.length === 1) {
      // 대상은 명확하지만 의도가 둘(질문 답 / 새 지시)일 수 있을 때만 짧게 묻는다
      const it = urgentQ[0];
      return this.send({ text: `${this.head(m)}\n이 문장을 어떻게 처리할까요?\n“${esc(cut(text, 300))}”`, rows: [[{ text: '대기 중인 질문의 답으로', cb: { a: 'ans', k: it.key, v: decisionVersion(it), text: cut(text, 1500) } }], [{ text: '다음 지시로 접수', cb: { a: 'dt', m: m.id, text: cut(text, 1500) } }]] });
    }
    return this.directive(m, text, 'next');
  }
  private async directive(m: Mission | null, text: string, mode: 'next' | 'priority') {
    if (!m) return this.send({ text: '대상 미션이 없습니다. /projects 에서 고르세요.' });
    if (!['planning', 'running', 'evaluating'].includes(m.status)) return this.send({ text: `${this.head(m)}\n이 미션은 ${STATUS_KO[m.status] ?? m.status} 상태라 지시를 접수할 수 없습니다.${m.status === 'waiting_user' ? ' /pending 에서 결정을 처리하세요.' : ' 앱에서 이어서 진행하거나 새 미션을 시작하세요.'}` });
    await this.d.svc.missions.addDirective(m.id, text, mode);
    const seq = Math.max(0, ...this.d.svc.missions.events(m.id).map((e) => e.seq));
    this.db().prepare('INSERT OR REPLACE INTO tg_watch VALUES(?,?,?,?)').run(m.id, seq, mode, cut(text, 300));
    return this.send({ text: `${this.head(m)}\n📥 접수했습니다(${mode === 'priority' ? '우선 지시: 진행 중인 파일 수정·저장은 끊지 않고, 지금 실행이 끝나는 대로 다음 계획 맨 앞에 반영' : '다음 계획에 반영'}). 실제로 반영되면 다시 알려 드립니다.` });
  }
  private async control(id: string, x: 'pause' | 'resume' | 'stop' | 'stopc') {
    const m = this.d.svc.missions.get(id);
    try {
      if (x === 'pause') { this.d.svc.missions.pause(id); return this.send({ text: `${this.head(m)}\n⏸ 일시정지했습니다. 진행 중인 단계는 마저 끝내고, 새 작업 배정은 /resume 까지 멈춥니다.` }); }
      if (x === 'resume') { this.d.svc.missions.resume(id); return this.send({ text: `${this.head(m)}\n▶️ 재개했습니다.` }); }
      if (x === 'stop') return this.send({ text: `${this.head(m)}\n정말 중단할까요? 진행 중인 작업을 취소하고, 한도 해제·앱 재시작에도 자동으로 다시 시작하지 않습니다.`, rows: [[{ text: '중단', cb: { a: 'mc', m: id, x: 'stopc' } }, { text: '취소', cb: { a: 'noop' } }]] });
      await this.d.svc.missions.stop(id);
      return this.send({ text: `${this.head(m)}\n⏹ 중단했습니다. 자동 재개 예약도 해제했습니다.` });
    } catch (e) { return this.send({ text: `${this.head(m)}\n${esc((e as Error).message)}` }); }
  }

  private async onCallback(q: TgCallback) {
    const answer = (text: string) => this.call('answerCallbackQuery', { callback_query_id: q.id, text: cut(text, 190) }).catch(() => null);
    // 버튼도 같은 확인: 등록한 사용자 + 등록한 1:1 대화
    if (!this.authorized(q.from?.id, q.message?.chat?.id, q.message?.chat?.type)) { this.lastDenied = `${new Date(this.now()).toLocaleString('ko-KR')} · 버튼 ID ${q.from?.id}`; this.d.onStatus?.(); return answer('등록된 계정만 사용할 수 있습니다.'); }
    const row = this.db().prepare('SELECT payload, epoch, used FROM tg_cb WHERE token=?').get(String(q.data ?? '')) as { payload: string; epoch: number; used: number | null } | undefined;
    if (!row || row.epoch !== this.s().epoch) return answer('지난 연결의 버튼이라 실행하지 않았습니다. /menu');
    const p = JSON.parse(row.payload) as Record<string, string> & { a: string };
    const once = ['apply', 'c', 'cba', 'mc', 'ans', 'dt', 'cpok'].includes(p.a);
    if (once) {
      // 한 번만: 중복 클릭·통신 재시도로 같은 버튼이 두 번 실행되지 않게(먼저 표시하고 실행)
      const r = this.db().prepare('UPDATE tg_cb SET used=? WHERE token=? AND used IS NULL').run(this.now(), String(q.data));
      if (!r.changes) return answer('이미 처리한 버튼입니다.');
    }
    const age = this.now() / 1000 - Number(q.message?.date ?? 0);
    const changes = ['apply', 'c', 'cba', 'mc', 'ans', 'dt', 'cpok'].includes(p.a) && !(p.a === 'c' && p.x === 'detail') && !(p.a === 'mc' && p.x === 'stop');
    if (changes && this.backlog) {
      // 앱이 꺼져 있던 동안 누른 버튼은 언제 눌렀는지 알 수 없다: 실행하지 않고 지금 상태로 다시 확인하게 한다(한 번만 쓰는 버튼은 되살림)
      if (once) this.db().prepare('UPDATE tg_cb SET used=NULL WHERE token=?').run(String(q.data));
      await answer('앱이 꺼져 있던 동안 누른 버튼이라 실행하지 않았습니다');
      return this.send({ text: '⏱ 앱이 꺼져 있거나 연결이 끊긴 동안 누른 버튼이라 실행하지 않았습니다. 지금 상태를 확인한 뒤 다시 눌러 주세요. /pending /commits' });
    }
    try {
      switch (p.a) {
        case 'noop': return answer('');
        case 'cmd': { if (p.m) this.setTarget(p.m); await answer(''); return this.command(p.c, '', 0); }
        case 'tgt': { this.setTarget(p.m); await answer('대상을 바꿨습니다'); return this.send({ text: this.statusText(this.target()), rows: this.ctlRows(this.target()) }); }
        case 'pick': { this.draft(p.k, p.v, p.ver, p.kind); await answer(`선택됨(적용 전): ${p.v}`); return this.draftBar(); }
        case 'own': { await answer(''); return this.send({ text: `이 항목에 보낼 답을 이 메시지에 <b>답장</b>으로 적어 주세요.\n${esc(cut(p.q ?? '', 200))}`, forceReply: true, kind: 'own', ref: { k: p.k, ver: p.ver } }); }
        case 'fill': { const n = this.fillRec(); await answer(`추천안 ${n}건 선택(적용 전)`); return this.draftBar(true); }
        case 'clear': { this.db().exec('DELETE FROM tg_draft'); return answer('선택을 지웠습니다'); }
        case 'apply': { await answer('적용 중…'); return this.applyDrafts(); }
        case 'ans': { await answer(''); return this.applyOne(p.k, p.text, p.ver); }
        case 'dt': { await answer(''); if (p.m) this.setTarget(p.m); return this.directive(p.m ? this.d.svc.missions.get(p.m) : this.target(), p.text, 'next'); }
        case 'mc': { void age; await answer(''); return this.control(p.m, p.x as 'pause'); }
        case 'c': { await answer(''); return this.commitAction(p.m, p.r, p.h, p.x as CommitAct); }
        case 'csel': { this.draft(`commit|${p.m}|${p.r}`, p.h, '', 'commit'); await answer('커밋 선택됨(적용 전)'); return this.commitBar(); }
        case 'cba': { await answer('커밋 중…'); return this.commitBatch(); }
        case 'cp': { await answer(''); return this.send(this.checkpointMsg(this.d.svc.missions.get(p.m))); }
        case 'cpok': { await answer(''); return this.reviewCheckpoint(p.m, p.at, '', 'continue'); }
        case 'pv': { await answer('화면을 찍는 중…'); return this.preview(p.m, Number(p.i)); }
        default: return answer('지원하지 않는 버튼입니다.');
      }
    } catch (e) { await answer('처리하지 못했습니다'); return this.send({ text: `⚠️ ${esc(this.hide((e as Error).message)).slice(0, 400)}` }); }
  }
  /** 봇 메시지에 답장: 결정 항목이면 그 항목의 답, 결과물이면 그 결과물 피드백, 검토 카드면 검토 피드백, 커밋 수정 요청이면 수정 지시 */
  private async onReply(messageId: number, text: string, age: number) {
    const r = this.db().prepare('SELECT kind, ref FROM tg_msg WHERE message_id=?').get(messageId) as { kind: string; ref: string } | undefined;
    if (!r) return this.plainText(text, age);
    const ref = JSON.parse(r.ref) as Record<string, string>;
    if (this.stale(age)) return this.staleNotice('답장');
    if (r.kind === 'item' || r.kind === 'own') return this.applyOne(ref.item ?? ref.k, text, ref.version ?? ref.ver);
    if (r.kind === 'result') {
      const m = this.d.svc.missions.get(ref.m);
      const fb = `[결과물 피드백 · ${ref.title}] ${text}`;
      if (m.checkpoint) return this.reviewCheckpoint(m.id, m.checkpoint.at, fb, 'continue');
      return this.directive(m, fb, 'next');
    }
    if (r.kind === 'checkpoint') return this.reviewCheckpoint(ref.m, ref.at, text, 'continue');
    if (r.kind === 'commitChange') {
      const m = this.d.svc.missions.get(ref.m); const req = this.commitReq(ref.m, ref.r);
      if (req?.status === 'pending') this.d.svc.commitDecline(ref.m, ref.r);
      return this.directive(m, `[커밋 수정 요청 · "${req?.message ?? ''}"] ${text}`, 'next');
    }
    return this.plainText(text, age);
  }

  // ───── 확인함 ─────
  private pending(missionId?: string): PendingDecision[] { return this.d.svc.pendingDecisions().filter((x) => (!missionId || x.missionId === missionId) && this.wantsId(x.projectId, x.missionId)); }
  private wantsId(projectId: string, missionId: string) { const s = this.s(); return (!s.projects || s.projects.includes(projectId)) && (!s.missions || s.missions.includes(missionId)); }
  private itemMsg(it: PendingDecision): Out {
    const v = decisionVersion(it);
    const rec = it.choices.find((c) => c.recommended);
    const lines = [
      `${this.headIds(it.projectId, it.missionId)}`,
      `${it.urgent ? '🟠 <b>결정 필요(미션이 기다림)</b>' : '🟡 <b>확인 필요(다른 작업은 계속)</b>'} · ${esc(it.task)}`,
      `<b>${esc(cut(it.question, 600))}</b>`,
      it.held ? `왜: ${esc(it.held)}` : '', it.explain ? esc(cut(it.explain, 500)) : '',
      it.grants ? `허용하면: ${esc(it.grants)}` : '',
      ...it.choices.map((c, i) => `${i + 1}. ${esc(c.label)}${c.recommended ? ' ⭐추천' : ''}${c.effect ? ` — ${esc(cut(c.effect, 200))}` : ''}`),
      rec?.why ? `추천 이유: ${esc(cut(rec.why, 300))}` : '',
      it.resumes ? `정하면: ${esc(it.resumes)}` : '',
      it.urgent ? '' : '답하지 않아도 다른 작업은 계속 진행됩니다.',
      '버튼은 <b>선택</b>만 합니다. /pending 의 “선택한 내용 적용”을 눌러야 반영됩니다. 이 메시지에 답장하면 그 내용으로 바로 답합니다.',
    ].filter(Boolean);
    const batchable = it.kind === 'question' || it.kind === 'gap' || it.kind === 'permission' || it.kind === 'merge';
    const rows: Btn[][] = batchable ? it.choices.map((c) => [{ text: `${c.recommended ? '⭐ ' : ''}${cut(c.label, 40)}`, cb: { a: 'pick', k: it.key, v: c.label, ver: v, kind: it.kind } }]) : [];
    if (batchable && it.kind !== 'permission' && it.kind !== 'merge') rows.push([{ text: '직접 답 쓰기', cb: { a: 'own', k: it.key, ver: v, q: cut(it.question, 200) } }]);
    if (it.kind === 'checkpoint') rows.push([{ text: '결과 검토 열기', cb: { a: 'cp', m: it.missionId } }]);
    if (it.kind === 'commit' && it.commit) rows.push([{ text: '커밋 요청 보기', cb: { a: 'cmd', c: 'commits', m: it.missionId } }]);
    return { text: lines.join('\n'), rows, kind: 'item', ref: { item: it.key, version: v } };
  }
  private enqueueItem(it: PendingDecision) { const v = decisionVersion(it); this.enqueue(`item:${it.key}:${v}`, { ...this.itemMsg(it), valid: { item: it.key, version: v } } as Out, false); }
  private async pendingList() {
    const items = this.pending();
    if (!items.length) return this.send({ text: '✅ 지금 답변·검토·승인할 항목이 없습니다.' });
    await this.send({ text: `📋 확인할 항목 ${items.length}건 (미션을 멈춘 것 ${items.filter((x) => x.urgent).length}건)\n추천 표시·읽음·시간 경과는 승인이 아닙니다. 고른 뒤 “선택한 내용 적용”을 눌러야 반영됩니다.` });
    for (const it of items.slice(0, 15)) await this.send(this.itemMsg(it));
    if (items.length > 15) await this.send({ text: `…외 ${items.length - 15}건은 앱 확인함에서 보세요.` });
    return this.draftBar();
  }
  private draft(item: string, choice: string, version: string, kind: string) { this.db().prepare('INSERT OR REPLACE INTO tg_draft VALUES(?,?,?,?)').run(item, choice, version, kind); }
  private fillRec(): number {
    let n = 0;
    for (const it of this.pending()) {
      if (it.kind !== 'question' && it.kind !== 'gap') continue; // 권한 허용·커밋은 추천으로 채우지 않음(직접 골라야 함)
      if (this.db().prepare('SELECT 1 FROM tg_draft WHERE item=?').get(it.key)) continue;
      const r = it.choices.find((c) => c.recommended); if (!r) continue;
      this.draft(it.key, r.label, decisionVersion(it), it.kind); n++;
    }
    return n;
  }
  private async draftBar(showAll = false) {
    const ds = this.db().prepare("SELECT item, choice, version, kind FROM tg_draft WHERE kind != 'commit'").all() as { item: string; choice: string; version: string; kind: string }[];
    const items = new Map(this.pending().map((x) => [x.key, x]));
    const lines = ds.map((d) => {
      if (d.item.startsWith('cpd|')) { const [, mid, , qi] = d.item.split('|'); let q = '검토 카드 결정'; try { q = this.d.svc.missions.get(mid).checkpoint?.decisions[Number(qi)]?.question ?? q; } catch { /* 없음 */ } return `· [검토 카드] ${esc(cut(q, 80))}\n   → <b>${esc(cut(d.choice, 80))}</b>`; }
      const it = items.get(d.item); return it ? `· ${esc(cut(it.missionTitle, 30))} — ${esc(cut(it.question, 80))}\n   → <b>${esc(cut(d.choice, 80))}</b>` : `· (이미 처리된 항목) → ${esc(cut(d.choice, 60))}`;
    });
    return this.send({ text: ds.length ? `🧾 선택한 내용(아직 적용 안 됨) ${ds.length}건${showAll || ds.length <= 8 ? `\n${lines.join('\n')}` : ''}` : '선택한 항목이 없습니다. 각 항목의 버튼으로 고르거나 “추천안 모두 선택”을 누르세요.',
      rows: [[{ text: `선택한 내용 적용(${ds.length})`, cb: { a: 'apply' } }], [{ text: '⭐ 추천안 모두 선택', cb: { a: 'fill' } }, { text: '선택 지우기', cb: { a: 'clear' } }]] });
  }
  private async applyDrafts() {
    const ds = this.db().prepare("SELECT item, choice, version FROM tg_draft WHERE kind != 'commit'").all() as { item: string; choice: string; version: string }[];
    if (!ds.length) return this.send({ text: '적용할 선택이 없습니다.' });
    const cp = ds.filter((d) => d.item.startsWith('cpd|')); const rest = ds.filter((d) => !d.item.startsWith('cpd|'));
    const r = this.d.svc.applyDecisions(rest.map((d) => ({ key: d.item, choice: d.choice, version: d.version })), '텔레그램');
    for (const d of ds) this.db().prepare('DELETE FROM tg_draft WHERE item=?').run(d.item);
    const extra: string[] = [];
    // 같은 검토 카드의 결정은 한 번에 보낸다(따로 보내면 첫 번째 뒤에 카드가 닫혀 나머지를 잃음)
    const groups = new Map<string, { mid: string; at: string; picks: { idx: number; choice: string }[] }>();
    for (const d of cp) { const [, mid, at, qi] = d.item.split('|'); const k = `${mid}|${at}`; const g = groups.get(k) ?? { mid, at, picks: [] }; g.picks.push({ idx: Number(qi), choice: d.choice }); groups.set(k, g); }
    for (const g of groups.values()) { const out = await this.reviewCheckpoint(g.mid, g.at, '', 'continue', g.picks, true); if (out) extra.push(out); }
    await this.retireButtons().catch(() => null);
    return this.send({ text: `✅ ${r.applied + extra.length}건 적용${r.stale ? ` · 이미 처리됐거나 내용이 바뀐 ${r.stale}건은 적용하지 않음` : ''}\n${[...r.lines, ...extra].map(esc).join('\n')}` });
  }
  private async applyOne(key: string, text: string, version?: string) {
    const it = this.d.svc.pendingDecisions().find((x) => x.key === key);
    if (!it) return this.send({ text: '이미 처리됐거나 없어진 항목입니다. /pending' });
    if (it.kind === 'permission' || it.kind === 'merge') return this.send({ text: '이 항목은 보여 드린 선택지 버튼으로만 정할 수 있습니다.' });
    const r = this.d.svc.applyDecisions([{ key, choice: text, version }], '텔레그램');
    await this.retireButtons().catch(() => null);
    return this.send({ text: r.applied ? `✅ 반영했습니다.\n${r.lines.map(esc).join('\n')}` : '내용이 바뀌었거나 이미 처리된 항목이라 적용하지 않았습니다. /pending 으로 다시 확인하세요.' });
  }

  // ───── 검토 카드(결과 준비) ─────
  private checkpointMsg(m: Mission): Out {
    const c = m.checkpoint; if (!c) return { text: `${this.head(m)}\n열려 있는 검토 카드가 없습니다.` };
    const lines = [this.head(m), `🧪 <b>${c.blocking ? '결정 필요' : '검토할 결과가 준비됐습니다(개발은 계속)'}</b> · 사이클 ${c.cycle}`, `<b>${esc(cut(c.title, 300))}</b>`,
      ...c.features.slice(0, 6).map((f) => `· [${RESULT_STATUS_LABEL[f.status] ?? f.status}] ${esc(cut(f.name, 120))}${f.changed ? ` — ${esc(cut(f.changed, 160))}` : ''}`),
      c.steps ? `확인 순서:\n${esc(cut(c.steps, 700))}` : '', c.verified ? `확인한 범위: ${esc(cut(c.verified, 400))}` : '', c.unverified ? `미완성·미검증: ${esc(cut(c.unverified, 400))}` : '',
      ...c.decisions.map((d, i) => `결정 ${i + 1}. ${esc(cut(d.question, 300))}\n${d.choices.map((x) => `   - ${esc(x.label)}${x.recommended ? ' ⭐추천' : ''}${x.effect ? ` — ${esc(cut(x.effect, 120))}` : ''}`).join('\n')}`),
      '이 메시지에 답장하면 검토 피드백으로 보냅니다. 시연은 /results', ].filter(Boolean);
    const rows: Btn[][] = [];
    c.decisions.forEach((d, qi) => d.choices.forEach((x) => rows.push([{ text: `결정${qi + 1}: ${x.recommended ? '⭐ ' : ''}${cut(x.label, 34)}`, cb: { a: 'pick', k: `cpd|${m.id}|${c.at}|${qi}`, v: x.label, ver: '', kind: 'cp' } }])));
    rows.push([{ text: '결과물·시연 보기', cb: { a: 'cmd', c: 'results', m: m.id } }]);
    if (c.blocking) rows.push([{ text: '확인했어요 — 이어서 진행', cb: { a: 'cpok', m: m.id, at: c.at } }]);
    return { text: lines.join('\n'), rows, kind: 'checkpoint', ref: { m: m.id, at: c.at } };
  }
  private async reviewCheckpoint(missionId: string, at: string, feedback: string, action: 'continue' | 'stop', picks: { idx: number; choice: string }[] = [], quiet = false): Promise<string | void> {
    const m = this.d.svc.missions.get(missionId);
    if (!m.checkpoint || m.checkpoint.at !== at) { const t = '그 검토 카드는 이미 처리됐거나 새 카드로 바뀌었습니다.'; if (quiet) return t; return void (await this.send({ text: `${this.head(m)}\n${t}` })); }
    const c = m.checkpoint;
    this.d.svc.missions.review(missionId, picks.filter((p) => c.decisions[p.idx]).map((p) => ({ doc: c.decisions[p.idx].doc, question: c.decisions[p.idx].question, choice: p.choice })), feedback, action);
    const t = `검토 반영(텔레그램): ${picks.length ? `결정 ${picks.length}건` : ''}${feedback ? ' 피드백 1건' : ''} → ${c.blocking ? '미션이 이어서 진행합니다' : '다음 계획부터 반영'}`;
    if (quiet) return `· ${m.prompt.split('\n')[0].slice(0, 30)}: ${t}`;
    await this.send({ text: `${this.head(m)}\n✅ ${esc(t)}` });
  }

  // ───── 커밋 승인 ─────
  private commitReq(missionId: string, reqId: string): MissionCommitRequest | null { try { return (this.d.svc.missions.get(missionId).commitRequests ?? []).find((r) => r.id === reqId) ?? null; } catch { return null; } }
  private async commitMsg(m: Mission, r: MissionCommitRequest): Promise<Out & { valid: object }> {
    let p: CommitPreview | null = null; let perr = '';
    try { p = await this.d.svc.commitPreview(m.id, r.id); } catch (e) { perr = (e as Error).message; }
    const add = p?.files.reduce((s, f) => s + (f.added ?? 0), 0) ?? 0; const del = p?.files.reduce((s, f) => s + (f.removed ?? 0), 0) ?? 0;
    const counts = p ? { new: p.files.filter((f) => f.status.trim() === '??' || f.status.includes('A')).length, del: p.files.filter((f) => f.status.includes('D')).length } : { new: 0, del: 0 };
    const res = (m.results ?? []).filter((x) => r.task && x.task === r.task);
    const verified = res.map((x) => x.verified).filter(Boolean).join(' / '); const remaining = res.map((x) => x.remaining).filter(Boolean).join(' / ');
    const caution = [...(p?.blocked ?? []).map((b) => `막힘: ${b}`), ...(p?.files ?? []).filter((f) => f.flags.length).map((f) => `${f.path}: ${f.flags.map((x) => p!.flagLabels[x] ?? x).join(', ')}`)];
    const lines = [this.head(m), '📝 <b>커밋 승인 요청</b>',
      `저장소: <b>${esc(r.repo || '(연결 폴더)')}</b> · 받을 브랜치: <b>${esc(p?.target ?? p?.branch ?? '—')}</b>${p?.target && p.branch && p.target !== p.branch ? ` (지금 ${esc(p.branch)})` : ''}`,
      `목적: ${esc(cut(r.why || r.task || '—', 400))}`,
      `변경: 파일 ${p?.files.length ?? r.files.length}개 · +${add} −${del}${counts.new ? ` · 새 파일 ${counts.new}` : ''}${counts.del ? ` · 삭제 ${counts.del}` : ''}`,
      `주요 파일: ${esc((p?.files.map((f) => f.path) ?? r.files).slice(0, 8).join(', '))}${(p?.files.length ?? r.files.length) > 8 ? ' …' : ''}`,
      `검증: ${verified ? esc(cut(verified, 400)) : '이 작업에 연결된 검증 기록 없음(실행하지 않은 검증으로 봄)'}`, remaining ? `남은 것·미검증: ${esc(cut(remaining, 300))}` : '',
      `커밋 메시지: <code>${esc(cut(r.message, 200))}</code>`,
      caution.length ? `⚠️ 주의: ${esc(cut(caution.join(' / '), 500))}` : '', perr ? `⚠️ 지금 상태를 읽지 못함: ${esc(cut(perr, 200))}` : '', p?.error ? `⚠️ ${esc(cut(p.error, 200))}` : '',
      '승인은 위에 보인 변경 묶음에만 적용됩니다(그 뒤 바뀌면 커밋하지 않고 새로 보여 드림). push·main 병합·배포는 하지 않습니다.'].filter(Boolean);
    const h = p?.hash ?? '';
    const canApprove = !!p && !p.error && !p.blocked.length;
    const rows: Btn[][] = [[{ text: '변경 상세', cb: { a: 'c', m: m.id, r: r.id, h, x: 'detail' } }], ...(canApprove ? [[{ text: '✅ 커밋 승인', cb: { a: 'c', m: m.id, r: r.id, h, x: 'approve' } }, { text: '묶음 승인에 넣기', cb: { a: 'csel', m: m.id, r: r.id, h } }]] : []), [{ text: '수정 요청', cb: { a: 'c', m: m.id, r: r.id, h, x: 'changes' } }, { text: '보류', cb: { a: 'c', m: m.id, r: r.id, h, x: 'hold' } }, { text: '거절', cb: { a: 'c', m: m.id, r: r.id, h, x: 'decline' } }]];
    return { text: lines.join('\n'), rows, kind: 'commit', ref: { m: m.id, r: r.id, h }, valid: { commit: [m.id, r.id] } };
  }
  private async enqueueCommit(m: Mission, r: MissionCommitRequest) { const o = await this.commitMsg(m, r); this.enqueue(`commit:${r.id}:${(o.ref as { h: string }).h}`, o, false); }
  private async commitsList() {
    const all = this.d.svc.store.listProjects().flatMap((p) => this.d.svc.missions.list(p.id)).filter((m) => this.wantsId(m.projectId, m.id)).flatMap((m) => (m.commitRequests ?? []).filter((r) => r.status === 'pending').map((r) => ({ m, r })));
    if (!all.length) return this.send({ text: '✅ 승인을 기다리는 커밋 요청이 없습니다.' });
    for (const { m, r } of all.slice(0, 10)) await this.send(await this.commitMsg(m, r));
    return this.commitBar();
  }
  private async commitBar() {
    const ds = this.db().prepare("SELECT item, choice FROM tg_draft WHERE kind = 'commit'").all() as { item: string; choice: string }[];
    return this.send({ text: ds.length ? `📦 묶음 승인에 넣은 커밋 ${ds.length}건(아직 커밋 안 함):\n${ds.map((d) => { const [, mid, rid] = d.item.split('|'); const r = this.commitReq(mid, rid); return `· ${esc(r?.repo || '(연결 폴더)')} · “${esc(cut(r?.message ?? '', 60))}”`; }).join('\n')}` : '여러 커밋을 한 번에 승인하려면 각 요청의 “묶음 승인에 넣기”를 누르세요.', rows: ds.length ? [[{ text: `선택한 커밋 승인(${ds.length})`, cb: { a: 'cba' } }], [{ text: '선택 지우기', cb: { a: 'clear' } }]] : undefined });
  }
  private async commitBatch() {
    const ds = this.db().prepare("SELECT item, choice FROM tg_draft WHERE kind = 'commit'").all() as { item: string; choice: string }[];
    const out: string[] = [];
    for (const d of ds) {
      const [, mid, rid] = d.item.split('|'); this.db().prepare('DELETE FROM tg_draft WHERE item=?').run(d.item);
      const r = this.commitReq(mid, rid);
      try { const x = await this.d.svc.commitApprove(mid, rid, d.choice, '텔레그램'); out.push(`✅ ${r?.repo || '(연결 폴더)'}: ${x.branch ?? ''} ${x.sha?.slice(0, 8) ?? ''}`); }
      catch (e) { out.push(`❌ ${r?.repo || '(연결 폴더)'}: ${this.hide((e as Error).message).slice(0, 160)}`); } // 실패한 것 때문에 다른 커밋을 다시 실행하지 않음
    }
    await this.retireButtons().catch(() => null);
    return this.send({ text: `커밋 결과(저장소별):\n${out.map(esc).join('\n')}\npush·main 병합·배포는 하지 않았습니다.` });
  }
  private async commitAction(missionId: string, reqId: string, shownHash: string, x: CommitAct) {
    const m = this.d.svc.missions.get(missionId); const r = this.commitReq(missionId, reqId);
    if (!r) return this.send({ text: '커밋 요청을 찾을 수 없습니다.' });
    if (x === 'detail') return this.commitDetail(m, r);
    if (r.status !== 'pending') return this.send({ text: `${this.head(m)}\n이미 처리한 커밋 요청입니다(${r.status === 'approved' ? `커밋됨 ${r.sha?.slice(0, 8) ?? ''}` : r.status === 'approving' ? '커밋 중' : r.status === 'declined' ? '거절됨' : '실패'}).` });
    if (x === 'approve') {
      try { const done = await this.d.svc.commitApprove(missionId, reqId, shownHash, '텔레그램'); await this.retireButtons().catch(() => null); return this.send({ text: `${this.head(m)}\n✅ 커밋했습니다: ${esc(done.repo || '(연결 폴더)')} → ${esc(done.branch ?? '')} <code>${done.sha?.slice(0, 10) ?? ''}</code>\npush·main 병합·배포는 하지 않았습니다.` }); }
      catch (e) {
        const msg = (e as Error).message;
        if (/바뀌었습니다/.test(msg)) { await this.send({ text: `${this.head(m)}\n⚠️ 보여 드린 뒤 변경 내용이 바뀌어 커밋하지 않았습니다. 새 내용을 다시 확인하세요.` }); const cur = this.commitReq(missionId, reqId); if (cur?.status === 'pending') return this.send(await this.commitMsg(m, cur)); return; }
        return this.send({ text: `${this.head(m)}\n❌ 커밋하지 못했습니다: ${esc(this.hide(msg)).slice(0, 300)}` });
      }
    }
    if (x === 'decline') { this.d.svc.commitDecline(missionId, reqId); await this.retireButtons().catch(() => null); return this.send({ text: `${this.head(m)}\n거절했습니다. 오퍼레이터는 이 결정을 따릅니다.` }); }
    if (x === 'hold') return this.send({ text: `${this.head(m)}\n보류했습니다. 요청은 그대로 남아 있고 다시 알리지 않습니다(/commits 에서 다시 볼 수 있음).` });
    return this.send({ text: `수정할 내용을 이 메시지에 <b>답장</b>으로 적어 주세요. 보내면 이 커밋 요청은 거절로 기록하고, 오퍼레이터에게 수정 지시로 전달합니다.\n“${esc(cut(r.message, 100))}”`, forceReply: true, kind: 'commitChange', ref: { m: missionId, r: reqId } });
  }
  private async commitDetail(m: Mission, r: MissionCommitRequest) {
    const p = await this.d.svc.commitPreview(m.id, r.id).catch(() => null);
    const files = p?.files ?? [];
    const lines = files.slice(0, 40).map((f) => `${f.status.trim() === '??' ? '새' : f.status.includes('D') ? '삭제' : '수정'} ${esc(f.path)} +${f.added ?? '?'} −${f.removed ?? '?'}${f.flags.length ? ` ⚠️${f.flags.map((x) => p!.flagLabels[x] ?? x).join(',')}` : ''}`);
    await this.send({ text: `${this.head(m)}\n📄 변경 상세 · ${esc(r.repo || '(연결 폴더)')}\n${lines.join('\n')}${files.length > 40 ? `\n…외 ${files.length - 40}개` : ''}` });
    if (!this.s().sourceDetail[m.projectId]) return this.send({ text: '코드 차이는 이 프로젝트 설정에서 허용하지 않아 보내지 않았습니다(설정 > 텔레그램 > 프로젝트별 소스 상세). 비밀값·고객 원문은 허용해도 보내지 않습니다.' });
    const diff = await this.d.svc.commitDiff(m.id, r.id).catch((e: Error) => `차이를 읽지 못함: ${e.message}`);
    return this.send({ text: `<pre>${esc(cut(diff, 3500))}</pre>` });
  }

  // ───── 조회(저장된 상태만 읽음, Claude 호출 없음) ─────
  private allMissions(): Mission[] { return this.d.svc.store.listProjects().flatMap((p) => this.d.svc.missions.list(p.id)); }
  private setTarget(missionId: string) { const m = this.d.svc.missions.get(missionId); this.save({ target: { projectId: m.projectId, missionId } }); }
  /** 조작 대상: 고른 미션 → 하나뿐인 진행 중 미션 → 하나뿐인 열린 미션. 여럿이면 null(다른 미션에 지시가 들어가지 않게) */
  target(): Mission | null {
    const t = this.s().target; if (t) { try { return this.d.svc.missions.get(t.missionId); } catch { /* 지워짐 */ } }
    const ms = this.allMissions().filter((m) => this.wants(m));
    const live = ms.filter((m) => ['planning', 'running', 'evaluating'].includes(m.status)); if (live.length === 1) return live[0];
    const open = ms.filter((m) => ['waiting_user', 'done'].includes(m.status)); if (!live.length && open.length === 1) return open[0];
    return null;
  }
  private projectOf(id: string): Project | null { try { return this.d.svc.store.getProject(id); } catch { return null; } }
  private head(m: Mission | null): string { return m ? this.headIds(m.projectId, m.id) : '🎯 대상 미션 없음(/projects)'; }
  private headIds(projectId: string, missionId: string): string {
    const p = this.projectOf(projectId); let title = '미션'; try { title = firstLine(this.d.svc.missions.get(missionId).prompt).slice(0, 40); } catch { /* 없음 */ }
    return `📁 ${esc(p?.plan.name ?? '프로젝트')} · 🎯 ${esc(title)}`;
  }
  private stateLine(m: Mission): string {
    if (m.paused) return '⏸ 일시정지(진행 중 단계만 마저 끝냄)';
    if (m.limitWait || m.limitUntil) return `⏳ ${m.limitWait?.source === 'pace' ? '사용량 속도 조절(주간 한도 나눠 쓰기)' : m.limitWait?.reason.includes('장애') ? '연결 장애 대기' : 'Claude 한도 대기'} — 다음 확인 ${hhmm(m.limitUntil ?? m.limitWait?.nextAt)}${m.limitWait && !m.limitWait.resetKnown ? '(해제 시각을 알 수 없어 1시간마다 확인)' : ''}`;
    return `${STATUS_KO[m.status] ?? m.status}${['planning', 'running', 'evaluating'].includes(m.status) ? ` · 사이클 ${m.cycle}` : ''}`;
  }
  private menu() {
    return this.send({ text: `CREWGENAI 메뉴\n${this.head(this.target())}\n명령을 외우지 않아도 아래 버튼으로 쓸 수 있습니다. 일반 문장을 보내면 대상 미션의 다음 지시로 접수합니다.`, rows: [
      [{ text: '📊 진행 상황', cb: { a: 'cmd', c: 'status' } }, { text: '🧩 업무', cb: { a: 'cmd', c: 'tasks' } }],
      [{ text: '📋 확인할 것', cb: { a: 'cmd', c: 'pending' } }, { text: '📝 커밋 승인', cb: { a: 'cmd', c: 'commits' } }],
      [{ text: '🧪 결과물', cb: { a: 'cmd', c: 'results' } }, { text: '📈 사용량', cb: { a: 'cmd', c: 'usage' } }],
      [{ text: '🩺 연결 상태', cb: { a: 'cmd', c: 'health' } }, { text: '📁 프로젝트·미션', cb: { a: 'cmd', c: 'projects' } }],
    ] });
  }
  private missionButtons(extra: object): Btn[][] {
    return this.allMissions().filter((m) => !['stopped', 'failed'].includes(m.status) && this.wants(m)).slice(0, 8).map((m) => [{ text: `${cut(this.projectOf(m.projectId)?.plan.name ?? '', 14)} · ${cut(firstLine(m.prompt), 24)} (${STATUS_KO[m.status]})`, cb: { ...extra, m: m.id } }]);
  }
  private projects() {
    const rows = this.missionButtons({ a: 'tgt' });
    const t = this.target();
    return this.send({ text: `대상 미션을 고르세요.${t ? `\n지금: ${this.head(t)}` : ''}${rows.length ? '' : '\n열려 있는 미션이 없습니다.'}`, rows });
  }
  private ctlRows(m: Mission | null): Btn[][] {
    if (!m || ['stopped', 'failed'].includes(m.status)) return [];
    return [[m.paused ? { text: '▶️ 재개', cb: { a: 'mc', m: m.id, x: 'resume' } } : { text: '⏸ 일시정지', cb: { a: 'mc', m: m.id, x: 'pause' } }, { text: '⏹ 중단', cb: { a: 'mc', m: m.id, x: 'stop' } }], [{ text: '📋 확인할 것', cb: { a: 'cmd', c: 'pending' } }, { text: '🧪 결과물', cb: { a: 'cmd', c: 'results', m: m.id } }]];
  }
  statusText(m: Mission | null): string {
    if (!m) return '대상 미션이 없습니다. /projects 에서 고르세요.';
    const ev = this.d.svc.missions.events(m.id);
    const lastPlan = [...ev].reverse().find((e) => e.kind === 'operator_plan');
    const done = (m.results ?? []).filter((r) => r.status && r.status !== 'implemented').slice(0, 4);
    const running = this.runningNodes(m);
    const held = [...(m.denials ?? []).map((d) => `권한: ${d.agent} — ${cut(d.target, 80)}`), ...(m.blockers ?? []).map((b) => `${b.step}: ${cut(b.reason, 100)}`)].slice(0, 4);
    const pend = this.pending(m.id);
    return [this.head(m), `상태: ${this.stateLine(m)}`,
      `지금 만드는 것: ${esc(cut(firstLine(m.checkpoint?.title || m.summary || m.prompt), 200))}`,
      done.length ? `확인 가능한 결과:\n${done.map((r) => `· [${RESULT_STATUS_LABEL[r.status!]}] ${esc(cut(r.title, 100))}${r.demo ? ' (시연 있음)' : ''}`).join('\n')}` : '확인 가능한 결과: 아직 없음',
      running.length ? `진행 중: ${esc(running.join(', '))}` : '',
      held.length ? `막힌 업무:\n${held.map((h) => `· ${esc(h)}`).join('\n')}` : '막힌 업무: 없음',
      pend.length ? `내가 정할 것: ${pend.length}건(미션을 멈춘 것 ${pend.filter((x) => x.urgent).length}건) /pending` : '내가 정할 것: 없음',
      lastPlan ? `다음(최근 계획): ${esc(cut(firstLine(lastPlan.text.replace(/^사이클 \d+ 계획:\s*/, '')), 200))}` : '',
      `갱신: ${hhmm(m.updatedAt)}`].filter(Boolean).join('\n');
  }
  private runningNodes(m: Mission): string[] {
    if (!m.currentRunId) return [];
    try { const d = this.d.svc.engine.detail(m.currentRunId); return d.nodes.filter((n) => ['running', 'checking', 'rework'].includes(n.status)).map((n) => d.graph.nodes.find((g) => g.id === n.nodeId)?.label ?? '작업').slice(0, 5); } catch { return []; }
  }
  private tasksText(m: Mission | null): string {
    if (!m) return '대상 미션이 없습니다. /projects';
    const out = [this.head(m), `상태: ${this.stateLine(m)}`];
    if (m.currentRunId) {
      try {
        const d = this.d.svc.engine.detail(m.currentRunId); const label = (id: string) => d.graph.nodes.find((g) => g.id === id)?.label ?? '작업';
        const kinds = new Map(d.graph.nodes.map((g) => [g.id, g.kind]));
        const by = (sts: string[]) => d.nodes.filter((n) => sts.includes(n.status) && kinds.get(n.nodeId) === 'agent').map((n) => `· ${esc(cut(label(n.nodeId), 80))}${n.failureReason ? ` — ${esc(cut(n.failureReason, 120))}` : ''}`);
        const r = by(['running', 'checking', 'rework']); const w = by(['waiting', 'queued']); const f = by(['failed', 'needs_resume']); const ok = by(['succeeded']);
        out.push(`사이클 ${m.cycle} 업무`, r.length ? `진행 중:\n${r.join('\n')}` : '', w.length ? `대기:\n${w.join('\n')}` : '', f.length ? `실패·재개 대기:\n${f.join('\n')}` : '', ok.length ? `끝남 ${ok.length}건` : '');
      } catch { /* 실행 기록 없음 */ }
    }
    const held = [...(m.denials ?? []).map((d) => `· [권한 보류] ${esc(d.agent)} — ${esc(cut(d.target, 100))}`), ...(m.blockers ?? []).map((b) => `· [${b.kind === 'environment' ? '환경' : '같은 실패 반복'}] ${esc(cut(b.step, 60))} — ${esc(cut(b.reason, 120))}`), ...(m.gaps ?? []).map((g) => `· [결정 대기] ${esc(cut(g.issue, 120))}`)];
    out.push(held.length ? `보류(이유):\n${held.slice(0, 10).join('\n')}` : '보류: 없음');
    return out.filter(Boolean).join('\n');
  }
  private usageText(m: Mission | null): string {
    if (!m) return '대상 미션이 없습니다. /projects';
    const u = m.usage;
    const lim = m.limitWait ? `${m.limitWait.source === 'pace' ? '속도 조절' : '한도 대기'}: ${esc(m.limitWait.reason)}\n해제 시각: ${m.limitWait.resetKnown ? hhmm(m.limitWait.nextAt) : '알 수 없음(1시간마다 한 번 다시 확인)'}\n다음 확인: ${hhmm(m.limitUntil ?? m.limitWait.nextAt)}\n마지막 확인: ${m.limitWait.lastAt ? `${hhmm(m.limitWait.lastAt)} · ${esc(m.limitWait.lastResult ?? '')}` : '아직 없음'}\n재개할 작업: ${esc(m.limitWait.target)}` : '한도 대기: 없음(확인된 한도 정보 없음)';
    let pace = '';
    try { const pv = this.d.svc.usagePace(); pace = `계정 사용률(Claude CLI 보고): ${pv.sevenDay ? `주간 ${Math.round(pv.sevenDay.utilization * 100)}% · 초기화 ${hhmm(pv.sevenDay.resetsAt)}` : '주간 미보고'}${pv.fiveHour ? ` / 5시간 ${Math.round(pv.fiveHour.utilization * 100)}%` : ''}\n속도 조절: ${pv.enabled ? esc(pv.text) : '꺼짐'}`; } catch { pace = ''; }
    return [this.head(m), pace, u && u.calls ? `CLI 호출 ${u.calls}회(사용량 보고 ${u.reported}회${u.calls > u.reported ? `, 미보고 ${u.calls - u.reported}회는 알 수 없음` : ''})\n토큰 입력 ${u.inputTokens.toLocaleString()} · 출력 ${u.outputTokens.toLocaleString()} · 캐시 ${(u.cacheReadTokens + u.cacheWriteTokens).toLocaleString()}\nCLI 보고 금액 $${u.costUsd.toFixed(2)}(구독 로그인이면 API 환산 추정값, 청구액 아님)` : '사용량 기록 없음', lim].filter(Boolean).join('\n');
  }
  private async healthText(): Promise<string> {
    const svc = this.d.svc; const cli = await svc.cliStatus(false).catch(() => null); const cx = await svc.codexStatus(false).catch(() => null);
    const t = this.target();
    let demo = '';
    if (t) { try { const info = await svc.demoInfo(t.projectId); demo = info.services.map((s) => `· ${esc(s.service.name)}: ${s.status === 'running' ? '실행 중' : s.status === 'needs_approval' ? '실행 승인 필요(앱에서)' : s.status === 'starting' ? '시작 중' : '꺼짐'}${s.url ? ` (컴퓨터에서 ${esc(s.url)})` : ''}`).join('\n'); } catch { demo = '· 시연 목록 없음'; } }
    return [`🩺 연결 상태(${new Date(this.now()).toLocaleString('ko-KR')})`, '앱: 실행 중(앱을 완전히 종료하거나 컴퓨터가 꺼지면 텔레그램 명령을 처리하지 못합니다)', `Claude CLI: ${cli?.ready ? `준비됨 ${cli.version ?? ''}` : `준비 안 됨${cli?.problem ? ` — ${esc(cli.problem)}` : ''}`}`, `Codex: ${cx?.ready ? `준비됨 ${cx.version ?? ''}` : '준비 안 됨'}`, `텔레그램: 연결됨(마지막 통신 ${hhmm(this.lastOkAt)})`, t ? `시연 서버 · ${this.head(t)}\n${demo}` : ''].filter(Boolean).join('\n');
  }
  private async resultsList(m: Mission | null) {
    if (!m) return this.send({ text: '대상 미션이 없습니다. /projects' });
    const rs = m.results ?? [];
    if (!rs.length) return this.send({ text: `${this.head(m)}\n아직 결과물이 없습니다.` });
    let info: Awaited<ReturnType<Service['demoInfo']>> | null = null; try { info = await this.d.svc.demoInfo(m.projectId); } catch { info = null; }
    const allowed = this.s().preview[m.projectId] ?? [];
    await this.send({ text: `${this.head(m)}\n🧪 결과물 ${rs.length}건(사이클 ${m.resultsCycle ?? m.cycle} 판단 기준)\n시연 주소는 이 컴퓨터의 브라우저에서 여는 주소입니다(휴대폰에서는 열리지 않음).` });
    for (const [i, r] of rs.slice(0, 8).entries()) {
      const svcSt = r.demo ? info?.services.find((s) => s.service.id === r.demo!.service) : undefined;
      const kind = r.demo ? (svcSt?.service.kind === 'api' || r.demo.api ? 'API' : svcSt?.service.kind === 'admin' ? '관리 화면' : svcSt?.service.kind === 'app' ? '앱' : '웹') : '문서·파일';
      const url = r.demo && svcSt?.url ? `${svcSt.url}${r.demo.path || '/'}` : r.kind === 'url' ? r.path : null;
      const lines = [`<b>${esc(cut(r.title, 120))}</b> · ${kind} · ${RESULT_STATUS_LABEL[r.status ?? 'implemented']}`,
        r.changed ? `무엇: ${esc(cut(r.changed, 300))}` : '', r.demo?.steps || r.check ? `확인할 것: ${esc(cut(r.demo?.steps || r.check, 400))}` : '', r.demo?.expected ? `예상 결과: ${esc(cut(r.demo.expected, 200))}` : '',
        `실행·검증: ${esc(cut(r.verified || '기록 없음(미검증으로 봄)', 300))}`,
        r.demo ? `시연: ${svcSt ? (svcSt.status === 'running' ? '실행 중' : svcSt.status === 'needs_approval' ? '실행 승인 필요(앱에서)' : '꺼짐(앱에서 켜기)') : '시연 목록에 없음'}${url ? ` · 컴퓨터에서 여는 주소: ${esc(url)}` : ''}` : r.kind === 'file' ? `파일: ${esc(r.relPath)}(앱에서 열기)` : '',
        r.demo ? `데이터: ${r.demo.data === 'api+db' ? '실제 API·DB 연결' : r.demo.data === 'screen-only' ? '화면만(데이터 미연결)' : '예시·대체 데이터'}` : '', r.remaining ? `남은 문제: ${esc(cut(r.remaining, 200))}` : '',
        '이 메시지에 답장하면 이 결과물에 대한 피드백으로 저장해 다음 작업에 반영합니다.'].filter(Boolean);
      const rows: Btn[][] = r.demo && allowed.includes(r.demo.service) && url ? [[{ text: '📷 화면 미리보기', cb: { a: 'pv', m: m.id, i: String(i) } }]] : [];
      await this.send({ text: lines.join('\n'), rows, kind: 'result', ref: { m: m.id, title: cut(r.title, 80) } });
    }
    if (m.checkpoint) await this.send({ text: '검토 카드가 열려 있습니다.', rows: [[{ text: '검토 카드 보기', cb: { a: 'cp', m: m.id } }]] });
  }
  private async preview(missionId: string, i: number) {
    const m = this.d.svc.missions.get(missionId); const r = (m.results ?? [])[i];
    if (!r?.demo) return this.send({ text: '미리보기할 시연이 없습니다.' });
    if (!(this.s().preview[m.projectId] ?? []).includes(r.demo.service)) return this.send({ text: '이 시연 화면은 프로젝트 설정에서 미리보기 전송을 허용하지 않았습니다.' });
    if (!this.d.capture) return this.send({ text: '이 실행 환경에서는 화면 미리보기를 지원하지 않습니다.' });
    const st = (await this.d.svc.demoInfo(m.projectId)).services.find((s) => s.service.id === r.demo!.service);
    if (!st?.url || st.status !== 'running') return this.send({ text: '시연 서버가 꺼져 있어 화면을 찍지 못했습니다. 앱에서 켠 뒤 다시 누르세요.' });
    const url = `${st.url}${r.demo.path || '/'}`;
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) return this.send({ text: '이 컴퓨터 안의 시연 주소만 찍습니다.' });
    const png = await this.d.capture(url);
    const fd = new FormData(); fd.set('chat_id', String(this.s().link!.chatId)); fd.set('caption', `${r.title} · 화면 미리보기(${new Date(this.now()).toLocaleTimeString('ko-KR')})`.slice(0, 1000)); fd.set('photo', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'preview.png');
    await this.call('sendPhoto', {}, 60, fd);
  }
}
type CommitAct = 'detail' | 'approve' | 'changes' | 'hold' | 'decline';
interface TgUser { id: number; first_name?: string; last_name?: string; username?: string }
interface TgChat { id: number; type: string }
interface TgMessage { message_id: number; date: number; chat: TgChat; from?: TgUser; text?: string; reply_to_message?: { message_id: number } }
interface TgCallback { id: string; from?: TgUser; data?: string; message?: { message_id: number; date: number; chat: TgChat } }
interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallback }

function splitText(t: string, n: number): string[] {
  if (t.length <= n) return [t];
  const out: string[] = []; let cur = '';
  for (const line of t.split('\n')) { if ((cur + line).length + 1 > n && cur) { out.push(cur); cur = ''; } cur += (cur ? '\n' : '') + line.slice(0, n); }
  if (cur) out.push(cur);
  return out;
}
