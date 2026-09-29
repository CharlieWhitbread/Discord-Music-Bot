import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin, { type Region } from 'wavesurfer.js/dist/plugins/regions.esm.js';
import { api } from '../api';

const MAX_CLIP_SECONDS = 30;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export default function UploadModal({
  onClose,
  onUploaded,
}: {
  onClose: () => void;
  onUploaded: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('');
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const waveRef = useRef<HTMLDivElement>(null);
  const surferRef = useRef<WaveSurfer | null>(null);
  const regionRef = useRef<Region | null>(null);

  /* Build the waveform + trim region when a file is chosen. */
  useEffect(() => {
    if (!file || !waveRef.current) return;

    const regions = RegionsPlugin.create();
    const surfer = WaveSurfer.create({
      container: waveRef.current,
      height: 96,
      waveColor: '#5865f2',
      progressColor: '#8b93f8',
      cursorColor: '#ffffff',
      url: URL.createObjectURL(file),
      plugins: [regions],
    });
    surferRef.current = surfer;

    surfer.on('decode', (duration) => {
      const region = regions.addRegion({
        start: 0,
        end: Math.min(duration, MAX_CLIP_SECONDS),
        color: 'rgba(88, 101, 242, 0.25)',
        drag: true,
        resize: true,
      });
      regionRef.current = region;
      setRange({ start: region.start, end: region.end });
    });

    regions.on('region-updated', (region) => {
      // Clamp to the max clip length by nudging the end handle.
      if (region.end - region.start > MAX_CLIP_SECONDS) {
        region.setOptions({ end: region.start + MAX_CLIP_SECONDS });
      }
      setRange({ start: region.start, end: region.end });
    });

    return () => {
      surfer.destroy();
      surferRef.current = null;
      regionRef.current = null;
    };
  }, [file]);

  const previewRegion = () => {
    const surfer = surferRef.current;
    const region = regionRef.current;
    if (!surfer || !region) return;
    surfer.setTime(region.start);
    surfer.play();
    const stopAt = () => {
      if (surfer.getCurrentTime() >= region.end) {
        surfer.pause();
        surfer.un('timeupdate', stopAt);
      }
    };
    surfer.on('timeupdate', stopAt);
  };

  const pickFile = (picked: File | null) => {
    setError(null);
    if (picked && picked.size > MAX_FILE_BYTES) {
      setError('File is larger than 25 MB');
      return;
    }
    setFile(picked);
    if (picked && !name) setName(picked.name.replace(/\.[^.]+$/, '').slice(0, 64));
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
      form.append('file', file);
      form.append('name', name.trim());
      if (emoji.trim()) form.append('emoji', emoji.trim());
      form.append('start', String(range.start));
      form.append('end', String(range.end));
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
          accept="audio/*,video/mp4,video/webm"
          onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
        />

        {file && (
          <>
            <div ref={waveRef} className="waveform" />
            <div className="trim-row">
              <span>
                {range
                  ? `Trim: ${range.start.toFixed(2)}s – ${range.end.toFixed(2)}s (${(range.end - range.start).toFixed(1)}s)`
                  : 'Loading waveform…'}
              </span>
              <button className="btn" onClick={previewRegion} disabled={!range}>
                Preview
              </button>
            </div>
          </>
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
