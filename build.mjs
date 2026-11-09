// Bundles the renderer and compute worker into dist/.
import { build } from 'esbuild';
import fs from 'node:fs';

fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync('dist', { recursive: true });
const common = { bundle: true, format: 'iife', target: 'chrome128', minify: true, sourcemap: false, logLevel: 'warning', legalComments: 'none' };
await build({ ...common, entryPoints: ['src/renderer/app.js'], outfile: 'dist/app.js' });
await build({ ...common, entryPoints: ['src/renderer/worker.js'], outfile: 'dist/worker.js' });
fs.copyFileSync('src/renderer/index.html', 'dist/index.html');
fs.copyFileSync('src/renderer/styles.css', 'dist/styles.css');
for (const f of fs.readdirSync('dist')) console.log(f.padEnd(14), (fs.statSync(`dist/${f}`).size / 1024).toFixed(0), 'KB');
