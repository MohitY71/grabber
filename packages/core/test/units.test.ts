import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaylist, planParts, parseProgressLine, formatArgs, friendlyYtdlpError, ytdlpAsset } from '../src/index.ts';

test('planParts covers the file exactly with no gaps or overlaps', () => {
  for (const [size, threads] of [[10_000_000, 8], [1_000_001, 16], [100, 8], [5_000_000, 1]] as const) {
    const parts = planParts(size, threads);
    assert.equal(parts[0]!.start, 0);
    assert.equal(parts.at(-1)!.end, size - 1);
    for (let i = 1; i < parts.length; i++) assert.equal(parts[i]!.start, parts[i - 1]!.end + 1);
  }
});

test('HLS parser: master variants sorted best-first, byte ranges, keys and maps', () => {
  const master = parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900,RESOLUTION=1920x1080\nhi.m3u8\n', 'https://h/x/master.m3u8');
  assert.equal(master.type, 'master');
  if (master.type === 'master') { assert.equal(master.variants[0]!.height, 1080); assert.equal(master.variants[0]!.url, 'https://h/x/hi.m3u8'); }
  const media = parsePlaylist('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-KEY:METHOD=AES-128,URI="k.bin",IV=0x01\n#EXTINF:2,\n#EXT-X-BYTERANGE:100@0\ns.mp4\n#EXTINF:2,\n#EXT-X-BYTERANGE:50\ns.mp4\n#EXT-X-ENDLIST\n', 'https://h/p/m.m3u8');
  assert.equal(media.type, 'media');
  if (media.type === 'media') {
    assert.equal(media.endList, true);
    assert.deepEqual(media.segments[0]!.range, { start: 0, end: 99 });
    assert.deepEqual(media.segments[1]!.range, { start: 100, end: 149 });
    assert.equal(media.segments[0]!.key?.uri, 'https://h/p/k.bin');
    assert.equal(media.segments[0]!.map?.url, 'https://h/p/init.mp4');
  }
  assert.throws(() => parsePlaylist('<html>', 'https://h/'), /Not an HLS/);
});

test('yt-dlp progress lines and format selection', () => {
  assert.deepEqual(parseProgressLine('GRB|1000|4000|NA|250.5|12'), { downloaded: 1000, total: 4000, speed: 250.5, eta: 12 });
  assert.deepEqual(parseProgressLine('GRB|1000|NA|5000|NA|NA'), { downloaded: 1000, total: 5000, speed: 0, eta: null });
  assert.equal(parseProgressLine('[download] 10%'), null);
  assert.ok(formatArgs('best').join(' ').includes('res,vcodec:h264'));
  assert.ok(formatArgs('1080').join(' ').includes('res:1080'));
  assert.ok(formatArgs('audio').includes('mp3'));
  assert.ok(formatArgs('worst').join(' ').includes('wv*+wa/w'));
});

test('yt-dlp errors become actionable messages', () => {
  assert.match(friendlyYtdlpError('ERROR: [youtube] x: This video is DRM protected'), /DRM-protected/);
  assert.match(friendlyYtdlpError('ERROR: Unsupported URL: https://x'), /Browser tab/);
  assert.match(friendlyYtdlpError('ERROR: [youtube] x: Sign in to confirm your age'), /signed in/);
  assert.match(friendlyYtdlpError('ERROR: [youtube] x: Video unavailable'), /not available/);
  assert.equal(ytdlpAsset('win32', 'x64'), 'yt-dlp.exe');
  assert.equal(ytdlpAsset('darwin', 'arm64'), 'yt-dlp_macos');
  assert.equal(ytdlpAsset('linux', 'arm64'), 'yt-dlp_linux_aarch64');
});
