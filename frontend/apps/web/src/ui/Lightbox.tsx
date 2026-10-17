'use client';
// The full-size photo of a finding: the stored keyframe at its native size (GET /api/frames/{id}), fitted to the
// viewport (contain), with the finding's box and tag drawn the way Frame draws them. 1:1 zoom by click or button,
// panning by drag or arrow keys while zoomed; B toggles the box. Esc, the close button or a backdrop click closes;
// focus is trapped while open and returns to the thumbnail that opened it. Presentational: callers pass the frame
// URL, box and labels. There is no lightbox without a real frame (callers render PhotoButton with src=null).
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CATEGORY, fmtTimecode, issueLabel, type BBox, type CategoryId, type Issue, type ReportIssue, type Severity } from '@raightway/core';
import { useSize } from '@/lib/useSize';
import { Icon } from './Icon';
import { CategoryLabel, Chip, SevLabel } from './marks';

export interface LightboxProps {
  /** The stored keyframe at its native size. */
  src: string;
  /** issueLabel(issue): the operator's name, else the description. */
  title: string;
  category: CategoryId;
  severity: Severity;
  manual?: boolean;
  /** Where and when, e.g. "set04/video_0008 @ 00:12.5". */
  where?: string | null;
  bbox?: BBox | null;
  /** The box's tag, as Frame writes it. */
  tag?: string;
  onClose: () => void;
}

/** Lightbox labels for an issue or a report row. */
export function photoOf(i: Issue | ReportIssue): Omit<LightboxProps, 'src' | 'onClose'> {
  const drive = 'drive' in i ? i.drive : null; const manual = 'source' in i && i.source === 'manual';
  const place = i.place ?? null;
  const label = i.name?.trim() || CATEGORY[i.category].label;
  return {
    title: issueLabel(i), category: i.category, severity: i.severity as Severity, manual,
    where: `${place ? `${place} · ` : ''}${drive ?? i.video_id} @ ${fmtTimecode(i.t)}`,
    bbox: 'bbox' in i ? i.bbox : null,
    tag: `${label} · S${i.severity} · ${manual ? 'Manual' : `${Math.round(i.confidence * 100)}%`}`,
  };
}

const FOCUSABLE = 'button:not([disabled]),[href],input,select,textarea,[tabindex]:not([tabindex="-1"])';
const STEP = 80;                    // px per arrow-key pan

