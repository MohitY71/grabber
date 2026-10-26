// Packages the app from an isolated staging folder.
// Running electron-builder directly inside an npm workspace makes it prune the shared node_modules,
// so we stage only what ships (bundled dist/, icons, ffmpeg) and build there.
// Usage: node scripts/package.mjs [--dir] [--mac|--win|--linux]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(here, '..');
const root = path.join(app, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
const run = (cmd, args, cwd) => { const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY ?? 'false' } }); if (r.status !== 0) process.exit(r.status ?? 1); };

run('node', ['build.mjs'], app);

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'grabber-stage-'));
fs.cpSync(path.join(app, 'dist'), path.join(stage, 'dist'), { recursive: true, filter: (s) => !/selftest\.cjs|\.map$/.test(s) });
fs.mkdirSync(path.join(stage, 'build'));
for (const f of fs.readdirSync(path.join(app, 'build'))) if (/^icon\.(png|icns|ico)$/.test(f)) fs.copyFileSync(path.join(app, 'build', f), path.join(stage, 'build', f));
// ffmpeg ships inside the app (used to merge HLS audio/video and convert to MP4).
fs.cpSync(path.join(root, 'node_modules', 'ffmpeg-static'), path.join(stage, 'node_modules', 'ffmpeg-static'), { recursive: true });
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
  name: 'grabber', productName: pkg.productName, version: pkg.version, description: pkg.description,
  author: pkg.author, main: 'dist/main.cjs', dependencies: { 'ffmpeg-static': pkg.dependencies['ffmpeg-static'] }, build: pkg.build,
}, null, 2));

const builder = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
const flags = process.argv.slice(2);
run('node', [builder, ...(flags.length ? flags : [])], stage);

const out = path.join(app, 'release');
fs.rmSync(out, { recursive: true, force: true });
// Plain fs.cpSync rewrites macOS framework symlinks to absolute paths into the (about to be deleted) stage; cp -R keeps them.
if (process.platform === 'win32') fs.cpSync(path.join(stage, 'release'), out, { recursive: true });
else run('cp', ['-R', path.join(stage, 'release'), out], app);
fs.rmSync(stage, { recursive: true, force: true });
console.log(`\nPackaged into ${out}`);
