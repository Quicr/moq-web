/**
 * Paints incoming VideoFrames onto a canvas. Frames are closed after each
 * draw so we don't leak GPU memory. When frames arrive faster than
 * requestAnimationFrame, only the latest is kept.
 */
export class VideoPainter {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private pending: VideoFrame | null = null;
  private raf: number | null = null;
  private frameCount = 0;
  private lastReset = performance.now();
  private fps = 0;

  attach(canvas: HTMLCanvasElement | null): void {
    if (this.canvas === canvas) return;
    this.canvas = canvas;
    this.ctx = canvas?.getContext('2d') ?? null;
  }

  push(frame: VideoFrame): void {
    if (this.pending) this.pending.close();
    this.pending = frame;
    if (this.raf === null) {
      this.raf = requestAnimationFrame(() => this.render());
    }
  }

  currentFps(): number {
    return this.fps;
  }

  dispose(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.pending?.close();
    this.pending = null;
    this.canvas = null;
    this.ctx = null;
  }

  private render(): void {
    this.raf = null;
    const frame = this.pending;
    this.pending = null;
    if (!frame) return;
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (canvas && ctx) {
      if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
      if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      this.frameCount++;
      const now = performance.now();
      const elapsed = now - this.lastReset;
      if (elapsed >= 1000) {
        this.fps = Math.round((this.frameCount * 1000) / elapsed);
        this.frameCount = 0;
        this.lastReset = now;
      }
    }
    frame.close();
  }
}
