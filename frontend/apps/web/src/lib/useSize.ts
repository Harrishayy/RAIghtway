'use client';
import { useEffect, useState, type RefObject } from 'react';

/** Live content-box size of an element; components use it to re-lay themselves as panes resize. */
export function useSize(ref: RefObject<Element | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current; if (!el) return;
    let raf = 0;
    const ro = new ResizeObserver(([e]) => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if (!e) return; const { width, height } = e.contentRect; setSize(s => (Math.round(s.width) === Math.round(width) && Math.round(s.height) === Math.round(height) ? s : { width, height })); }); });
    ro.observe(el); return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [ref]);
  return size;
}
export const hit = (a: DOMRect | { left: number; right: number; top: number; bottom: number }, b: DOMRect | { left: number; right: number; top: number; bottom: number }, pad = 0) =>
  a.left < b.right + pad && b.left < a.right + pad && a.top < b.bottom + pad && b.top < a.bottom + pad;
