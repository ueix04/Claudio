import { randomInt } from "node:crypto";
import { parseMusicAudioUrl } from "./audio-http.js";
import { fetchSourceJson } from "./http-client.js";
import { createPublicMusicAdapter } from "./public-source.js";

export const QQ_SOURCE_ID = "qq" as const;
const guestId = String(randomInt(1_000_000_000, 10_000_000_000));

interface QqSong {
  songmid: string;
  songname: string;
  singer: Array<{ name: string }>;
  albumname?: string;
  interval: number;
  pay?: { payplay: number };
}

export const qqAdapter = createPublicMusicAdapter({
  id: QQ_SOURCE_ID,
  displayName: "QQ Music",
  async search({ keyword, limit = 6 }) {
    const url = new URL("https://c.y.qq.com/soso/fcgi-bin/client_search_cp");
    url.search = new URLSearchParams({ format: "json", w: keyword, p: "1", n: String(limit) }).toString();
    const result = await fetchSourceJson<{ code: number; data?: { song?: { list?: QqSong[] } } }>(url);
    const songs = result?.code === 0 ? result.data?.song?.list ?? [] : [];
    return songs.filter((song) => song.pay?.payplay === 0 && /^[a-z0-9]+$/i.test(song.songmid))
      .map((song) => ({
        source: QQ_SOURCE_ID,
        sourceTrackId: song.songmid,
        title: song.songname,
        artist: song.singer?.map(({ name }) => name).filter(Boolean).join(", ") ?? "",
        album: song.albumname,
        duration: Number(song.interval) * 1000,
      }));
  },
  async requestUrl(sourceTrackId) {
    const url = new URL("https://u.y.qq.com/cgi-bin/musicu.fcg");
    url.searchParams.set("data", JSON.stringify({
      playback: {
        module: "vkey.GetVkeyServer",
        method: "CgiGetVkey",
        param: { guid: guestId, loginflag: 0, songmid: [sourceTrackId], songtype: [0], uin: "0", platform: "20" },
      },
    }));
    const payload = await fetchSourceJson<{
      code: number;
      playback?: {
        code: number;
        data?: { sip?: string[]; midurlinfo?: Array<{ songmid: string; result: number; purl?: string }> };
      };
    }>(url);
    const playback = payload?.playback;
    const entry = playback?.data?.midurlinfo?.find((item) => item.songmid === sourceTrackId);
    if (payload?.code !== 0 || playback?.code !== 0 || entry?.result !== 0 || !entry.purl) return null;

    const cdn = (playback.data?.sip ?? []).map((value) => parseMusicAudioUrl(value))
      .filter((value): value is URL => value !== null);
    const base = cdn.find((value) => value.protocol === "https:") ?? cdn[0];
    const audio = base ? parseMusicAudioUrl(entry.purl, base) : null;
    return audio?.origin === base?.origin ? audio?.href ?? null : null;
  },
});
