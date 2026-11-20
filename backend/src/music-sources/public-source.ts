import { parseMusicAudioUrl } from "./audio-http.js";
import {
  type MusicSourceAdapter,
  type MusicSourceTrack,
  MusicSourceError,
} from "./types.js";

const SEARCH_RESULT_TTL_MS = 60_000;
const MAX_SEARCH_RESULTS = 200;
const AUDIO_URL_TTL_MS = 5 * 60_000;

export function createPublicMusicAdapter(
  config: Pick<MusicSourceAdapter, "id" | "displayName" | "search"> & {
    requestUrl: (sourceTrackId: string) => Promise<string | null>;
  },
): MusicSourceAdapter {
  const publicTracks = new Map<string, { track: MusicSourceTrack; expiresAt: number }>();

  function getPublicTrack(id: string): MusicSourceTrack | null {
    const result = publicTracks.get(id);
    if (result && result.expiresAt > Date.now()) return result.track;
    publicTracks.delete(id);
    return null;
  }

  const resolveUrl: MusicSourceAdapter["resolvePlayableUrl"] = async (sourceTrackId) => {
    if (!getPublicTrack(sourceTrackId)) {
      throw new MusicSourceError(config.id, "not_found", "No recent free playback result for this track");
    }
    const refreshedAt = Date.now();
    const url = await config.requestUrl(sourceTrackId);
    if (!url || !parseMusicAudioUrl(url)) {
      throw new MusicSourceError(config.id, "unplayable", "Music source did not return a free playback URL");
    }
    return { source: config.id, sourceTrackId, url, refreshedAt, expiresAt: refreshedAt + AUDIO_URL_TTL_MS };
  };

  return {
    id: config.id,
    displayName: config.displayName,
    async search(options) {
      const tracks = await config.search(options);
      const expiresAt = Date.now() + SEARCH_RESULT_TTL_MS;
      for (const track of tracks) {
        publicTracks.delete(track.sourceTrackId);
        publicTracks.set(track.sourceTrackId, { track, expiresAt });
      }
      for (const [id, record] of publicTracks) {
        if (publicTracks.size > MAX_SEARCH_RESULTS || record.expiresAt <= Date.now()) {
          publicTracks.delete(id);
        }
      }
      return tracks;
    },
    async getTrackDetail(sourceTrackId) {
      return getPublicTrack(sourceTrackId);
    },
    resolvePlayableUrl: resolveUrl,
    refreshPlayableUrl: resolveUrl,
    async healthCheck() {
      return { source: config.id, ok: true, message: "Availability is checked during search and playback.", checkedAt: Date.now() };
    },
  };
}
