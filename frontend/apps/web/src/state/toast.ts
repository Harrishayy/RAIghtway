import { create } from 'zustand';

export interface Toast { id: number; tone: 'info' | 'ok' | 'bad'; title: string; body?: string; action?: { label: string; run: () => void } }
interface ToastState { toasts: Toast[]; push: (t: Omit<Toast, 'id'>) => void; dismiss: (id: number) => void }
let n = 0;
export const useToasts = create<ToastState>()(set => ({
  toasts: [],
  push: t => { const id = ++n; set(s => ({ toasts: [{ ...t, id }, ...s.toasts].slice(0, 4) })); setTimeout(() => set(s => ({ toasts: s.toasts.filter(x => x.id !== id) })), 6000); },
  dismiss: id => set(s => ({ toasts: s.toasts.filter(x => x.id !== id) })),
}));
export const toast = (t: Omit<Toast, 'id'>) => useToasts.getState().push(t);
