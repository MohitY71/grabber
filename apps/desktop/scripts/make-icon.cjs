// Renders assets/icon.svg to PNG sizes (and a macOS .icns) using Electron itself - no extra tooling.
// Usage: electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const root = path.join(__dirname, '..');
  const svg = fs.readFileSync(path.join(root, 'assets', 'icon.svg'), 'utf8');
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const buildDir = path.join(root, 'build');
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, 'icon.png'), img.toPNG());
  fs.mkdirSync(path.join(root, 'src', 'renderer'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'renderer', 'icon.png'), img.resize({ width: 256, height: 256, quality: 'best' }).toPNG());
  if (process.platform === 'darwin') {
    const set = path.join(buildDir, 'icon.iconset');
    fs.rmSync(set, { recursive: true, force: true });
    fs.mkdirSync(set);
    for (const s of [16, 32, 64, 128, 256, 512]) {
      fs.writeFileSync(path.join(set, `icon_${s}x${s}.png`), img.resize({ width: s, height: s, quality: 'best' }).toPNG());
      fs.writeFileSync(path.join(set, `icon_${s}x${s}@2x.png`), img.resize({ width: s * 2, height: s * 2, quality: 'best' }).toPNG());
    }
    execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(buildDir, 'icon.icns')]);
    fs.rmSync(set, { recursive: true, force: true });
  }
  console.log('icons written');
  app.quit();
});
