import { parseMusicAudioUrl } from "./audio-http.js";
import { fetchSourceJson, fetchSourceText } from "./http-client.js";
import { createPublicMusicAdapter } from "./public-source.js";

export const KUWO_SOURCE_ID = "kuwo" as const;

interface KuwoSong {
  MUSICRID: string;
  SONGNAME: string;
  ARTIST: string;
  ALBUM?: string;
  DURATION: string;
  PAY: string;
  payInfo?: { cannotOnlinePlay: string; listen_fragment: string; feeType?: Record<string, string> };
}

export const kuwoAdapter = createPublicMusicAdapter({
  id: KUWO_SOURCE_ID,
  displayName: "Kuwo Music",
  async search({ keyword, limit = 6 }) {
    const url = new URL("https://search.kuwo.cn/r.s");
    url.search = new URLSearchParams({
      all: keyword, stype: "comprehensive", rformat: "json", encoding: "utf8", pn: "0", rn: String(limit),
    }).toString();
    const result = await fetchSourceJson<{ content?: Array<{ musicpage?: { abslist?: KuwoSong[] } }> }>(url);
    const songs = result?.content?.find((entry) => entry.musicpage)?.musicpage?.abslist ?? [];
    return songs.filter(({ PAY, payInfo, MUSICRID }) => {
      const fees = payInfo?.feeType;
      return /^MUSIC_\d+$/.test(MUSICRID) && PAY === "0" && payInfo?.cannotOnlinePlay === "0"
        && payInfo.listen_fragment === "0" && fees?.album === "0" && fees.song === "0" && fees.vip === "0";
    }).map((song) => ({
      source: KUWO_SOURCE_ID,
      sourceTrackId: song.MUSICRID,
      title: song.SONGNAME.replace(/&nbsp;/gi, " "),
      artist: song.ARTIST.replace(/&/g, ", "),
      album: song.ALBUM,
      duration: Number(song.DURATION) * 1000,
    }));
  },
  async requestUrl(sourceTrackId) {
    const url = new URL("https://antiserver.kuwo.cn/anti.s");
    url.search = new URLSearchParams({ type: "convert_url", format: "mp3", response: "url", rid: sourceTrackId }).toString();
    const audio = parseMusicAudioUrl((await fetchSourceText(url)).trim());
    return audio?.hostname.endsWith(".kuwo.cn") ? audio.href : null;
  },
});
