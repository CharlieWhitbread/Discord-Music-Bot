/**
 * Client-side audio extraction for video uploads.
 *
 * Videos are decoded in the browser and only the trimmed audio region is
 * uploaded (as WAV), so a large phone video never travels over the tunnel.
 */

const TARGET_SAMPLE_RATE = 48000;

export async function decodeAudio(file: File): Promise<AudioBuffer> {
  const ctx = new AudioContext();
  try {
    return await ctx.decodeAudioData(await file.arrayBuffer());
  } finally {
    void ctx.close();
  }
}

/** Downsampled |peak| values for waveform rendering without re-decoding. */
export function makePeaks(buffer: AudioBuffer, points = 4000): number[] {
  const data = buffer.getChannelData(0);
  const blockSize = Math.max(1, Math.floor(data.length / points));
  const peaks: number[] = [];
  for (let i = 0; i < data.length; i += blockSize) {
    let max = 0;
    const end = Math.min(i + blockSize, data.length);
    for (let j = i; j < end; j++) {
      const v = Math.abs(data[j]);
      if (v > max) max = v;
    }
    peaks.push(max);
  }
  return peaks;
}

/** Render [start, end] of the buffer to a 48 kHz stereo 16-bit WAV blob. */
export async function renderWav(buffer: AudioBuffer, start: number, end: number): Promise<Blob> {
  const length = Math.ceil((end - start) * TARGET_SAMPLE_RATE);
  const ctx = new OfflineAudioContext(2, length, TARGET_SAMPLE_RATE);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start(0, start, end - start);
  const rendered = await ctx.startRendering();
  return encodeWav(rendered);
}

function encodeWav(buffer: AudioBuffer): Blob {
  const numChannels = 2;
  const bytesPerSample = 2;
  const frames = buffer.length;
  const dataSize = frames * numChannels * bytesPerSample;
  const view = new DataView(new ArrayBuffer(44 + dataSize));

  const writeString = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (const sample of [left[i], right[i]]) {
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}
