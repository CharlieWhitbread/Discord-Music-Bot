import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin, { type Region } from 'wavesurfer.js/dist/plugins/regions.esm.js';
import { api } from '../api';
import { decodeAudio, makePeaks, renderWav } from '../audioExtract';

const MAX_CLIP_SECONDS = 30;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
// Videos never leave the phone (audio is extracted locally), so the cap only
// guards browser memory during decode.
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
// When the browser can't decode the container (iOS .mov), the whole video is
// uploaded instead and the server extracts the audio. Must match the server cap.
const MAX_FALLBACK_BYTES = 100 * 1024 * 1024;

function isVideo(f: File): boolean {
  return f.type.startsWith('video/') || /\.(mov|mp4|m4v|webm)$/i.test(f.name);
}

export default function UploadModal({
  onClose,
  onUploaded,
}: {
  onClose: () => void;
  onUploaded: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [fallback, setFallback] = useState(false);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('');
  const [tags, setTags] = useState('');
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const waveRef = useRef<HTMLDivElement>(null);
  const surferRef = useRef<WaveSurfer | null>(null);
  const regionRef = useRef<Region | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopFnRef = useRef<(() => void) | null>(null);

  const stopPreview = () => {
    stopFnRef.current?.();
    stopFnRef.current = null;
    setPreviewing(false);
  };

  /* Zoom the waveform so the selected region fills most of the view,
     making fine scrubbing on long files practical. */
  const zoomToRegion = (region: Region) => {
    const surfer = surferRef.current;
    const container = waveRef.current;
    if (!surfer || !container) return;
    const total = surfer.getDuration();
    const len = region.end - region.start;
    const pad = Math.max(len * 0.3, 0.5);
    const viewLen = Math.min(total, len + pad * 2);
    if (viewLen >= total * 0.95) return; // selection ~fills the file already
    surfer.zoom(container.clientWidth / viewLen);
    surfer.setScrollTime(Math.max(0, region.start - pad));
    setZoomed(true);
  };

  const zoomOut = () => {
    const surfer = surferRef.current;
    const container = waveRef.current;
    if (!surfer || !container) return;
    surfer.zoom(container.clientWidth / surfer.getDuration());
    surfer.setScrollTime(0);
    setZoomed(false);
  };

  /* Build the waveform + trim region when a file is chosen. Video files are
     rendered from locally-decoded peaks; audio files decode from the blob URL. */
  useEffect(() => {
    if (!file || !waveRef.current) return;
    if (isVideo(file) && !audioBuffer) return; // extracting, or fallback mode

    const regions = RegionsPlugin.create();
    const surfer = WaveSurfer.create({
      container: waveRef.current,
      height: 96,
      waveColor: '#5865f2',
      progressColor: '#8b93f8',
      cursorColor: '#ffffff',
      ...(audioBuffer
        ? { peaks: [makePeaks(audioBuffer)], duration: audioBuffer.duration }
        : { url: URL.createObjectURL(file) }),
      plugins: [regions],
    });
    surferRef.current = surfer;

    let regionMade = false;
    const makeRegion = (duration: number) => {
      if (regionMade || duration <= 0) return;
      regionMade = true;
      const region = regions.addRegion({
        start: 0,
        end: Math.min(duration, MAX_CLIP_SECONDS),
        color: 'rgba(88, 101, 242, 0.25)',
        drag: true,
        resize: true,
      });
      regionRef.current = region;
      setRange({ start: region.start, end: region.end });
    };
    surfer.on('decode', makeRegion);
    surfer.on('ready', () => makeRegion(surfer.getDuration()));

    regions.on('region-updated', (region) => {
      // Clamp to the max clip length by nudging the end handle.
      if (region.end - region.start > MAX_CLIP_SECONDS) {
        region.setOptions({ end: region.start + MAX_CLIP_SECONDS });
      }
      setRange({ start: region.start, end: region.end });
      zoomToRegion(region);
    });

    return () => {
      stopPreview();
      setZoomed(false);
      surfer.destroy();
      surferRef.current = null;
      regionRef.current = null;
    };
  }, [file, audioBuffer]);

  useEffect(() => () => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
  }, [videoUrl]);

  const playPreview = () => {
    const region = regionRef.current;

    // Videos preview through the media element — iOS mutes bare WebAudio
    // output when the silent switch is on, but media elements still play.
    if (videoUrl) {
      const video = videoRef.current;
      const r = fallback ? range : region && { start: region.start, end: region.end };
      if (!video || !r) return;
      stopPreview();
      video.currentTime = r.start;
      void video.play();
      const onTime = () => {
        if (video.currentTime >= r.end) stopPreview();
      };
      const onEnded = () => stopPreview();
      video.addEventListener('timeupdate', onTime);
      video.addEventListener('ended', onEnded);
      stopFnRef.current = () => {
        video.removeEventListener('timeupdate', onTime);
        video.removeEventListener('ended', onEnded);
        video.pause();
      };
      setPreviewing(true);
      return;
    }

    if (!region) return;

    const surfer = surferRef.current;
    if (!surfer) return;
    stopPreview();
    surfer.setTime(region.start);
    void surfer.play();
    const onTime = () => {
      if (surfer.getCurrentTime() >= region.end) stopPreview();
    };
    const onFinish = () => stopPreview();
    surfer.on('timeupdate', onTime);
    surfer.on('finish', onFinish);
    stopFnRef.current = () => {
      surfer.un('timeupdate', onTime);
      surfer.un('finish', onFinish);
      surfer.pause();
    };
    setPreviewing(true);
  };

  const pickFile = async (picked: File | null) => {
    setError(null);
    setAudioBuffer(null);
    setVideoUrl(null);
    setFallback(false);
    setVideoDuration(null);
    setRange(null);
    if (!picked) {
      setFile(null);
      return;
    }

    if (isVideo(picked)) {
      if (picked.size > MAX_VIDEO_BYTES) {
        setError('Video is larger than 300 MB — trim it in Photos first');
        return;
      }
      setFile(picked);
      setExtracting(true);
      try {
        setAudioBuffer(await decodeAudio(picked));
        setVideoUrl(URL.createObjectURL(picked));
      } catch {
        // Container not decodable in this browser (e.g. iOS .mov) — upload
        // the whole video and let the server's ffmpeg extract the audio.
        if (picked.size > MAX_FALLBACK_BYTES) {
          setFile(null);
          setError('This browser can\u2019t read the video locally and it\u2019s over 100 MB — trim it in Photos first');
        } else {
          setVideoUrl(URL.createObjectURL(picked));
          setFallback(true);
        }
      } finally {
        setExtracting(false);
      }
    } else {
      if (picked.size > MAX_FILE_BYTES) {
        setError('File is larger than 25 MB');
        return;
      }
      setFile(picked);
    }
    if (!name) setName(picked.name.replace(/\.[^.]+$/, '').slice(0, 64));
  };

  const submit = async () => {
    if (!file || !range || !name.trim()) {
      setError('Choose a file, a trim range and a name');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      if (audioBuffer) {
        // Upload only the trimmed audio, not the whole video.
        const wav = await renderWav(audioBuffer, range.start, range.end);
        form.append('file', wav, `${name.trim()}.wav`);
      } else {
        form.append('file', file);
        form.append('start', String(range.start));
        form.append('end', String(range.end));
      }
      form.append('name', name.trim());
      if (emoji.trim()) form.append('emoji', emoji.trim());
      if (tags.trim()) form.append('tags', tags.trim());
      await api.upload(form);
      onUploaded();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add a clip</h2>

        <input
          type="file"
          accept="audio/*,video/*"
          onChange={(e) => void pickFile(e.target.files?.[0] ?? null)}
        />

        {extracting && <p className="extract-note">Extracting audio from video…</p>}

        {videoUrl && (
          <video
            ref={videoRef}
            className="fallback-video"
            src={videoUrl}
            playsInline
            preload="auto"
            style={fallback ? undefined : { display: 'none' }}
            onLoadedMetadata={(e) => {
              if (!fallback) return;
              const dur = e.currentTarget.duration;
              if (Number.isFinite(dur)) {
                setVideoDuration(dur);
                setRange({ start: 0, end: Math.min(dur, MAX_CLIP_SECONDS) });
              }
            }}
          />
        )}

        {file && !extracting && fallback && range && videoDuration != null && (
          <div className="slider-rows">
                <label>
                  Start
                  <input
                    type="range"
                    min={0}
                    max={videoDuration}
                    step={0.1}
                    value={range.start}
                    onChange={(e) => {
                      const start = Number(e.target.value);
                      const end = Math.min(
                        videoDuration,
                        Math.max(range.end, start + 0.2, Math.min(range.end, start + MAX_CLIP_SECONDS)),
                      );
                      setRange({ start, end: Math.min(end, start + MAX_CLIP_SECONDS) });
                    }}
                  />
                </label>
                <label>
                  End
                  <input
                    type="range"
                    min={0}
                    max={videoDuration}
                    step={0.1}
                    value={range.end}
                    onChange={(e) => {
                      const end = Number(e.target.value);
                      const start = Math.max(0, Math.min(range.start, end - 0.2));
                      setRange({ start: Math.max(start, end - MAX_CLIP_SECONDS), end });
                    }}
                  />
                </label>
          </div>
        )}

        {file && !extracting && !fallback && (
          <div ref={waveRef} className="waveform" />
        )}

        {file && !extracting && (
          <div className="trim-row">
            <span>
              {range
                ? `Trim: ${range.start.toFixed(2)}s – ${range.end.toFixed(2)}s (${(range.end - range.start).toFixed(1)}s)`
                : 'Loading…'}
            </span>
            <div className="preview-btns">
              {!fallback && zoomed && (
                <button className="btn" onClick={zoomOut}>Full view</button>
              )}
              <button className="btn" onClick={playPreview} disabled={!range || previewing}>
                ▶ Play
              </button>
              <button className="btn" onClick={stopPreview} disabled={!previewing}>
                ■ Stop
              </button>
            </div>
          </div>
        )}

        <div className="field-row">
          <input
            type="text"
            placeholder="Clip name"
            maxLength={64}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="emoji-input"
            type="text"
            placeholder="🔊"
            maxLength={4}
            value={emoji}
            onChange={(e) => setEmoji(e.target.value)}
          />
        </div>

        <input
          type="text"
          className="tags-input"
          placeholder="Tags (comma separated, e.g. memes, boo)"
          maxLength={200}
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />

        {error && <p className="modal-error">{error}</p>}

        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={busy || !file}>
            {busy ? 'Processing…' : 'Upload'}
          </button>
        </div>
      </div>
    </div>
  );
}
