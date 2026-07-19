// Transpile src/main + src/preload + src/shared + src/*.ts to CommonJS .js via
// tsc (no bundling). Electron 33's main must be CJS (its ESM main can't load
// Electron's built-in `electron` module); the ESM-only Agent SDK is loaded via
// dynamic import() inside session.ts. rewriteRelativeImportExtensions turns
// ./x.ts specifiers into ./x.js.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const r = spawnSync('npx', ['tsc', '-p', 'tsconfig.main.json'], { stdio: 'inherit' });
if (r.status) process.exit(r.status);

// The root package.json is "type": "module"; mark dist as CommonJS so Node
// treats the emitted .js as CJS.
mkdirSync('dist', { recursive: true });
writeFileSync('dist/package.json', JSON.stringify({ type: 'commonjs' }) + '\n');
console.log('main built to dist/**/*.js (CommonJS)');
