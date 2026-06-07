import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const resolvedDataDir = (() => {
  const explicitDataDir = process.env.CLAUDIO_DATA_DIR?.trim();
  if (explicitDataDir) {
    return isAbsolute(explicitDataDir)
      ? explicitDataDir
      : resolve(repoRoot, explicitDataDir);
  }

  return resolve(repoRoot, "data.test");
})();

const stateFilePath = resolve(resolvedDataDir, "state.json");
const stateDirPath = dirname(stateFilePath);

const cleanup = (): void => {
  try {
    rmSync(stateDirPath, { recursive: true, force: true });
  } catch {
    // 目录被占用或不存在，忽略清理错误
  }
};

const loadModule = async () => {
  vi.resetModules();
  return import("./db");
};

beforeEach(() => {
  cleanup();
});

afterEach(() => {
  cleanup();
});

describe("db.ts", () => {
  it("initializes database file", async () => {
    const { getDb } = await loadModule();

    getDb();

    expect(existsSync(stateFilePath)).toBe(true);
  });

  it("reads default state", async () => {
    const { getState } = await loadModule();

    const state = await getState();

    expect(state).toMatchObject({
      status: "idle",
      currentTrack: null,
      radioQueue: [],
      currentQueueIndex: 0,
      currentProgram: null,
      chatHistory: [],
      neteaseSnapshot: null,
      djProfile: {
        voice: "冰糖",
        style: "情感电台",
        name: "Claudio",
      },
    });
    expect(state.lastInteraction).toBeTypeOf("number");
  });

  it("updates state and reads it back", async () => {
    const { updateState, getState } = await loadModule();

    await updateState({ status: "thinking" });

    const state = await getState();

    expect(state.status).toBe("thinking");
  });

  it("appends chat messages without overwriting history", async () => {
    const { addChatMessage, getState } = await loadModule();

    await addChatMessage({ role: "user", text: "hello" });
    await addChatMessage({ role: "dj", text: "hi there" });

    const state = await getState();

    expect(state.chatHistory).toHaveLength(2);
    expect(state.chatHistory[0]).toMatchObject({ role: "user", text: "hello" });
    expect(state.chatHistory[1]).toMatchObject({ role: "dj", text: "hi there" });
  });

  it("persists status and current track", async () => {
    const first = await loadModule();

    await first.setStatus("playing");
    await first.setCurrentTrack({
      id: "track-1",
      name: "Night Drive",
      artist: "Claudio",
      url: "https://example.com/track-1",
    });

    const second = await loadModule();
    const state = await second.getState();

    expect(state.status).toBe("playing");
    expect(state.currentTrack).toMatchObject({
      id: "track-1",
      name: "Night Drive",
      artist: "Claudio",
      url: "https://example.com/track-1",
    });
  });

  it("stores and advances radio queue", async () => {
    const { setRadioQueue, advanceRadioQueue, getState } = await loadModule();

    await setRadioQueue([
      { id: "1", name: "Song A", artist: "Artist A", url: "https://example.com/a.mp3" },
      { id: "2", name: "Song B", artist: "Artist B", url: "https://example.com/b.mp3" },
    ], {
      currentIndex: 0,
      program: {
        source: "startup",
        generatedAt: 1,
        title: "Morning Flow",
      },
    });

    let state = await getState();
    expect(state.radioQueue).toHaveLength(2);
    expect(state.currentQueueIndex).toBe(0);
    expect(state.currentTrack?.name).toBe("Song A");
    expect(state.currentProgram?.title).toBe("Morning Flow");

    await advanceRadioQueue();
    state = await getState();
    expect(state.currentQueueIndex).toBe(1);
    expect(state.currentTrack?.name).toBe("Song B");
  });

  it("adds playlists and retrieves them", async () => {
    const { addPlaylist, getPlaylists } = await loadModule();
    await addPlaylist("我的收藏", [
      { name: "Song A", artist: "Artist A" },
      { name: "Song B", artist: "Artist B" },
    ]);

    const lists = await getPlaylists();
    expect(lists).toHaveLength(1);
    expect(lists[0].name).toBe("我的收藏");
    expect(lists[0].tracks).toHaveLength(2);
  });

  it("removes playlists by id", async () => {
    const { addPlaylist, getPlaylists, removePlaylist } = await loadModule();
    const pl = await addPlaylist("临时歌单", [{ name: "X", artist: "Y" }]);
    expect(await getPlaylists()).toHaveLength(1);

    await removePlaylist(pl.id);
    expect(await getPlaylists()).toHaveLength(0);
  });

  it("summarizePlaylists returns empty when no playlists", async () => {
    const { summarizePlaylists } = await loadModule();
    expect(summarizePlaylists()).toBe("");
  });

  it("persists netease snapshot and summarizes it", async () => {
    const { setNeteaseSnapshot, getNeteaseSnapshot, summarizeNeteaseSnapshot } = await loadModule();
    await setNeteaseSnapshot({
      account: {
        userId: 1,
        nickname: "tester",
        avatarUrl: "https://example.com/avatar.jpg",
      },
      playlists: [
        {
          id: 11,
          name: "深夜歌单",
          trackCount: 42,
          playCount: 100,
          tracks: [
            { id: 1, name: "Song A", artist: "Artist A", album: "Album A" },
          ],
          coverImgUrl: "https://example.com/cover.jpg",
          creator: { nickname: "tester", userId: 1 },
        },
      ],
      syncedAt: 1_700_000_000_000,
    });

    const snapshot = await getNeteaseSnapshot();
    expect(snapshot?.account.nickname).toBe("tester");
    expect(snapshot?.playlists).toHaveLength(1);
    expect(summarizeNeteaseSnapshot()).toContain("深夜歌单");
  });

  it("stores recent listen check records", async () => {
    const { addListenCheckRecord, getListenCheckRecords, getState } = await loadModule();

    const record = await addListenCheckRecord({
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_001_200_000,
      durationMs: 1_200_000,
      playbackMs: 1_200_000,
      checks: {
        program: true,
        dj: true,
        context: true,
      },
      note: "20 minutes felt cohesive.",
      needsFollowUp: false,
      programAudit: {
        ok: true,
        plannedMinutes: 24,
        trackCount: 6,
        speechSlotCount: 3,
        issueCount: 0,
      },
      programContinuity: {
        ok: true,
        startedSessionId: "startup_test",
        completedSessionId: "startup_test",
        startedGeneratedAt: 1,
        completedGeneratedAt: 1,
      },
      programSnapshot: {
        sessionId: "startup_test",
        title: "Night Flow",
        mood: "quiet",
        source: "startup",
        generatedAt: 1,
        currentQueueIndex: 0,
        tracks: [
          { id: "1", name: "Song A", artist: "Artist A", source: "local_library", duration: 240000 },
        ],
      },
    });

    const records = await getListenCheckRecords();
    const state = await getState();

    expect(record.id).toMatch(/^listen_/);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      durationMs: 1_200_000,
      playbackMs: 1_200_000,
      checks: { program: true, dj: true, context: true },
      note: "20 minutes felt cohesive.",
      needsFollowUp: false,
      programAudit: { ok: true, issueCount: 0 },
      programContinuity: {
        ok: true,
        startedSessionId: "startup_test",
        completedSessionId: "startup_test",
      },
      programSnapshot: {
        sessionId: "startup_test",
        title: "Night Flow",
        tracks: [
          { id: "1", name: "Song A", artist: "Artist A", source: "local_library", duration: 240000 },
        ],
      },
    });
    expect(state.listenChecks[0].id).toBe(record.id);
  });
});
