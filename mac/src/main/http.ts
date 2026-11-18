// 앱 본체(메인 프로세스)용 HTTP 요청: Node 기본 http·https 모듈로 보낸다.
// 이 Electron의 내장 fetch(undici)는 일부 macOS에서 소켓 설정(setTypeOfService) 오류(EINVAL)로 요청이 실패하고 앱 오류 창을 띄운다.
// 그래서 텔레그램·시연 확인 요청은 fetch 대신 이 함수를 쓴다. 돌려주는 값은 표준 Response라 쓰는 쪽 코드는 fetch와 같다.
import http from 'node:http';
import https from 'node:https';

export type SafeInit = { method?: string; headers?: Record<string, string>; body?: string | FormData | null; signal?: AbortSignal | null; redirect?: 'manual' };
const MAX_BYTES = 20 * 1024 * 1024;

/** FormData → multipart 본문(텔레그램 사진 보내기용) */
async function multipart(fd: FormData): Promise<{ body: Buffer; type: string }> {
  const boundary = `----crewgenai${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const parts: Buffer[] = [];
  for (const [name, v] of fd.entries()) {
    const safeName = String(name).replace(/["\r\n]/g, '_');
    if (typeof v === 'string') parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${safeName}"\r\n\r\n${v}\r\n`));
    else {
      const file = v as File; const fname = String(file.name || 'file').replace(/["\r\n]/g, '_');
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${safeName}"; filename="${fname}"\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`));
      parts.push(Buffer.from(await file.arrayBuffer())); parts.push(Buffer.from('\r\n'));
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

/** fetch와 같은 모양(리디렉션은 따라가지 않음). 실패하면 fetch처럼 예외를 던진다. */
export async function safeFetch(input: string | URL, init: SafeInit = {}): Promise<Response> {
  const url = new URL(String(input));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`지원하지 않는 주소: ${url.protocol}`);
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let payload: Buffer | null = null;
  if (init.body instanceof FormData) { const m = await multipart(init.body); payload = m.body; headers['content-type'] = m.type; }
  else if (typeof init.body === 'string') payload = Buffer.from(init.body);
  if (payload) headers['content-length'] = String(payload.length);
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise<Response>((resolve, reject) => {
    if (init.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); return; }
    const req = mod.request(url, { method: init.method ?? 'GET', headers }, (res) => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BYTES) { req.destroy(new Error('응답이 너무 큽니다.')); return; } chunks.push(c); });
      res.on('end', () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) { if (Array.isArray(v)) for (const x of v) h.append(k, x); else if (v !== undefined) h.set(k, String(v)); }
        const status = res.statusCode ?? 0;
        // 표준 Response는 200–599만 받는다(그 밖은 오류로 본다)
        if (status < 200 || status > 599) { reject(new Error(`잘못된 응답 상태: ${status}`)); return; }
        const body = [101, 204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
        resolve(new Response(body, { status, headers: h }));
      });
      res.on('error', reject);
    });
    const onAbort = () => { const e = new Error('aborted'); e.name = 'AbortError'; req.destroy(e); };
    init.signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (e) => { init.signal?.removeEventListener('abort', onAbort); reject(e); });
    req.on('close', () => init.signal?.removeEventListener('abort', onAbort));
    if (payload) req.write(payload);
    req.end();
  });
}
