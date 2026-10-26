// Bundles TypeScript sources for Electron: main/preload (CommonJS, Node) and the renderer (browser IIFE).
import { build, context } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const out = 'dist';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'renderer'), { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'node20', platform: 'node', format: 'cjs' };
const jobs = [
  { ...common, entryPoints: { main: 'src/main/main.ts' }, outdir: out, outExtension: { '.js': '.cjs' }, external: ['electron', 'ffmpeg-static', './selftest.cjs'] },
  { ...common, entryPoints: { preload: 'src/main/preload.ts' }, outdir: out, outExtension: { '.js': '.cjs' }, external: ['electron'] },
  { ...common, entryPoints: { selftest: 'src/main/selftest.ts' }, outdir: out, outExtension: { '.js': '.cjs' }, external: ['electron'] },
  { entryPoints: { app: 'src/renderer/app.ts' }, outdir: path.join(out, 'renderer'), bundle: true, sourcemap: true, target: 'chrome130', platform: 'browser', format: 'iife', logLevel: 'info' },
];
for (const f of ['index.html', 'styles.css', 'icon.png']) fs.copyFileSync(path.join('src/renderer', f), path.join(out, 'renderer', f));

if (watch) for (const j of jobs) await (await context(j)).watch();
else await Promise.all(jobs.map((j) => build(j)));
