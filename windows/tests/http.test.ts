// 앱 본체 HTTP 요청(safeFetch): 내장 fetch 대신 Node http로 보내고, 응답·쿠키·multipart·중단을 fetch와 같게 다룬다
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { safeFetch } from '../src/main/http';

describe('safeFetch', () => {
  it('JSON·상태·쿠키·리디렉션 미추적·multipart·중단', async () => {
    const seen: { ct?: string; body?: string } = {};
    const srv = createServer((req, res) => {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
        if (req.url === '/redir') { res.writeHead(302, { location: '/x' }); res.end(); return; }
        if (req.url === '/slow') { setTimeout(() => res.end('late'), 2000); return; }
        seen.ct = req.headers['content-type']; seen.body = b;
        res.setHeader('set-cookie', ['a=1; Path=/', 'b=2']); res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, got: b.length }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    const r = await safeFetch(`http://127.0.0.1:${port}/j`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"x":1}' });
    expect(r.status).toBe(201); expect(await r.json()).toEqual({ ok: true, got: 7 }); expect(r.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2']);
    expect((await safeFetch(`http://127.0.0.1:${port}/redir`)).status).toBe(302);
    const fd = new FormData(); fd.set('chat_id', '5'); fd.set('photo', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'p.png');
    await safeFetch(`http://127.0.0.1:${port}/m`, { method: 'POST', body: fd });
    expect(seen.ct).toMatch(/^multipart\/form-data; boundary=/); expect(seen.body).toContain('name="chat_id"'); expect(seen.body).toContain('filename="p.png"');
    await expect(safeFetch(`http://127.0.0.1:${port}/slow`, { signal: AbortSignal.timeout(100) })).rejects.toThrow();
    srv.close();
  });
});