export function Lightbox({ src, title, category, severity, manual, where, bbox, tag, onClose }: LightboxProps) {
  const dialog = useRef<HTMLDivElement>(null); const stage = useRef<HTMLDivElement>(null); const closeBtn = useRef<HTMLButtonElement>(null);
  const { width: sw, height: sh } = useSize(stage);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [showBox, setShowBox] = useState(true);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const titleId = useId();

  const fit = natural && sw && sh ? Math.min(sw / natural.w, sh / natural.h) : 0;
  const scale = zoomed ? 1 : fit;
  const w = natural ? natural.w * scale : 0, h = natural ? natural.h * scale : 0;
  const clampPan = useCallback((p: { x: number; y: number }, iw = w, ih = h) => {
    const mx = Math.max(0, (iw - sw) / 2), my = Math.max(0, (ih - sh) / 2);
    return { x: Math.max(-mx, Math.min(mx, p.x)), y: Math.max(-my, Math.min(my, p.y)) };
  }, [w, h, sw, sh]);
  // keep the image in view when the viewport resizes: the stored pan is clamped at render
  const at = clampPan(pan);

  /** Toggle 1:1; when zooming in from a point (stage coords), keep that point under it. */
  const toggleZoom = useCallback((at?: { x: number; y: number }) => {
    if (!natural) return;
    if (zoomed) { setZoomed(false); setPan({ x: 0, y: 0 }); return; }
    let next = { x: 0, y: 0 };
    if (at && fit) {
      const fx = (at.x - (sw - natural.w * fit) / 2) / (natural.w * fit), fy = (at.y - (sh - natural.h * fit) / 2) / (natural.h * fit);
      next = { x: at.x - sw / 2 - (fx - 0.5) * natural.w, y: at.y - sh / 2 - (fy - 0.5) * natural.h };
    }
    setZoomed(true); setPan(clampPan(next, natural.w, natural.h));
  }, [natural, zoomed, fit, sw, sh, clampPan]);

  // focus in, scroll locked, focus back to the opener on close
  const open = useRef(false);
  useLayoutEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    open.current = true; closeBtn.current?.focus({ preventScroll: true });
    return () => {
      open.current = false;                       // before the focus trap lets go, so it doesn't pull focus back
      document.body.style.overflow = overflow; if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  // the keyboard belongs to the dialog while it is open: nothing reaches the player or the desk
  const latest = useRef({ onClose, toggleZoom, zoomed, clampPan });
  useEffect(() => { latest.current = { onClose, toggleZoom, zoomed, clampPan }; });
  useEffect(() => {
    const el = dialog.current; if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      const s = latest.current;
      if (e.key === 'Escape') { e.preventDefault(); s.onClose(); }
      else if (e.key === 'Tab') {
        const list = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(n => n.offsetParent !== null || n === document.activeElement);
        if (!list.length) return;
        const first = list[0]!, last = list[list.length - 1]!;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      } else if (e.key.startsWith('Arrow') && s.zoomed) {
        e.preventDefault();
        const d = { ArrowLeft: [STEP, 0], ArrowRight: [-STEP, 0], ArrowUp: [0, STEP], ArrowDown: [0, -STEP] }[e.key] as [number, number] | undefined;
        if (d) setPan(p => s.clampPan({ x: p.x + d[0], y: p.y + d[1] }));
      } else if ((e.key === 'b' || e.key === 'B') && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setShowBox(v => !v); }
      else if ((e.key === 'z' || e.key === 'Z' || e.key === '1') && !e.metaKey && !e.ctrlKey) { e.preventDefault(); s.toggleZoom(); }
      e.stopPropagation();
    };
    el.addEventListener('keydown', onKey); return () => el.removeEventListener('keydown', onKey);
  }, []);
  // focus can't leave: a focus landing outside (e.g. a click-through) comes back to the dialog
  useEffect(() => {
    const onFocus = (e: FocusEvent) => { if (open.current && dialog.current && !dialog.current.contains(e.target as Node)) closeBtn.current?.focus({ preventScroll: true }); };
    document.addEventListener('focusin', onFocus); return () => document.removeEventListener('focusin', onFocus);
  }, []);

  // drag to pan while zoomed; a press that does not move is a click (zoom toggle at that point)
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !natural || failed) return;
    const el = stage.current; if (!el) return;
    const r = el.getBoundingClientRect(); const start = { x: e.clientX, y: e.clientY }; const from = at; let moved = false;
    el.setPointerCapture(e.pointerId);
    el.onpointermove = ev => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true; if (zoomed) { setDragging(true); setPan(clampPan({ x: from.x + dx, y: from.y + dy })); }
    };
    el.onpointerup = ev => {
      el.onpointermove = null; el.onpointerup = null; setDragging(false);
      if (!moved) toggleZoom({ x: ev.clientX - r.left, y: ev.clientY - r.top });
    };
  };

  const loose = Boolean(bbox && (bbox.w >= 0.8 || bbox.w * bbox.h >= 0.35));
  const tagPlace = bbox ? (bbox.y < 0.05 ? (bbox.y + bbox.h > 0.94 ? ' inside' : ' below') : '') : '';
  const flip = bbox ? bbox.x > 0.7 : false;

  return createPortal(
    <div className="lightbox" onClick={e => { e.stopPropagation(); if (e.target === e.currentTarget) onClose(); }}
      onPointerDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
      <div ref={dialog} className="lightbox-panel" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="lightbox-h">
          <div className="lightbox-t">
            <h2 id={titleId} title={title}>{title}</h2>
            <div className="lightbox-meta">
              <CategoryLabel id={category} /><SevLabel level={severity} />
              {manual ? <span title="Marked by an operator on the footage, not found by a model"><Chip tone="neutral">Manual</Chip></span> : null}
              {where ? <span className="mono muted small lightbox-where" title={where}>{where}</span> : null}
            </div>
          </div>
          <div className="lightbox-tools">
            {bbox && !failed ? <button type="button" className="btn btn-ghost btn-sm" aria-pressed={showBox} onClick={() => setShowBox(v => !v)} title="Show or hide the box (B)">{showBox ? 'Hide box' : 'Show box'}</button> : null}
            <button type="button" className="btn btn-ghost btn-sm" aria-pressed={zoomed} onClick={() => toggleZoom()} disabled={!natural || failed} title="Actual pixels or fit to the window (Z)"><Icon name="zoom" />{zoomed ? 'Fit' : '1:1'}</button>
            <button ref={closeBtn} type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Close photo" title="Close (Esc)" onClick={onClose}><Icon name="x" /></button>
          </div>
        </header>
        <div ref={stage} className={`lightbox-stage${zoomed ? ' is-zoomed' : ''}${dragging ? ' is-dragging' : ''}`} onPointerDown={down}
          tabIndex={natural && !failed ? 0 : -1} aria-label={zoomed ? 'Photo at actual size: drag or use the arrow keys to pan, Z to fit' : 'Photo: click or press Z for actual size'}>
          <div className="lightbox-img" style={natural ? { width: `${w}px`, height: `${h}px`, transform: `translate(calc(-50% + ${at.x}px), calc(-50% + ${at.y}px))` } : undefined}>
            {!failed ? (
              <img src={src} alt={`${CATEGORY[category].label}: ${title}`} draggable={false} decoding="async"
                onLoad={e => setNatural({ w: e.currentTarget.naturalWidth || 1920, h: e.currentTarget.naturalHeight || 1080 })} onError={() => setFailed(true)} />
            ) : null}
            {natural && bbox && showBox && !failed ? (
              <div className={`mark${loose ? ' loose' : ''}${flip ? ' flip' : ''}`} style={{ left: `${bbox.x * 100}%`, top: `${bbox.y * 100}%`, width: `${bbox.w * 100}%`, height: `${bbox.h * 100}%` }}>
                <span className="bb" aria-hidden="true"><i className="c tl" /><i className="c tr" /><i className="c bl" /><i className="c br" /></span>
                <span className={`tag${tagPlace}`}>{tag ?? `${CATEGORY[category].label} · S${severity}`}</span>
              </div>
            ) : null}
          </div>
          {failed ? <div className="lightbox-state" role="alert">Frame unavailable: the backend has no stored keyframe for this finding.</div>
            : !natural ? <div className="lightbox-state" role="status"><span className="lightbox-spin" aria-hidden="true" />Loading full-size frame…</div> : null}
          {natural && !failed ? <span className="lightbox-size mono small" aria-hidden="true">{natural.w}×{natural.h}{zoomed ? ' · 1:1' : ` · ${Math.round(fit * 100)}%`}</span> : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** A thumbnail or frame that opens the Lightbox. No `src` (no real frame): renders `children` alone, no button. */
export function PhotoButton({ src, photo, className, children, stopRow }: {
  src: string | null; photo: Omit<LightboxProps, 'src' | 'onClose'>; className?: string; children?: ReactNode;
  /** Inside a clickable row: keep the row's own click and Enter from firing. */
  stopRow?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!src) return <>{children}</>;
  return (
    <>
      <button type="button" className={`photo-btn${className ? ` ${className}` : ''}`} aria-label={`Open full-size photo of ${photo.title}`} title="Open full-size photo"
        onClick={e => { if (stopRow) e.stopPropagation(); setOpen(true); }} onKeyDown={e => { if (stopRow && (e.key === 'Enter' || e.key === ' ')) e.stopPropagation(); }}>
        {children}
        <span className="photo-hint" aria-hidden="true"><Icon name="expand" /></span>
      </button>
      {open ? <Lightbox src={src} {...photo} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
