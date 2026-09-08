/**
 * Minimal AudioData → AudioContext player. Each AudioData chunk is copied
 * into an AudioBuffer and scheduled tail-to-tail on the context clock so
 * playback stays gap-free while the network provides samples.
 *
 * This is deliberately dumb: no jitter buffer beyond a small lead time.
 * The underlying MediaSession has its own arrival buffer; we just consume.
 */
export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private nextStart = 0;
  private started = false;
  private muted = false;
  private gain: GainNode | null = null;

  ensure(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.muted ? 0 : 1;
      this.gain.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  async resume(): Promise<void> {
    const ctx = this.ensure();
    if (ctx.state === 'suspended') await ctx.resume();
    this.started = true;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.gain) this.gain.gain.value = muted ? 0 : 1;
  }

  push(audio: AudioData): void {
    if (!this.started) {
      audio.close();
      return;
    }
    const ctx = this.ensure();
    const gain = this.gain;
    if (!gain) {
      audio.close();
      return;
    }

    const channels = audio.numberOfChannels;
    const sampleRate = audio.sampleRate;
    const frames = audio.numberOfFrames;

    const buffer = ctx.createBuffer(channels, frames, sampleRate);
    const tmp = new Float32Array(frames);
    for (let c = 0; c < channels; c++) {
      audio.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
      buffer.copyToChannel(tmp, c);
    }
    audio.close();

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(gain);
    const now = ctx.currentTime;
    // Small lead time keeps successive buffers stitched together.
    const start = Math.max(this.nextStart, now + 0.02);
    src.start(start);
    this.nextStart = start + buffer.duration;
  }

  dispose(): void {
    try {
      this.gain?.disconnect();
    } catch {
      // ignore
    }
    void this.ctx?.close();
    this.ctx = null;
    this.gain = null;
    this.nextStart = 0;
    this.started = false;
  }
}
