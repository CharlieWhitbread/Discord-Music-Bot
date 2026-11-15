'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const ffmpegPath = require('ffmpeg-static');

/**
 * Generate small audio/video fixtures with the bundled ffmpeg.
 * @returns {Record<string, string>} name → file path
 */
function makeFixtures(dir) {
  const out = {};
  const gen = (name, args) => {
    const file = path.join(dir, name);
    const r = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args, '-y', file]);
    if (r.status !== 0) throw new Error(`fixture ${name} failed: ${r.stderr}`);
    out[name] = file;
  };
  gen('tone.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ar', '22050', '-ac', '1']);
  // 31 s at 8 kHz mono stays ~0.5 MB but is over the 30 s cap.
  gen('long.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=31', '-ar', '8000', '-ac', '1']);
  gen('tone.ogg', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libopus']);
  gen('silent-video.mp4', ['-f', 'lavfi', '-i', 'color=c=black:s=32x32:d=1', '-an', '-c:v', 'mpeg4']);

  out['notes.txt'] = path.join(dir, 'notes.txt');
  fs.writeFileSync(out['notes.txt'], 'definitely not audio\n'.repeat(50));
  out['empty.wav'] = path.join(dir, 'empty.wav');
  fs.writeFileSync(out['empty.wav'], '');
  // Starts like a WAV, then garbage.
  out['fake.wav'] = path.join(dir, 'fake.wav');
  fs.writeFileSync(out['fake.wav'], Buffer.concat([Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt '), Buffer.alloc(200, 0xff)]));
  return out;
}

/**
 * An HLS playlist pointing at a local HTTP server, to prove ffprobe never
 * follows uploaded playlists onto the network (SSRF).
 * @returns {Promise<{file: string, hits: string[], close: () => void}>}
 */
function makeHlsProbe(dir) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    res.end('x');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const file = path.join(dir, 'playlist.m3u8');
      fs.writeFileSync(file, [
        '#EXTM3U', '#EXT-X-TARGETDURATION:10', '#EXTINF:10,',
        `http://127.0.0.1:${port}/internal-admin`, '#EXT-X-ENDLIST', '',
      ].join('\n'));
      resolve({ file, hits, close: () => server.close() });
    });
  });
}

module.exports = { makeFixtures, makeHlsProbe };
