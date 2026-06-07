import React, { useState, useRef, useEffect } from 'react';
import { ChatEntry, DJMessage, AppStatus, TrackInfo, TtsPreset } from '../types';
import { useLayout } from './LayoutManager';

const USER_DISPLAY_NAME = "xian";

interface ChatPanelProps {
  messages: ChatEntry[];
  djMessages: DJMessage[];
  status: AppStatus;
  isConnected: boolean;
  djName: string;
  djStatus: "live" | "offline";
  voicePreset: TtsPreset;
  isUpdatingVoicePreset: boolean;
  userAvatarUrl: string | null;
  onSendMessage: (text: string) => void;
  onReplayAudio: (messageId: string) => void;
  onVoicePresetChange: (preset: TtsPreset) => void;
  onVoiceAction: () => void;
  onFullscreenToggle: () => void;
  isFullscreen: boolean;
  subtitle: string;
  statusText: string;
  currentTrack: TrackInfo | null;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({
  messages,
  djMessages,
  status,
  isConnected,
  djName,
  djStatus,
  voicePreset,
  isUpdatingVoicePreset,
  userAvatarUrl,
  onSendMessage,
  onReplayAudio,
  onVoicePresetChange,
  onVoiceAction,
  onFullscreenToggle,
  isFullscreen,
  subtitle,
  statusText,
  currentTrack,
}) => {
  const [inputText, setInputText] = useState("");
  const [voiceHint, setVoiceHint] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { toggleChatFullscreen } = useLayout();

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, djMessages]);

  const handleSend = () => {
    if (inputText.trim()) {
      onSendMessage(inputText.trim());
      setInputText("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSend();
    }
  };

  const handleVoiceAction = () => {
    onVoiceAction();
    setVoiceHint("Voice input coming soon");
    window.setTimeout(() => setVoiceHint(null), 2200);
  };

  const handleVoicePresetToggle = () => {
    if (isUpdatingVoicePreset) return;
    onVoicePresetChange(voicePreset === "冰糖" ? "Dean" : "冰糖");
  };

  const renderUserAvatar = (sizeClass: string, textClass: string) => (
    <div className={`rounded-full overflow-hidden border border-white/10 bg-[color:var(--claudio-surface-strong)] flex items-center justify-center ${sizeClass}`}>
      {userAvatarUrl ? (
        <img src={userAvatarUrl} alt={USER_DISPLAY_NAME} className="h-full w-full object-cover" />
      ) : (
        <span className={`font-semibold uppercase claudio-theme-text-dim ${textClass}`}>x</span>
      )}
    </div>
  );

  const renderChatClaudioAvatar = () => (
    <div className="w-7 h-7 rounded-full border border-[color:var(--claudio-accent)] flex-shrink-0 flex items-center justify-center claudio-theme-surface">
      <div className="w-2 h-2 rounded-full bg-[color:var(--claudio-accent)]"></div>
    </div>
  );

  const feed = [
    ...messages.map(m => ({ type: 'chat' as const, data: m })),
    ...djMessages.map(m => ({ type: 'dj' as const, data: m }))
  ].sort((a, b) => {
    const tA = typeof a.data.timestamp === 'number' ? a.data.timestamp : 0;
    const tB = typeof b.data.timestamp === 'number' ? b.data.timestamp : 0;
    if (tA !== tB) return tA - tB;
    return a.data.id.localeCompare(b.data.id);
  });

  return (
    <div className="flex flex-col h-full w-full claudio-theme-bg claudio-grid-bg relative claudio-theme-text">
      <header className="flex items-center justify-between p-4 border-b claudio-theme-border flex-shrink-0 bg-[color:var(--claudio-surface)]/70 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-4">
          <div className="flex flex-shrink-0 items-center gap-2">
            <span className="pulse-dot h-2.5 w-2.5 rounded-full bg-[color:var(--claudio-accent)] shadow-[0_0_10px_var(--claudio-neon)]"></span>
            <span className="text-sm tracking-widest claudio-theme-text-strong uppercase">{djName}</span>
          </div>

          {currentTrack ? (
            <div className="chat-header-meta min-w-0 flex items-center gap-2">
              <div className="flex items-end gap-[2px] h-3 w-3 flex-shrink-0">
                <div className="eq-bar w-[2px] bg-[color:var(--claudio-accent)] rounded-t-sm" style={{ height: "40%", animationDuration: "0.5s" }}></div>
                <div className="eq-bar w-[2px] bg-[color:var(--claudio-accent)] rounded-t-sm" style={{ height: "80%", animationDuration: "0.7s" }}></div>
                <div className="eq-bar w-[2px] bg-[color:var(--claudio-accent)] rounded-t-sm" style={{ height: "60%", animationDuration: "0.6s" }}></div>
              </div>
              <span className="truncate text-[11px] tracking-[0.14em] uppercase claudio-theme-text-dim">
                Now Playing: {currentTrack.title} - {currentTrack.artist}
              </span>
            </div>
          ) : (status === "thinking" || status === "speaking") && (
            <div className="chat-header-meta min-w-0 flex items-center gap-2">
              {status === "thinking" ? (
                <div className="thinking-spinner"></div>
              ) : (
                <div className="speaking-pulse"></div>
              )}
              <span className={`truncate text-xs ${status === "thinking" ? "claudio-theme-text-dim" : "claudio-theme-accent"}`}>
                {statusText}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          {djStatus === 'live' && (
            <div className="flex items-center gap-2">
              <span className="text-sm claudio-theme-accent uppercase tracking-widest">LIVE</span>
              <span className="text-sm claudio-theme-accent">·</span>
              <button
                onClick={handleVoicePresetToggle}
                disabled={isUpdatingVoicePreset}
                className={`chat-voice-switch ${isUpdatingVoicePreset ? "chat-voice-switch-pending" : ""}`}
                title={`Switch voice preset from ${voicePreset}`}
              >
                {voicePreset}
              </button>
            </div>
          )}
          <button 
            onClick={toggleChatFullscreen}
            className="claudio-theme-text-dim hover:text-[color:var(--claudio-text-strong)] transition-colors focus:outline-none"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {isFullscreen ? (
                <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
              ) : (
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
              )}
            </svg>
          </button>
        </div>
      </header>

      <div 
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6 claudio-scrollbar relative"
      >
        {feed.length === 0 ? (
          <div className="h-full flex items-center justify-center claudio-theme-text-muted text-sm">
            No messages yet — say hello to the DJ
          </div>
        ) : (
          feed.map((item) => {
            if (item.type === 'chat') {
              const msg = item.data as ChatEntry;
              if (msg.role === 'user') {
                return (
                  <div key={msg.id} className="flex flex-col items-end mb-6">
                    <span className="text-[10px] claudio-theme-text-muted mb-1 mr-11 tracking-wider uppercase">{msg.sender || USER_DISPLAY_NAME}</span>
                    <div className="flex items-start justify-end w-full">
                      <div className="msg-bubble claudio-theme-surface border claudio-theme-border rounded-[16px] rounded-tr-sm px-4 py-3 max-w-[80%] claudio-theme-text-strong text-sm shadow-sm backdrop-blur-sm mr-2">
                        {msg.text}
                      </div>
                      {renderUserAvatar("w-7 h-7 flex-shrink-0", "text-[11px]")}
                    </div>
                    <span className="text-[10px] claudio-theme-text-muted mt-1 mr-11">{msg.time}</span>
                  </div>
                );
              } else {
                return (
                  <div key={msg.id} className="flex flex-col items-start mb-6">
                    <span className="text-[10px] claudio-theme-text-muted mb-1 ml-11 tracking-wider uppercase">{msg.sender || "CLAUDIO"}</span>
                    <div className="flex items-start justify-start w-full">
                      <div className="mr-2">
                        {renderChatClaudioAvatar()}
                      </div>
                      <div className="msg-bubble-dj border claudio-theme-border rounded-[16px] rounded-tl-sm px-4 py-3 max-w-[80%] claudio-theme-text-strong text-sm shadow-sm backdrop-blur-sm relative flex items-center">
                        {msg.audioUrl && (
                          <button onClick={() => onReplayAudio(msg.id)} className="mr-3 claudio-theme-text-strong hover:text-[color:var(--claudio-accent)] transition-colors focus:outline-none flex-shrink-0">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M8 5v14l11-7z" />
                            </svg>
                          </button>
                        )}
                        <span>{msg.text}</span>
                      </div>
                    </div>
                    <span className="text-[10px] claudio-theme-text-muted mt-1 ml-11">{msg.time}</span>
                  </div>
                );
              }
            } else {
              const djMsg = item.data as DJMessage;
              return (
                <div key={djMsg.id} className="flex flex-col items-start mb-8 w-full max-w-3xl mx-auto">
                  <div className="flex items-center space-x-2 mb-2">
                    {renderChatClaudioAvatar()}
                    <span className="text-xs claudio-theme-text-dim tracking-wider uppercase">{djMsg.sender || "CLAUDIO"}</span>
                  </div>
                  <div className="w-full claudio-theme-surface-strong border claudio-theme-border rounded-[20px] p-5 flex flex-col shadow-lg backdrop-blur-md">
                    <div className="claudio-theme-text-strong text-sm leading-relaxed space-y-4 opacity-90">
                      {djMsg.text.split('\n').map((paragraph, idx) => (
                        <p key={idx}>{paragraph}</p>
                      ))}
                    </div>
                    {djMsg.hasAudio && (
                      <button 
                        onClick={() => onReplayAudio(djMsg.id)}
                        className="mt-4 self-start flex items-center space-x-2 claudio-theme-surface text-[color:var(--claudio-text-strong)] text-xs px-3 py-1.5 rounded-full cursor-pointer transition-colors focus:outline-none border claudio-theme-border"
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M8 5v14l11-7z" />
                        </svg>
                        <span>REPLAY</span>
                      </button>
                    )}
                  </div>
                  <span className="text-[10px] claudio-theme-text-muted mt-2 ml-1">{djMsg.time}</span>
                </div>
              );
            }
          })
        )}
      </div>

      {subtitle && (
        <div className="absolute bottom-[88px] left-0 right-0 flex justify-center pointer-events-none px-4 z-10">
          <div 
            className="subtitle-overlay text-xl md:text-2xl font-bold text-white text-center tracking-wide" 
            style={{ textShadow: '0 2px 4px rgba(0,0,0,0.8), 0 0 10px rgba(0,0,0,0.5)' }}
          >
            {subtitle}
          </div>
        </div>
      )}

      <div className="claudio-bottom-bar flex h-[72px] flex-shrink-0 items-center justify-between border-t claudio-theme-border p-3 md:p-4 relative z-20">
        <div className="text-[10px] claudio-theme-text-muted w-24 tracking-widest uppercase">
          CLAUDIO FM
        </div>
        
        <div className="flex-1 flex items-center max-w-2xl mx-auto space-x-3 px-2">
          <input 
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Say something to the DJ..."
            className="flex-1 border claudio-theme-border rounded-full px-4 py-2 text-sm claudio-theme-text-strong placeholder-zinc-500 focus:outline-none transition-colors claudio-input"
          />
          <button
            onClick={handleVoiceAction}
            className="w-8 h-8 rounded-full border border-zinc-600 flex items-center justify-center text-zinc-400 hover:text-white hover:border-zinc-400 transition-colors ctrl-btn focus:outline-none flex-shrink-0"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" x2="12" y1="19" y2="22" />
            </svg>
          </button>
          <button 
            onClick={handleSend}
            disabled={!inputText.trim()}
            className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ctrl-btn focus:outline-none flex-shrink-0 ${inputText.trim() ? 'bg-[#e4e4e7] text-black hover:bg-white' : 'bg-[#2a2a35] text-zinc-500 cursor-not-allowed'}`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          </button>
        </div>

        <div className="flex items-center justify-end text-[10px] claudio-theme-text-muted w-24 tracking-widest uppercase">
          {isConnected ? (
            <span className="flex items-center">CONNECTED</span>
          ) : (
            <span className="flex items-center">OFFLINE</span>
          )}
        </div>
      </div>

      {voiceHint && (
        <div className="px-4 pb-3">
          <div className="mx-auto max-w-2xl rounded-full border claudio-theme-border claudio-theme-surface px-4 py-2 text-center text-[10px] uppercase tracking-[0.18em] claudio-theme-accent">
            {voiceHint}
          </div>
        </div>
      )}
    </div>
  );
};
