import type { BotStatus, ConnectionState } from '../types';

export default function StatusBanner({
  status,
  wsState,
}: {
  status: BotStatus | null;
  wsState: ConnectionState;
}) {
  if (wsState !== 'open') {
    return (
      <div className="banner warn">
        {wsState === 'connecting' ? 'Connecting to the bot…' : 'Bot unreachable — is the Pi online?'}
      </div>
    );
  }
  if (!status?.inVoice) {
    return (
      <div className="banner warn">
        Bot is not in a voice channel — run <code>/join</code> in Discord.
      </div>
    );
  }
  return (
    <div className="banner ok">
      Connected
      {status.spotifyActive && ' · Spotify is streaming'}
      {status.clip && ` · Playing: ${status.clip.name}`}
    </div>
  );
}
