import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import type { AudioEffectMode, LayoutMode, ThemeMode } from "../types";

interface LayoutContextValue {
  mode: LayoutMode;
  theme: ThemeMode;
  audioEffect: AudioEffectMode;
  isCompactLayout: boolean;
  setMode: (mode: LayoutMode) => void;
  setTheme: (theme: ThemeMode) => void;
  setAudioEffect: (effect: AudioEffectMode) => void;
  togglePlayerFullscreen: () => void;
  toggleChatFullscreen: () => void;
  toggleSplit: () => void;
}

const LayoutContext = createContext<LayoutContextValue | null>(null);

export function useLayout(): LayoutContextValue {
  const ctx = useContext(LayoutContext);
  if (!ctx) throw new Error("useLayout must be used within LayoutManager");
  return ctx;
}

interface LayoutManagerProps {
  children: ReactNode;
}

const COMPACT_LAYOUT_QUERY = "(max-width: 899px)";

const getCompactLayoutState = () => {
  if (typeof window === "undefined" || !("matchMedia" in window)) return false;
  return window.matchMedia(COMPACT_LAYOUT_QUERY).matches;
};

export function LayoutManager({ children }: LayoutManagerProps) {
  const [mode, setMode] = useState<LayoutMode>("split");
  const [isCompactLayout, setIsCompactLayout] = useState(getCompactLayoutState);
  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") return "dark";
    const stored = window.localStorage.getItem("claudio-theme");
    return stored === "light" ? "light" : "dark";
  });
  const [audioEffect, setAudioEffect] = useState<AudioEffectMode>(() => {
    if (typeof window === "undefined") return "wave";
    const stored = window.localStorage.getItem("claudio-audio-effect");
    return stored === "border-pulse" ? "border-pulse" : "wave";
  });

  const togglePlayerFullscreen = useCallback(() => {
    setMode((prev) => (prev === "player-fullscreen" ? "split" : "player-fullscreen"));
  }, []);

  const toggleChatFullscreen = useCallback(() => {
    setMode((prev) => (prev === "chat-fullscreen" ? "split" : "chat-fullscreen"));
  }, []);

  const toggleSplit = useCallback(() => {
    setMode("split");
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !("matchMedia" in window)) return;

    const mediaQuery = window.matchMedia(COMPACT_LAYOUT_QUERY);
    const handleChange = () => setIsCompactLayout(mediaQuery.matches);

    handleChange();

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("claudio-theme", theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.audioEffect = audioEffect;
    window.localStorage.setItem("claudio-audio-effect", audioEffect);
  }, [audioEffect]);

  return (
    <LayoutContext.Provider
      value={{
        mode,
        theme,
        audioEffect,
        isCompactLayout,
        setMode,
        setTheme,
        setAudioEffect,
        togglePlayerFullscreen,
        toggleChatFullscreen,
        toggleSplit,
      }}
    >
      {children}
    </LayoutContext.Provider>
  );
}
