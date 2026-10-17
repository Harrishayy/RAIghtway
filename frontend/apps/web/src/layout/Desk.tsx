'use client';
// The movable desk: three panes in a row. Drag a pane's grip onto another to swap them (or use the
// arrow keys on the grip); drag or arrow-key the borders to resize. Widths are preferences clamped to
// the room available, so a saved layout never squeezes a pane below what its content needs.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { clamp } from '@raightway/core';
import { useUi, type PaneId } from '@/state/ui';
import { useSize } from '@/lib/useSize';
import { Icon } from '@/ui/Icon';

export interface PaneDef { id: PaneId; title: string; actions?: ReactNode; body: ReactNode }
const MIN_A = 200, MIN_C = 260, MIN_MID = 340;

export function Desk({ panes }: { panes: Record<PaneId, PaneDef> }) {
  const { order, widths, setOrder, setWidths } = useUi();
  const ref = useRef<HTMLDivElement>(null); const { width: total } = useSize(ref);
  const [mode, setMode] = useState<1 | 2 | 3>(3);
  useEffect(() => { const one = matchMedia('(max-width:860px)'), two = matchMedia('(max-width:1120px)'); const f = () => setMode(one.matches ? 1 : two.matches ? 2 : 3); f(); one.addEventListener('change', f); two.addEventListener('change', f); return () => { one.removeEventListener('change', f); two.removeEventListener('change', f); }; }, []);
  const [drag, setDrag] = useState<PaneId | null>(null); const [over, setOver] = useState<PaneId | null>(null);

  let a = Math.max(MIN_A, widths.a), c = Math.max(MIN_C, widths.c);
  if (total) {
    if (mode === 2) a = clamp(a, MIN_A, Math.max(MIN_A, total - MIN_MID));
    if (mode === 3) { let o = a + c + MIN_MID - total; if (o > 0) { const dc = Math.min(o, c - MIN_C); c -= dc; o -= dc; } if (o > 0) a = Math.max(MIN_A, a - o); }
  }
  const swap = (x: PaneId, y: PaneId) => { if (x === y) return; const o = [...order]; const i = o.indexOf(x), j = o.indexOf(y); [o[i], o[j]] = [o[j]!, o[i]!]; setOrder(o); };
  const resize = (which: 'a' | 'c', px: number) => {
    if (which === 'a') setWidths({ a: clamp(Math.round(px), MIN_A, Math.max(MIN_A, total - (mode === 3 ? c : 0) - MIN_MID)) });
    else setWidths({ c: clamp(Math.round(px), MIN_C, Math.max(MIN_C, total - a - MIN_MID)) });
  };
  const startResize = (which: 'a' | 'c') => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault(); const el = e.currentTarget; el.setPointerCapture(e.pointerId); el.classList.add('on');
    const box = ref.current!.getBoundingClientRect();
    el.onpointermove = ev => resize(which, which === 'a' ? ev.clientX - box.left : box.right - ev.clientX);
    el.onpointerup = () => { el.onpointermove = null; el.classList.remove('on'); };
  };
  const keyResize = (which: 'a' | 'c') => (e: React.KeyboardEvent) => { const d = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0; if (!d) return; e.preventDefault(); resize(which, which === 'a' ? a + d : c - d); };

  return (
    <div ref={ref} className="panes" style={{ ['--pa' as string]: `${a}px`, ['--pc' as string]: `${c}px` }}>
      {order.map((id, i) => {
        const p = panes[id];
        return (
          <section key={id} className={`pane${drag === id ? ' dragging' : ''}${over === id ? ' drop-target' : ''}`} data-pane={id} aria-label={p.title}
            onDragOver={e => { if (drag && drag !== id) { e.preventDefault(); setOver(id); } }} onDragLeave={() => setOver(o => (o === id ? null : o))}
            onDrop={e => { e.preventDefault(); if (drag) swap(drag, id); setDrag(null); setOver(null); }}>
            <header className="pane-h">
              <button type="button" className="pane-grip" draggable aria-label={`Move ${p.title} pane. Drag onto another pane, or use the arrow keys`}
                onDragStart={e => { setDrag(id); e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => { setDrag(null); setOver(null); }}
                onKeyDown={e => { const d = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0; if (!d) return; e.preventDefault(); const j = clamp(i + d, 0, 2); if (j !== i) swap(id, order[j]!); }}>
                <Icon name="grip" className="fill" />
              </button>
              <h3>{p.title}</h3>
              {p.actions ? <span className="pane-act">{p.actions}</span> : null}
            </header>
            <div className="pane-b" data-body={id}>{p.body}</div>
          </section>
        );
      })}
      {mode !== 1 && <div className="resizer" role="separator" aria-orientation="vertical" aria-label="Resize left pane" aria-valuenow={a} aria-valuemin={MIN_A} tabIndex={0} style={{ left: a }} onPointerDown={startResize('a')} onKeyDown={keyResize('a')} />}
      {mode === 3 && <div className="resizer" role="separator" aria-orientation="vertical" aria-label="Resize right pane" aria-valuenow={c} aria-valuemin={MIN_C} tabIndex={0} style={{ left: `calc(100% - ${c}px)` }} onPointerDown={startResize('c')} onKeyDown={keyResize('c')} />}
    </div>
  );
}
