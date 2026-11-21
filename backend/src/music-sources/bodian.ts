import { createHash, randomUUID } from "node:crypto";
import { parseMusicAudioUrl } from "./audio-http.js";
import { fetchSourceJson } from "./http-client.js";
import { searchFreeKuwoCatalog } from "./kuwo.js";
import { createPublicMusicAdapter } from "./public-source.js";

export const BODIAN_SOURCE_ID = "bodian" as const;
const guestDeviceId = randomUUID().replaceAll("-", "");

export const bodianAdapter = createPublicMusicAdapter({
  id: BODIAN_SOURCE_ID,
  displayName: "Bodian Music",
  async search(options) {
    const mobileTracks = await searchFreeKuwoCatalog(options, "mobile");
    const tracks = mobileTracks.length > 0 ? mobileTracks : await searchFreeKuwoCatalog(options);
    return tracks.map((track) => ({
      ...track,
      source: BODIAN_SOURCE_ID,
      sourceTrackId: track.sourceTrackId.replace(/^MUSIC_/, "bodian_"),
    }));
  },
  async requestUrl(sourceTrackId) {
    const trackId = /^bodian_(\d+)$/.exec(sourceTrackId)?.[1];
    if (!trackId) return null;

    const url = new URL("https://bd-api.kuwo.cn/api/play/music/v2/audioUrl");
    const params = new URLSearchParams({ br: "320kmp3", musicId: trackId, timestamp: String(Date.now()) });
    const canonicalQuery = params.toString().replace(/[^a-z0-9]/gi, "").split("").sort().join("");
    params.set("sign", createHash("md5").update(`kuwotest${canonicalQuery}${url.pathname}`).digest("hex"));
    url.search = params.toString();

    const result = await fetchSourceJson<{
      code: number;
      data?: { audioUrl?: string };
    }>(url, {
      headers: { plat: "ar", channel: "aliopen", devid: guestDeviceId, ver: "3.9.0" },
    });
    if (result?.code !== 200 || typeof result.data?.audioUrl !== "string") return null;

    const audio = parseMusicAudioUrl(result.data.audioUrl);
    return audio && /\.(?:kuwo\.cn|bodian\.com)$/.test(audio.hostname) ? audio.href : null;
  },
});
