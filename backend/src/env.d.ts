declare module "@xnfa/qq-music-api" {
  interface QqMusicApi {
    api(method: string, params: Record<string, unknown>): Promise<unknown>;
    setCookie(cookie: string): void;
  }
  const qqMusic: QqMusicApi;
  export default qqMusic;
}
