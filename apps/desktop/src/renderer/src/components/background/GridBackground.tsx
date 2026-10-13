/*
 * Home backdrop: a square grid drawn on a canvas that drifts slowly on the
 * diagonal. The cell under the pointer lights up in the hover colour and fades
 * out after the pointer leaves. Edge to edge (no vignette).
 * Reduced motion draws a still grid; `paused` and an off-screen canvas stop the
 * animation loop entirely.
 */
import { useEffect, useRef } from "react";

export type GridBackgroundProps = {
  lineColor: string;
  hoverColor: string;
  /** Pixels per frame (~60fps) along each axis. */
  speed?: number;
  cellSize?: number;
  paused?: boolean;
};

const HOVER_DECAY = 0.06;

/**
 * One frame of the hover trail: the cell under the pointer (if any) is set to
 * full intensity; every other lit cell decays and is dropped at zero.
 */
export function stepLitCells(
  lit: Map<string, number>,
  current: string | null,
  decay = HOVER_DECAY,
) {
  for (const [key, value] of lit) {
    if (key === current) continue;
    const next = value - decay;
    if (next <= 0) lit.delete(key);
    else lit.set(key, next);
  }
  if (current) lit.set(current, 1);
}

export function GridBackground({
  lineColor,
  hoverColor,
  speed = 0.3,
  cellSize = 40,
  paused = false,
}: GridBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef({ lineColor, hoverColor, speed, cellSize });
  live.current = { lineColor, hoverColor, speed, cellSize };

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return undefined;

    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let width = 0;
    let height = 0;
    let offset = 0;
    let frame = 0;
    let visible = true;
    let pointer: { x: number; y: number } | null = null;
    // Lit cells keyed by "col:row" in grid space, value = intensity 0..1.
    const lit = new Map<string, number>();

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const draw = () => {
      const { lineColor: line, hoverColor: hover, cellSize: size } = live.current;
      ctx.clearRect(0, 0, width, height);
      const shift = offset % size;

      const current = pointer
        ? `${Math.floor((pointer.x + shift) / size)}:${Math.floor((pointer.y + shift) / size)}`
        : null;
      ctx.fillStyle = hover;
      for (const [key, value] of lit) {
        const [col = 0, row = 0] = key.split(":").map(Number);
        ctx.globalAlpha = value;
        ctx.fillRect(col * size - shift, row * size - shift, size, size);
      }
      stepLitCells(lit, current);
      ctx.globalAlpha = 1;

      ctx.strokeStyle = line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = -shift; x <= width + size; x += size) {
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, height);
      }
      for (let y = -shift; y <= height + size; y += size) {
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(width, Math.round(y) + 0.5);
      }
      ctx.stroke();
    };

    const tick = () => {
      frame = 0;
      if (!still && !paused) offset += live.current.speed;
      draw();
      schedule();
    };
    // Still (reduced motion or paused) the grid does not drift, but the loop
    // keeps running while hover cells are fading so the trail still clears.
    const moving = () => !still && !paused;
    const fading = () => lit.size > 1 || (lit.size === 1 && !pointer);
    const schedule = () => {
      if (!frame && visible && (moving() || fading())) frame = requestAnimationFrame(tick);
    };

    const onMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      if (!moving()) {
        draw();
        schedule();
      }
    };
    const onLeave = () => {
      pointer = null;
      schedule();
    };

    resize();
    draw();
    const resizeObserver = new ResizeObserver(() => {
      resize();
      draw();
    });
    resizeObserver.observe(canvas);
    const io =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver(([entry]) => {
            visible = entry?.isIntersecting ?? true;
            if (visible) schedule();
            else if (frame) {
              cancelAnimationFrame(frame);
              frame = 0;
            }
          });
    io?.observe(canvas);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    schedule();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      io?.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
    };
  }, [paused]);

  return <canvas className="block size-full" ref={canvasRef} />;
}
