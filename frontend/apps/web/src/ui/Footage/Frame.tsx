'use client';
// One frame of footage with its finding marked. Shows the backend's JPEG when there is one and falls
// back to a drawn placeholder, so the box, tag and HUD work the same either way. The tag is kept inside
// the frame (above the box, else below, else inside) and HUD readouts it would cover are hidden.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CATEGORY, type Issue } from '@raightway/core';
import { useUi } from '@/state/ui';
import { hit, useSize } from '@/lib/useSize';
import { drawScene } from './scene';

const RING = { survey: 'M50 4C78 3 97 22 96 50S76 97 49 96 3 77 4 49 23 5 54 6', box: 'M10 4H90Q96 4 96 10V90Q96 96 90 96H10Q4 96 4 90V10Q4 4 10 4Z' };
const LIGHT = ['day', 'overcast', 'day', 'dusk', 'day', 'overcast', 'day'] as const;

export interface FrameProps {
  /** The finding to show and box. null shows plain road. */
  issue: Issue | null;
  /** Seeds the placeholder when there is no issue. */
  seed: number;
  src?: string | null;
  /** Child <video> for real playback; when given, the image/placeholder is hidden. */
  video?: ReactNode;
  hud?: { tl?: ReactNode; bl?: ReactNode; br?: ReactNode };
  /** 0..1 zoom drift that suggests forward motion on the placeholder. */
  drift?: number;
  className?: string;
}

export function Frame({ issue, seed, src, video, hud, drift = 0, className }: FrameProps) {
  const box = useRef<HTMLDivElement>(null); const canvas = useRef<HTMLCanvasElement>(null);
  const tag = useRef<HTMLSpanElement>(null); const mark = useRef<HTMLDivElement>(null);
  const { width } = useSize(box); const dir = useUi(s => s.direction);
  // remember which source failed, so a new source gets a fresh try without an effect
  const [failed, setFailed] = useState<string | null>(null);
  const showImg = Boolean(src) && failed !== src && !video;

  // draw the placeholder when the scene, size or source changes
  useEffect(() => {
    const c = canvas.current; if (!c || showImg || video || !width) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1); const W = Math.max(320, Math.round(width * dpr)); const H = Math.round((W * 9) / 16);
    c.width = W; c.height = H; const ctx = c.getContext('2d'); if (!ctx) return;
    const s = issue?.frame_seed ?? seed;
    drawScene(ctx, W, H, issue ? { category: issue.category, seed: s, bbox: issue.bbox, light: LIGHT[s % 7] } : { seed: s, light: LIGHT[s % 7] });
  }, [issue, seed, width, showImg, video]);

  // keep the tag in the frame and off the HUD
  useLayoutEffect(() => {
    const t = tag.current, f = box.current; if (!t || !f) return;
    const fr = f.getBoundingClientRect(); t.style.transform = ''; t.style.maxWidth = `${Math.max(48, fr.width - 12)}px`; t.classList.remove('below', 'inside');
    let r = t.getBoundingClientRect();
    if (r.top < fr.top + 4) { t.classList.add('below'); r = t.getBoundingClientRect(); if (r.bottom > fr.bottom - 4) { t.classList.replace('below', 'inside'); r = t.getBoundingClientRect(); } }
    let dx = 0; if (r.right > fr.right - 6) dx = fr.right - 6 - r.right; if (r.left + dx < fr.left + 6) dx = fr.left + 6 - r.left;
    t.style.transform = `translateX(${dx.toFixed(1)}px)`;
    const tr = { left: r.left + dx, right: r.right + dx, top: r.top, bottom: r.bottom };
    f.querySelectorAll<HTMLElement>('.hud').forEach(h => { h.style.visibility = ''; if (hit(tr, h.getBoundingClientRect(), 3)) h.style.visibility = 'hidden'; });
  });
  // replay the signature draw-in when the finding changes
  useEffect(() => { const m = mark.current; if (!m) return; m.classList.remove('draw'); void m.offsetWidth; m.classList.add('draw'); }, [issue?.id, dir]);

  const b = issue?.bbox;
  return (
    <div ref={box} className={`frame${className ? ` ${className}` : ''}`}>
      {video ?? (showImg
        ? <img src={src!} alt={issue ? `${CATEGORY[issue.category].label}: ${issue.description}` : 'Dashcam frame'} onError={() => setFailed(src ?? null)} />
        : <canvas ref={canvas} aria-hidden="true" style={{ transform: `scale(${(1 + drift * 0.05).toFixed(4)})` }} />)}
      {hud?.tl ? <div className="hud h-tl">{hud.tl}</div> : null}
      {hud?.bl ? <div className="hud h-bl">{hud.bl}</div> : null}
      {hud?.br ? <div className="hud h-br">{hud.br}</div> : null}
      {issue && b ? (
        <div ref={mark} className={`mark${issue.provisional ? ' provisional' : ''}`} style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path className="ring" pathLength={400} d={dir === 'survey' ? RING.survey : RING.box} /></svg>
          <span ref={tag} className="tag">{CATEGORY[issue.category].label} · S{issue.severity} · {Math.round(issue.confidence * 100)}%</span>
        </div>
      ) : null}
    </div>
  );
}
