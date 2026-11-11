// main·preload를 CommonJS 번들로 만든다. electron과 node 내장 모듈은 외부로 둔다.
import { build } from 'esbuild';
const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', sourcemap: true, external: ['electron'], logLevel: 'info' };
await build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js' });
await build({ ...common, entryPoints: ['src/main/preload.ts'], outfile: 'dist/main/preload.js' });
