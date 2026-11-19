// main·preload를 CommonJS 번들로 만든다. electron과 node 내장 모듈은 외부로 둔다.
import { build } from 'esbuild';
const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', sourcemap: true, external: ['electron'], logLevel: 'info' };
await build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js' });
await build({ ...common, entryPoints: ['src/main/preload.ts'], outfile: 'dist/main/preload.js' });
// 앱의 '업데이트 내역' 탭: 저장소 루트의 CHANGELOG.md를 앱에 포함되는 문서 폴더로 복사한다(원본은 루트 하나만 관리)
import { copyFileSync, existsSync } from 'node:fs';
if (existsSync('../CHANGELOG.md')) copyFileSync('../CHANGELOG.md', 'resources/docs/CHANGELOG.md');
