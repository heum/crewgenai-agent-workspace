// 앱 아이콘 생성: SVG를 Electron 화면 밖 창에서 1024px PNG로 렌더링한다. 사용: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs'); const path = require('path');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f5bea"/><stop offset="1" stop-color="#1e3a8a"/></linearGradient></defs>
<rect x="64" y="64" width="896" height="896" rx="200" fill="url(#g)"/>
<g stroke="#c7d2fe" stroke-width="22" fill="none" stroke-linecap="round"><path d="M512 300 L330 520"/><path d="M512 300 L694 520"/><path d="M330 600 L512 760"/><path d="M694 600 L512 760"/></g>
<g fill="#ffffff"><circle cx="512" cy="270" r="78"/><circle cx="320" cy="560" r="70"/><circle cx="704" cy="560" r="70"/><rect x="432" y="720" width="160" height="110" rx="34"/></g>
<path d="M470 776 l30 30 l56 -60" stroke="#2f5bea" stroke-width="22" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  await w.loadURL('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
  await new Promise((r) => setTimeout(r, 500));
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.writeFileSync(out, img.resize({ width: 1024, height: 1024 }).toPNG());
  console.log('icon', out, img.getSize());
  app.quit();
});
