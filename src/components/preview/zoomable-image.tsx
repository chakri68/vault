"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, type Ref } from "react";

export interface ZoomHandle {
  /** toggles between fitted and zoomed in, about the centre */
  toggle: () => void;
}

const MAX = 6;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SCALE = 2.5;

/**
 * Pinch, double-tap and drag, on pointer events. The transform is written
 * straight to the element: a pinch fires far too often to go through React.
 */
export function ZoomableImage({ src, alt, handle, onZoomChange, onSwipeDown }: {
  src: string;
  alt: string;
  handle?: Ref<ZoomHandle>;
  onZoomChange?: (zoomed: boolean) => void;
  /** two fingers, downwards, while not zoomed: the gesture for "close" */
  onSwipeDown?: () => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const t = useRef({ scale: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ distance: number; scale: number; midY: number; travelled: number } | null>(null);
  const lastTap = useRef({ time: 0, x: 0, y: 0 });
  const moved = useRef(false);

  const apply = useCallback((animate = false) => {
    const el = img.current, box = frame.current;
    if (!el || !box) return;
    const s = t.current;
    // keep the picture from being dragged off the screen
    const maxX = Math.max(0, (el.clientWidth * s.scale - box.clientWidth) / 2);
    const maxY = Math.max(0, (el.clientHeight * s.scale - box.clientHeight) / 2);
    s.x = Math.min(maxX, Math.max(-maxX, s.x));
    s.y = Math.min(maxY, Math.max(-maxY, s.y));
    el.style.transition = animate ? "transform 200ms cubic-bezier(.2,.8,.2,1)" : "none";
    el.style.transform = `translate3d(${s.x}px, ${s.y}px, 0) scale(${s.scale})`;
    onZoomChange?.(s.scale > 1.01);
  }, [onZoomChange]);

  /** zoom to `scale`, keeping the point under (cx, cy) where it is */
  const zoomAt = useCallback((scale: number, cx: number, cy: number, animate = false) => {
    const box = frame.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const px = cx - rect.left - rect.width / 2;
    const py = cy - rect.top - rect.height / 2;
    const s = t.current;
    const next = Math.min(MAX, Math.max(1, scale));
    const ratio = next / s.scale;
    s.x = px - (px - s.x) * ratio;
    s.y = py - (py - s.y) * ratio;
    s.scale = next;
    if (next === 1) { s.x = 0; s.y = 0; }
    apply(animate);
  }, [apply]);

  const toggleAt = useCallback((cx: number, cy: number) => {
    zoomAt(t.current.scale > 1.01 ? 1 : DOUBLE_TAP_SCALE, cx, cy, true);
  }, [zoomAt]);

  useImperativeHandle(handle, () => ({
    toggle: () => {
      const rect = frame.current?.getBoundingClientRect();
      if (rect) toggleAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
    },
  }), [toggleAt]);

  // ctrl/⌘ + wheel (and trackpad pinch, which arrives as the same thing) on desktop
  useEffect(() => {
    const box = frame.current;
    if (!box) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey && t.current.scale <= 1.01) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) zoomAt(t.current.scale * Math.exp(-e.deltaY / 200), e.clientX, e.clientY);
      else {
        t.current.x -= e.deltaX;
        t.current.y -= e.deltaY;
        apply();
      }
    };
    box.addEventListener("wheel", wheel, { passive: false });
    const resize = () => apply();
    window.addEventListener("resize", resize);
    return () => {
      box.removeEventListener("wheel", wheel);
      window.removeEventListener("resize", resize);
    };
  }, [zoomAt, apply]);

  const spread = () => {
    const [a, b] = [...pointers.current.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
  };

  return (
    <div
      ref={frame}
      className="relative size-full touch-none overflow-hidden select-none"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        moved.current = false;
        if (pointers.current.size === 2) {
          const s = spread();
          gesture.current = { distance: s.distance, scale: t.current.scale, midY: s.midY, travelled: 0 };
        }
      }}
      onPointerMove={(e) => {
        const prev = pointers.current.get(e.pointerId);
        if (!prev) return;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (Math.hypot(e.clientX - prev.x, e.clientY - prev.y) > 2) moved.current = true;
        if (pointers.current.size === 2 && gesture.current) {
          const s = spread();
          gesture.current.travelled = s.midY - gesture.current.midY;
          zoomAt(gesture.current.scale * (s.distance / gesture.current.distance), s.midX, s.midY);
        } else if (pointers.current.size === 1 && t.current.scale > 1.01) {
          t.current.x += e.clientX - prev.x;
          t.current.y += e.clientY - prev.y;
          apply();
        }
      }}
      onPointerUp={(e) => {
        const wasPinch = pointers.current.size === 2;
        pointers.current.delete(e.pointerId);
        if (wasPinch) {
          const g = gesture.current;
          gesture.current = null;
          if (g && g.scale <= 1.01 && t.current.scale <= 1.15 && g.travelled > 120) onSwipeDown?.();
          if (t.current.scale < 1.05) zoomAt(1, e.clientX, e.clientY, true);
          return;
        }
        if (moved.current) return;
        const now = performance.now();
        const near = Math.hypot(e.clientX - lastTap.current.x, e.clientY - lastTap.current.y) < 30;
        if (now - lastTap.current.time < DOUBLE_TAP_MS && near) {
          lastTap.current.time = 0;
          toggleAt(e.clientX, e.clientY);
        } else lastTap.current = { time: now, x: e.clientX, y: e.clientY };
      }}
      onPointerCancel={(e) => {
        pointers.current.delete(e.pointerId);
        gesture.current = null;
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- a blob: URL of a decrypted document; it must never reach an image optimiser */}
      <img ref={img} src={src} alt={alt} draggable={false} onLoad={() => apply()}
        className="absolute inset-0 m-auto max-h-full max-w-full origin-center object-contain will-change-transform [-webkit-touch-callout:default]" />
    </div>
  );
}
