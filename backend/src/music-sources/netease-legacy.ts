import * as netease from "../netease.js";
import {
  MusicSourceAdapter,
  MusicSourceError,
  MusicSourceTrack,
  PlayableTrack,
  PlayableUrlResult,
  normalizeMusicSourceError,
} from "./types.js";

export const NETEASE_LEGACY_SOURCE_ID = "netease_legacy" as const;

function toSourceTrack(track: netease.NeteaseTrack): MusicSourceTrack {
  return {
    source: NETEASE_LEGACY_SOURCE_ID,
    sourceTrackId: String(track.id),
    title: track.name,
    artist: track.artists.map((artist) => artist.name).filter(Boolean).join(", "),
    album: track.album.name,
    picUrl: track.album.picUrl,
    duration: track.duration,
  };
}

export function toPlayableTrack(track: MusicSourceTrack, playableUrl: PlayableUrlResult): PlayableTrack {
  const numericId = Number(track.sourceTrackId);
  return {
    id: Number.isFinite(numericId) ? numericId : track.sourceTrackId,
    name: track.title,
    artist: track.artist,
    url: playableUrl.url,
    picUrl: track.picUrl ?? "",
    duration: track.duration ?? 0,
    album: track.album,
    source: track.source,
    sourceTrackId: track.sourceTrackId,
    urlSource: playableUrl.source,
    urlExpiresAt: playableUrl.expiresAt,
    urlRefreshedAt: playableUrl.refreshedAt,
  };
}

async function resolveNeteasePlayableUrl(sourceTrackId: string): Promise<PlayableUrlResult> {
  try {
    const playback = await netease.getOpenPlayableUrl(Number(sourceTrackId));
    if (!playback) {
      throw new MusicSourceError(
        NETEASE_LEGACY_SOURCE_ID,
        "unplayable",
        `No playable URL found for track ${sourceTrackId}`,
      );
    }
    return { ...playback, source: NETEASE_LEGACY_SOURCE_ID, sourceTrackId };
  } catch (error) {
    throw normalizeMusicSourceError(NETEASE_LEGACY_SOURCE_ID, error);
  }
}

export const neteaseLegacyAdapter: MusicSourceAdapter = {
  id: NETEASE_LEGACY_SOURCE_ID,
  displayName: "Netease Cloud Music",

  async search(options) {
    try {
      const result = await netease.searchSongs(options.keyword, options.limit ?? 10);
      return result.tracks.map(toSourceTrack);
    } catch (error) {
      throw normalizeMusicSourceError(NETEASE_LEGACY_SOURCE_ID, error);
    }
  },

  async getTrackDetail(sourceTrackId) {
    const numericId = Number(sourceTrackId);
    if (!Number.isFinite(numericId)) {
      return null;
    }

    const tracks = await this.search({ keyword: sourceTrackId, limit: 5 });
    return tracks.find((track) => track.sourceTrackId === sourceTrackId) ?? null;
  },

  resolvePlayableUrl: resolveNeteasePlayableUrl,
  refreshPlayableUrl: resolveNeteasePlayableUrl,

  async healthCheck() {
    return {
      source: NETEASE_LEGACY_SOURCE_ID,
      ok: true,
      message: "Search and anonymous playback availability are checked per track.",
      checkedAt: Date.now(),
    };
  },
};
