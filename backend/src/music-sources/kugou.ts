import { createHash } from "node:crypto";
import { parseMusicAudioUrl } from "./audio-http.js";
import { fetchSourceJson } from "./http-client.js";
import { createPublicMusicAdapter } from "./public-source.js";

export const KUGOU_SOURCE_ID = "kugou" as const;
const TRACK_ID = /^([a-f0-9]{32}):(\d+)$/i;

interface KugouSong {
  FileHash: string;
  AlbumID: string;
  AlbumName: string;
  SongName: string;
  SingerName: string;
  Duration: number;
  PayType: number;
  Privilege: number;
  AlbumPrivilege: number;
  Price: number;
  PkgPrice: number;
  FailProcess: number;
}

export const kugouAdapter = createPublicMusicAdapter({
  id: KUGOU_SOURCE_ID,
  displayName: "Kugou Music",
  async search({ keyword, limit = 6 }) {
    const url = new URL("https://songsearch.kugou.com/song_search_v2");
    url.search = new URLSearchParams({ keyword, page: "1", pagesize: String(limit) }).toString();
    const result = await fetchSourceJson<{ status: number; data?: { lists?: KugouSong[] } }>(url);
    const songs = result?.status === 1 ? result.data?.lists ?? [] : [];
    return songs.filter((song) =>
      song.PayType === 0 && song.Privilege === 0 && song.AlbumPrivilege === 0
      && song.Price === 0 && song.PkgPrice === 0 && song.FailProcess === 0
      && TRACK_ID.test(`${song.FileHash}:${song.AlbumID}`),
    ).map((song) => ({
      source: KUGOU_SOURCE_ID,
      sourceTrackId: `${song.FileHash.toLowerCase()}:${song.AlbumID}`,
      title: song.SongName,
      artist: song.SingerName,
      album: song.AlbumName,
      duration: song.Duration * 1000,
    }));
  },
  async requestUrl(sourceTrackId) {
    const identifier = TRACK_ID.exec(sourceTrackId);
    if (!identifier) return null;
    const [, hash, albumId] = identifier;
    const url = new URL("https://trackercdn.kugou.com/i/v2/");
    url.search = new URLSearchParams({
      key: createHash("md5").update(`${hash}kgcloudv2`).digest("hex"),
      hash, appid: "1005", pid: "2", cmd: "25", behavior: "play", album_id: albumId,
    }).toString();
    const result = await fetchSourceJson<{ status: number; url?: string[] }>(url);
    if (result?.status !== 1 || !Array.isArray(result.url)) return null;
    for (const entry of result.url) {
      if (typeof entry !== "string") continue;
      const audio = parseMusicAudioUrl(entry);
      if (audio && /(?:^|\.)(?:kugou\.com|kgimg\.com)$/.test(audio.hostname)) return audio.href;
    }
    return null;
  },
});
