// The single playback clock (co-owned by Persons B and C).
//
// The <video> element is the master. Each time it actually presents a frame, requestVideoFrameCallback
// tells us that frame's timestamp, so the frame number shown by the overlay, the 3D scene and the
// metrics is exactly the frame on screen (HTMLMediaElement.currentTime alone isn't frame-accurate).
//
// React components read it with useSyncExternalStore(clock.subscribe, clock.getSnapshot).
// The 3D render loop (60 fps) should instead call clock.timeAt(performance.now()) every frame;
// that interpolates between video frames without causing React re-renders.

export interface ClockSnapshot {
  /** Frame currently on screen. */
  frame: number;
  /** frame / fps, in seconds. */
  t: number;
  playing: boolean;
  /** True once the video has a decoded frame to show. */
  ready: boolean;
}

type Listener = () => void;

export class VideoClock {
  private video: HTMLVideoElement | null = null;
  private fps = 25;
  private frameCount = 1;
  private snapshot: ClockSnapshot = { frame: 0, t: 0, playing: false, ready: false };
  private listeners = new Set<Listener>();
  private detachVideo: (() => void) | null = null;
  // Last presented frame's media time and when it was presented, for timeAt().
  private lastMediaTime = 0;
  private lastPresentedAt = 0;
  // Target of a seek that hasn't been presented yet, so fast repeated steps accumulate (500 -> 501 -> 502 ...).
  private pendingFrame: number | null = null;

  attach(video: HTMLVideoElement, fps: number, frameCount: number): void {
    this.detach();
    this.video = video;
    this.fps = fps;
    this.frameCount = Math.max(1, frameCount);

    const onPlay = () => {
      this.pendingFrame = null;
      this.update({ playing: true });
    };
    const onPause = () => this.update({ playing: false });
    // Fallback for browsers that don't fire requestVideoFrameCallback after a seek while paused.
    // "seeked" fires only for the latest seek, so whatever is pending has now landed.
    const onSeeked = () => {
      this.pendingFrame = null;
      this.present(this.frameFromTime(video.currentTime), video.currentTime);
    };
    const onLoaded = () => {
      this.update({ ready: true });
      this.present(this.frameFromTime(video.currentTime), video.currentTime);
    };
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onPause);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("loadeddata", onLoaded);

    let rvfcHandle = 0;
    let rafHandle = 0;
    // Feature check without `in`, which would narrow `video` to never in the fallback branch.
    const hasFrameCallback =
      typeof (video as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback === "function";
    if (hasFrameCallback) {
      const onFrame: VideoFrameRequestCallback = (now, meta) => {
        this.present(this.frameFromPts(meta.mediaTime), meta.mediaTime, now);
        rvfcHandle = video.requestVideoFrameCallback(onFrame);
      };
      rvfcHandle = video.requestVideoFrameCallback(onFrame);
    } else {
      const poll = () => {
        this.present(this.frameFromTime(video.currentTime), video.currentTime);
        rafHandle = requestAnimationFrame(poll);
      };
      rafHandle = requestAnimationFrame(poll);
    }

    this.detachVideo = () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onPause);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("loadeddata", onLoaded);
      if (rvfcHandle) video.cancelVideoFrameCallback(rvfcHandle);
      if (rafHandle) cancelAnimationFrame(rafHandle);
    };

    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) onLoaded();
  }

  detach(): void {
    this.detachVideo?.();
    this.detachVideo = null;
    this.video = null;
    this.pendingFrame = null;
    this.update({ frame: 0, t: 0, playing: false, ready: false });
  }

  // Arrow properties so they can be passed straight to useSyncExternalStore.
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ClockSnapshot => this.snapshot;

  get framesPerSecond(): number {
    return this.fps;
  }

  get totalFrames(): number {
    return this.frameCount;
  }

  /**
   * Smooth media time for 60 fps rendering: while playing, extrapolates from the last presented
   * frame (capped at one frame ahead); while paused, it is exactly the frame on screen.
   */
  timeAt(perfNow: number): number {
    if (!this.snapshot.playing || !this.video) return this.snapshot.t;
    const elapsed = ((perfNow - this.lastPresentedAt) / 1000) * this.video.playbackRate;
    return this.lastMediaTime + Math.min(Math.max(elapsed, 0), 1 / this.fps);
  }

  play(): void {
    void this.video?.play();
  }

  pause(): void {
    this.video?.pause();
  }

  toggle(): void {
    if (!this.video) return;
    if (this.video.paused) this.play();
    else this.pause();
  }

  /** Slow-motion for manual counting (e.g. 0.5); timeAt() already accounts for the rate. */
  setPlaybackRate(rate: number): void {
    if (this.video) this.video.playbackRate = rate;
  }

  /** Seeks to the middle of the frame's display interval, so float rounding can't land on the previous frame. */
  seekToFrame(frame: number): void {
    if (!this.video) return;
    const clamped = Math.min(Math.max(Math.round(frame), 0), this.frameCount - 1);
    this.pendingFrame = clamped;
    this.video.currentTime = (clamped + 0.5) / this.fps;
  }

  seekToTime(seconds: number): void {
    this.seekToFrame(this.frameFromTime(seconds));
  }

  /** Pauses and moves by whole frames (negative = backwards). */
  step(frames: number): void {
    this.pause();
    this.seekToFrame((this.pendingFrame ?? this.snapshot.frame) + frames);
  }

  /** Frame whose presentation timestamp is `pts` (CFR video starting at 0, see docs/schema.md). */
  private frameFromPts(pts: number): number {
    return Math.round(pts * this.fps);
  }

  /** Frame on screen at an arbitrary media time inside its display interval. */
  private frameFromTime(time: number): number {
    return Math.floor(time * this.fps + 1e-3);
  }

  private present(frame: number, mediaTime: number, presentedAt = performance.now()): void {
    this.lastMediaTime = mediaTime;
    this.lastPresentedAt = presentedAt;
    const clamped = Math.min(Math.max(frame, 0), this.frameCount - 1);
    if (clamped === this.pendingFrame) this.pendingFrame = null;
    this.update({ frame: clamped, t: clamped / this.fps });
  }

  private update(patch: Partial<ClockSnapshot>): void {
    const next = { ...this.snapshot, ...patch };
    const s = this.snapshot;
    if (next.frame === s.frame && next.t === s.t && next.playing === s.playing && next.ready === s.ready) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

/** The app's one clock. Scene3D (Person B) imports this same instance. */
export const clock = new VideoClock();
