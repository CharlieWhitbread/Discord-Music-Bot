'use strict';

/**
 * transcode — ffmpeg/ffprobe wrappers for upload processing.
 *
 * Pipeline per upload (queued serially — transcodes spike the Pi's CPU):
 *   1. ffprobe validates the container really is audio and reads duration.
 *   2. ffmpeg trims (-ss/-to as output options for accuracy), loudness-
 *      normalises (loudnorm) and writes canonical raw s16le/48kHz/stereo PCM.
 *   3. ffmpeg encodes a small OGG/Opus preview FROM the PCM so the preview
 *      is bit-identical in loudness to what plays in Discord.
 */

const { spawn } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

// Bytes per second of s16le / 48 kHz / stereo.
const PCM_BYTES_PER_SECOND = 48000 * 2 * 2;

/** Serialise CPU-heavy work. */
let queue = Promise.resolve();

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${bin} exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

/**
 * @param {string} file
 * @returns {Promise<{durationSeconds: number}>} rejects if not decodable audio.
 */
async function probe(file) {
  const stdout = await run(ffprobePath, [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_type:format=duration',
    '-of', 'json',
    file,
  ]);
  const info = JSON.parse(stdout);
  const hasAudio = info.streams?.some((s) => s.codec_type === 'audio');
  const durationSeconds = Number.parseFloat(info.format?.duration ?? 'NaN');
  if (!hasAudio || !Number.isFinite(durationSeconds)) {
    throw new Error('File contains no decodable audio stream');
  }
  return { durationSeconds };
}

/**
 * Trim + normalise + transcode an upload. Queued serially.
 * @param {object} opts
 * @param {string} opts.input     uploaded file path
 * @param {number} opts.start     trim start (seconds)
 * @param {number} opts.end       trim end (seconds)
 * @param {string} opts.outPcm    output .pcm path
 * @param {string} opts.outOgg    output .ogg path
 * @returns {Promise<{durationMs: number}>}
 */
function transcode({ input, start, end, outPcm, outOgg }) {
  const job = queue.then(async () => {
    await run(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', input,
      '-ss', String(start),
      '-to', String(end),
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
      '-f', 's16le', '-ar', '48000', '-ac', '2',
      '-y', outPcm,
    ]);

    await run(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 's16le', '-ar', '48000', '-ac', '2',
      '-i', outPcm,
      '-c:a', 'libopus', '-b:a', '96k',
      '-y', outOgg,
    ]);

    const { size } = require('node:fs').statSync(outPcm);
    return { durationMs: Math.round((size / PCM_BYTES_PER_SECOND) * 1000) };
  });
  // Keep the queue alive even if this job fails.
  queue = job.catch(() => {});
  return job;
}

module.exports = { probe, transcode, PCM_BYTES_PER_SECOND };
