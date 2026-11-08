import { VideoConfig } from '../types';

type BgSource = HTMLImageElement | HTMLVideoElement;

/** Duration of the crossfade that hides the loop seam, in ms. */
export const LOOP_BLEND_MS = 350;

export interface LoopBlend {
  snapshot: HTMLCanvasElement | null;
  start: number;
}

export function createLoopBlend(): LoopBlend {
  return { snapshot: null, start: 0 };
}

function sourceSize(src: BgSource): { w: number; h: number } {
  if (src instanceof HTMLVideoElement) {
    return { w: src.videoWidth, h: src.videoHeight };
  }
  return { w: (src as HTMLImageElement).naturalWidth || src.width, h: (src as HTMLImageElement).naturalHeight || src.height };
}

/** Draw source with cover-fit (fill + crop), honoring X/Y position. */
function drawCover(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  src: BgSource,
  config: VideoConfig
) {
  const { w: sw, h: sh } = sourceSize(src);
  if (!sw || !sh) return;

  const scale = Math.max(canvas.width / sw, canvas.height / sh);
  const scaledWidth = sw * scale;
  const scaledHeight = sh * scale;

  const posX = config.backgroundImageX ?? 50;
  const x = (canvas.width - scaledWidth) * (posX / 100);

  const posY = config.backgroundImageY ?? 50;
  const y = (canvas.height - scaledHeight) * (posY / 100);

  ctx.drawImage(src, x, y, scaledWidth, scaledHeight);
}

/** Draw source with contain-fit (fit inside, letterboxed), centered. */
function drawContain(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  src: BgSource
) {
  const { w: sw, h: sh } = sourceSize(src);
  if (!sw || !sh) return;

  const scale = Math.min(canvas.width / sw, canvas.height / sh);
  const scaledWidth = sw * scale;
  const scaledHeight = sh * scale;
  const x = (canvas.width - scaledWidth) / 2;
  const y = (canvas.height - scaledHeight) / 2;

  ctx.drawImage(src, x, y, scaledWidth, scaledHeight);
}

// ---------------------------------------------------------------------------
// Blurred backdrop cache.
// ctx.filter blur on a full-HD canvas every frame is very expensive and is
// the main cause of choppy background video. Render the blur once at low
// resolution, cache it, and only re-render when the video frame advances.
// ---------------------------------------------------------------------------

interface BlurEntry {
  w: number;
  h: number;
  time: number;
  canvas: HTMLCanvasElement;
}

const blurCache = new WeakMap<object, BlurEntry>();

function getBlurredBackdrop(src: BgSource, canvasW: number, canvasH: number): HTMLCanvasElement | null {
  const isVideo = src instanceof HTMLVideoElement;
  const time = isVideo ? (src as HTMLVideoElement).currentTime : 0;

  const cached = blurCache.get(src);
  if (
    cached &&
    cached.w === canvasW &&
    cached.h === canvasH &&
    (!isVideo || Math.abs(cached.time - time) < 1 / 120)
  ) {
    return cached.canvas;
  }

  const sw = 320;
  const sh = Math.max(1, Math.round((sw * canvasH) / canvasW));
  const small = cached?.canvas ?? document.createElement('canvas');
  small.width = sw;
  small.height = sh;
  const sctx = small.getContext('2d');
  if (!sctx) return null;

  const { w, h } = sourceSize(src);
  if (!w || !h) return cached?.canvas ?? null;

  sctx.clearRect(0, 0, sw, sh);
  sctx.save();
  try {
    (sctx as any).filter = 'blur(20px) brightness(0.6)';
  } catch {
    /* ctx.filter unsupported — falls back to unfiltered cover */
  }
  const scale = Math.max(sw / w, sh / h);
  const dw = w * scale;
  const dh = h * scale;
  sctx.drawImage(src, (sw - dw) / 2, (sh - dh) / 2, dw, dh);
  sctx.restore();

  blurCache.set(src, { w: canvasW, h: canvasH, time, canvas: small });
  return small;
}

// ---------------------------------------------------------------------------
// Background video helpers
// ---------------------------------------------------------------------------

