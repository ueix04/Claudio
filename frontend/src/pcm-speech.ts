const SAMPLE_RATE = 24_000;
const START_BUFFER_SECONDS = 0.08;

export class PcmSpeechPlayer {
  private readonly sources = new Set<AudioBufferSourceNode>();
  private nextStart = 0;
  private complete = false;

  constructor(private readonly context: AudioContext, private readonly onEnd: () => void) {}

  append(base64: string): boolean {
    if (this.complete || this.context.state !== "running") return false;

    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    if (!bytes.length || bytes.length % 2 !== 0) return false;

    const pcm = new DataView(bytes.buffer);
    const buffer = this.context.createBuffer(1, bytes.length / 2, SAMPLE_RATE);
    const samples = buffer.getChannelData(0);
    for (let index = 0; index < samples.length; index++) {
      samples[index] = pcm.getInt16(index * 2, true) / 32768;
    }

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    source.onended = () => {
      source.disconnect();
      this.sources.delete(source);
      if (this.complete && this.sources.size === 0) this.onEnd();
    };

    const now = this.context.currentTime;
    const start = this.nextStart > now ? this.nextStart : now + START_BUFFER_SECONDS;
    source.start(start);
    this.sources.add(source);
    this.nextStart = start + buffer.duration;
    return true;
  }

  finish(): void {
    this.complete = true;
    if (this.sources.size === 0) this.onEnd();
  }

  cancel(): void {
    this.complete = true;
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
  }
}
