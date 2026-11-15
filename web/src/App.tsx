import { KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { ADMIN_USER } from './config';
import { captureTokenFromUrl, clearToken, getToken, setDevToken } from './auth';
import * as ws from './ws';
import type {
  BotStatus, Clip, ConnectionState, Playlist, QueueEntry, SpotifyState, SpotifyStatus, TabId, User, YouTubeState,
} from './types';
import { formatTag } from './format';
import { loadRecent, pushRecent } from './recent';
import Login from './components/Login';
import StatusBanner from './components/StatusBanner';
import SoundboardGrid from './components/SoundboardGrid';
import UploadModal from './components/UploadModal';
import EditClipModal from './components/EditClipModal';
import SpotifyTab from './components/SpotifyTab';
import YouTubeTab from './components/YouTubeTab';

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'soundboard', label: 'Soundboard', icon: '🔊' },
  { id: 'spotify', label: 'Spotify', icon: '🎵' },
  { id: 'youtube', label: 'YouTube', icon: '📺' },
];

function tabFromHash(): TabId {
  const id = window.location.hash.slice(1);
  return TABS.some((t) => t.id === id) ? (id as TabId) : 'soundboard';
}

export default function App() {
  const [loginError] = useState<string | null>(() => captureTokenFromUrl());
  const [tab, setTab] = useState<TabId>(tabFromHash);
  // The YouTube player mounts on first visit, then stays alive so the video
  // keeps playing while you use the other tabs.
  const [youtubeMounted, setYoutubeMounted] = useState(() => tabFromHash() === 'youtube');
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [clips, setClips] = useState<Clip[]>([]);
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [wsState, setWsState] = useState<ConnectionState>('closed');
  const [showUpload, setShowUpload] = useState(false);
  const [editClip, setEditClip] = useState<Clip | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [spotify, setSpotify] = useState<SpotifyState | null>(null);
  const [spotifyStatus, setSpotifyStatus] = useState<SpotifyStatus | null>(null);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [youtube, setYoutube] = useState<YouTubeState | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const [favoriteIds, setFavoriteIds] = useState<number[]>([]);
  const [recentIds, setRecentIds] = useState<number[]>(loadRecent);

  const selectTab = useCallback((next: TabId) => {
    setTab(next);
    if (next === 'youtube') setYoutubeMounted(true);
    if (window.location.hash !== `#${next}`) window.location.hash = next;
  }, []);

  /* Back/forward buttons move between tabs. */
  useEffect(() => {
    const onHash = () => {
      const next = tabFromHash();
      setTab(next);
      if (next === 'youtube') setYoutubeMounted(true);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const toastTimer = useRef<number>();
  const notify = useCallback((msg: string) => {
    setToast(msg);
    // Restart the timer so an older toast's timeout can't clear a newer one.
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  }, []);

  const refreshClips = useCallback(() => {
    api.clips().then(setClips).catch(() => notify('Failed to load clips'));
  }, [notify]);

  /* Session bootstrap. Probe /me even without a token — it succeeds when
     the server runs with AUTH_DISABLED (LAN dev), skipping the login. */
  useEffect(() => {
    api.me()
      .then((me) => {
        if (!getToken()) setDevToken();
        setUser(me);
        refreshClips();
        api.status().then(setStatus).catch(() => {});
        api.spotifyStatus().then(setSpotifyStatus).catch(() => {});
        api.spotifyQueueList().then(setQueue).catch(() => {});
        api.playlists().then(setPlaylists).catch(() => {});
        api.favorites().then(setFavoriteIds).catch(() => {});
      })
      .catch(() => {})
      .finally(() => setAuthChecked(true));
  }, [refreshClips]);

  /* Result of the admin's Spotify connect redirect (?spotify=connected|error) */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('spotify');
    if (!result) return;
    window.history.replaceState(null, '', window.location.pathname + window.location.hash);
    notify(result === 'connected' ? 'Spotify connected!' : 'Spotify connection failed');
  }, [notify]);

  /* Live status over WebSocket */
  useEffect(() => {
    if (!user) return;
    ws.connect();
    const unsubscribe = ws.subscribe({
      onStatus: setStatus,
      onState: setWsState,
      onError: notify,
      onSpotify: setSpotify,
      onQueue: setQueue,
      onPlaylists: setPlaylists,
      onYoutube: (state, offset) => {
        setYoutube(state);
        setClockOffset(offset);
      },
    });
    return () => {
      unsubscribe();
      ws.disconnect();
    };
  }, [user, notify]);

  const playClip = useCallback((clip: Clip) => {
    setRecentIds((cur) => pushRecent(cur, clip.id));
    if (!ws.sendPlay(clip.id)) {
      api.play(clip.id).catch((err) => notify(err.message));
    }
  }, [notify]);

  const toggleFavorite = useCallback((clip: Clip) => {
    const favorite = !favoriteIds.includes(clip.id);
    // Optimistic: star instantly, reconcile with the server's list.
    setFavoriteIds((cur) => (favorite ? [...cur, clip.id] : cur.filter((id) => id !== clip.id)));
    api.setFavorite(clip.id, favorite)
      .then(setFavoriteIds)
      .catch((err) => {
        setFavoriteIds((cur) => (favorite ? cur.filter((id) => id !== clip.id) : [...cur, clip.id]));
        notify(err.message);
      });
  }, [favoriteIds, notify]);

  const stopClip = useCallback(() => {
    if (!ws.sendStop()) {
      api.stop().catch(() => {});
    }
  }, []);

  const deleteClip = useCallback((clip: Clip) => {
    if (!window.confirm(`Delete "${clip.name}"?`)) return;
    api.deleteClip(clip.id)
      .then(refreshClips)
      .catch((err) => notify(err.message));
  }, [refreshClips, notify]);

  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const clip of clips) {
      for (const tag of clip.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.keys()].sort((a, b) => (counts.get(b)! - counts.get(a)!) || a.localeCompare(b));
  }, [clips]);

  const toggleTag = (tag: string) =>
    setActiveTags((cur) => (cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag]));

  const visibleClips = useMemo(() => {
    const q = query.trim().toLowerCase();
    return clips.filter((clip) =>
      activeTags.every((tag) => clip.tags.includes(tag)) &&
      (!q || clip.name.toLowerCase().includes(q) || clip.tags.some((tag) => tag.includes(q))),
    );
  }, [clips, query, activeTags]);

  const favoriteSet = useMemo(() => new Set(favoriteIds), [favoriteIds]);
  const clipsById = useMemo(() => new Map(clips.map((c) => [c.id, c])), [clips]);
  const pick = (ids: number[]) => ids.map((id) => clipsById.get(id)).filter((c): c is Clip => !!c);
  const favoriteClips = pick(favoriteIds);
  const recentClips = pick(recentIds);
  // Quick-access rows only make sense on the unfiltered board.
  const filtering = query.trim() !== '' || activeTags.length > 0;

  if (!authChecked) return null;

  if (!user) {
    return <Login error={loginError} />;
  }

  const spotifyPlaying = !!(spotify?.active && spotify.isPlaying);
  const youtubeLive = !!(youtube?.videoId && youtube.playing);
  const tabBadge: Record<TabId, boolean> = {
    soundboard: !!status?.clip,
    spotify: spotifyPlaying,
    youtube: youtubeLive,
  };

  const onTabKey = (e: KeyboardEvent, index: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const delta = e.key === 'ArrowRight' ? 1 : -1;
    const next = TABS[(index + delta + TABS.length) % TABS.length];
    selectTab(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-logo">🎉</span>
          <div>
            <h1>Mr Blobby</h1>
            <span className="brand-sub">{TABS.find((t) => t.id === tab)?.label}</span>
          </div>
        </div>
        <nav className="tabs" role="tablist" aria-label="Sections">
          {TABS.map((t, i) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className={`tab${tab === t.id ? ' active' : ''}`}
              onClick={() => selectTab(t.id)}
              onKeyDown={(e) => onTabKey(e, i)}
            >
              <span aria-hidden="true">{t.icon}</span>
              <span className="tab-label">{t.label}</span>
              {tabBadge[t.id] && <span className="tab-live" title="Active" />}
            </button>
          ))}
        </nav>
        <div className="userchip">
          {user.avatar && <img src={user.avatar} alt="" />}
          <span>{user.username}</span>
          <button
            className="btn subtle"
            onClick={() => { clearToken(); window.location.reload(); }}
          >
            Sign out
          </button>
        </div>
      </header>

      {/* YouTube audio is local to each browser, so the bot's voice status
          only matters there when the socket itself is down. */}
      {(tab !== 'youtube' || wsState !== 'open') && (
        <StatusBanner status={status} wsState={wsState} />
      )}

      <div
        id="panel-soundboard"
        role="tabpanel"
        aria-labelledby="tab-soundboard"
        className={`tab-panel${tab === 'soundboard' ? '' : ' inactive'}`}
      >
        <div className="filter-bar">
          <div className="toolbar">
            {clips.length > 0 && (
              <input
                type="search"
                className="search-input"
                placeholder="Search clips…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            )}
            <button className="btn primary" onClick={() => setShowUpload(true)}>+ Add clip</button>
            <button className="btn" onClick={stopClip}>Stop</button>
          </div>
          {allTags.length > 0 && (
            <div className="tag-chips">
              {allTags.map((tag) => (
                <button
                  key={tag}
                  className={`tag-chip${activeTags.includes(tag) ? ' active' : ''}`}
                  onClick={() => toggleTag(tag)}
                >
                  {formatTag(tag)}
                </button>
              ))}
              {activeTags.length > 0 && (
                <button className="tag-chip clear" onClick={() => setActiveTags([])}>
                  ✕ clear
                </button>
              )}
            </div>
          )}
        </div>

        {!filtering && ([
          ['★ Favourites', favoriteClips],
          ['🕘 Recent', recentClips],
        ] as const).map(([heading, list]) => list.length > 0 && (
          <section key={heading} className="board-section">
            <h2>{heading}</h2>
            <SoundboardGrid
              clips={list}
              nowPlayingId={status?.clip?.id ?? null}
              disabled={!status?.inVoice}
              currentUserId={user.userId}
              isAdmin={ADMIN_USER != null && user.userId === ADMIN_USER}
              favoriteIds={favoriteSet}
              onPlay={playClip}
              onEdit={setEditClip}
              onDelete={deleteClip}
              onToggleFavorite={toggleFavorite}
            />
          </section>
        ))}

        <section className="board-section">
          {!filtering && (favoriteClips.length > 0 || recentClips.length > 0) && <h2>All clips</h2>}
          <SoundboardGrid
            clips={visibleClips}
            nowPlayingId={status?.clip?.id ?? null}
            disabled={!status?.inVoice}
            currentUserId={user.userId}
            isAdmin={ADMIN_USER != null && user.userId === ADMIN_USER}
            favoriteIds={favoriteSet}
            onPlay={playClip}
            onEdit={setEditClip}
            onDelete={deleteClip}
            onToggleFavorite={toggleFavorite}
            emptyMessage={clips.length > 0 ? 'No clips match your search' : undefined}
          />
        </section>
      </div>

      <div
        id="panel-spotify"
        role="tabpanel"
        aria-labelledby="tab-spotify"
        className={`tab-panel${tab === 'spotify' ? '' : ' inactive'}`}
      >
        <SpotifyTab
          user={user}
          isAdmin={ADMIN_USER != null && user.userId === ADMIN_USER}
          status={status}
          spotify={spotify}
          spotifyStatus={spotifyStatus}
          queue={queue}
          playlists={playlists}
          onNotify={notify}
        />
      </div>

      <div
        id="panel-youtube"
        role="tabpanel"
        aria-labelledby="tab-youtube"
        className={`tab-panel${tab === 'youtube' ? '' : ' inactive'}`}
      >
        {youtubeMounted && (
          <YouTubeTab
            shared={youtube}
            clockOffset={clockOffset}
            connected={wsState === 'open'}
            onNotify={notify}
          />
        )}
      </div>

      {showUpload && (
        <UploadModal
          onClose={() => setShowUpload(false)}
          onUploaded={() => { setShowUpload(false); refreshClips(); }}
        />
      )}

      {editClip && (
        <EditClipModal
          clip={editClip}
          onClose={() => setEditClip(null)}
          onSaved={() => { setEditClip(null); refreshClips(); }}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