/**
 * Hard mute guard: the background video must never produce sound.
 * The element is created muted, but some browsers discard the muted flag
 * when `src` is assigned afterwards — re-enforce every frame (cheap).
 */
export function enforceBackgroundMute(video: HTMLVideoElement) {
  if (!video.muted) video.muted = true;
  if (video.volume !== 0) video.volume = 0;
}

const lastPlayAttempt = new WeakMap<HTMLVideoElement, number>();

/** Browsers may pause offscreen media; nudge it back to playing (throttled). */
export function ensureVideoPlaying(video: HTMLVideoElement) {
  if (!video.paused || video.ended || video.seeking || video.readyState < 2) return;
  const now = performance.now();
  if (now - (lastPlayAttempt.get(video) ?? 0) < 500) return;
  lastPlayAttempt.set(video, now);
  video.play().catch(() => { /* retry on next frames */ });
}

/**
 * Manual seamless loop. Native `loop=true` restarts with a black-frame
 * flash on some browsers/encodings, which reads as a "rough" jump.
 * Instead we restart just before the end and snapshot the current canvas
 * so the caller can crossfade into the fresh loop over LOOP_BLEND_MS.
 */
export function maybeRestartVideoForSeamlessLoop(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  blend: LoopBlend
) {
  const duration = video.duration;
  if (!duration || Number.isNaN(duration) || !Number.isFinite(duration)) return;
  if (video.seeking) return;

  const nearEnd = video.ended || video.currentTime >= duration - 0.08;
  if (!nearEnd) return;

  try {
    if (!blend.snapshot) {
      blend.snapshot = document.createElement('canvas');
    }
    if (blend.snapshot.width !== canvas.width || blend.snapshot.height !== canvas.height) {
      blend.snapshot.width = canvas.width;
      blend.snapshot.height = canvas.height;
    }
    blend.snapshot.getContext('2d')?.drawImage(canvas, 0, 0);
    blend.start = performance.now();
  } catch {
    blend.snapshot = null;
  }

  try {
    video.currentTime = 0;
    video.play().catch(() => { /* ensureVideoPlaying retries */ });
  } catch {
    /* ignore */
  }
}

/**
 * Paint the fading snapshot captured at the loop point.
 * Call AFTER the rest of the scene (background + text) is drawn.
 */
export function paintLoopBlend(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  blend: LoopBlend
) {
  if (!blend.snapshot) return;
  const t = (performance.now() - blend.start) / LOOP_BLEND_MS;
  if (t >= 1) {
    blend.snapshot = null;
    return;
  }
  ctx.save();
  ctx.globalAlpha = 1 - t;
  ctx.drawImage(blend.snapshot, 0, 0, canvas.width, canvas.height);
  ctx.restore();
}

/**
 * Paint the canvas background from an image or video source.
 * Supports cover (default), contain, and blur (blurred cover + sharp contain).
 * Always applies the dim overlay on top.
 */
export function drawBackground(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  config: VideoConfig,
  source: BgSource | null
) {
  const fit = config.backgroundVideoFit ?? 'cover';

  // Base fill so letterbox areas / load gaps are never transparent
  ctx.fillStyle = config.backgroundColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!source) {
    return;
  }

  // For video sources, skip frames until real dimensions are known
  if (source instanceof HTMLVideoElement) {
    if (source.readyState < 2 || !source.videoWidth || !source.videoHeight) return;
  }

  if (fit === 'blur') {
    // Blurred cover as backdrop (cached low-res — cheap even for video)
    const blurred = getBlurredBackdrop(source, canvas.width, canvas.height);
    if (blurred) {
      ctx.drawImage(blurred, 0, 0, canvas.width, canvas.height);
    } else {
      drawCover(ctx, canvas, source, { ...config, backgroundImageX: 50, backgroundImageY: 50 });
    }
    // Sharp contain on top
    drawContain(ctx, canvas, source);
  } else if (fit === 'contain') {
    drawContain(ctx, canvas, source);
  } else {
    drawCover(ctx, canvas, source, config);
  }

  // Dim overlay
  ctx.fillStyle = `rgba(0,0,0,${config.backgroundImageOpacity})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}
