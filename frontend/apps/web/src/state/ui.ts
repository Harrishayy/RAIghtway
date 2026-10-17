// Preferences that survive a reload: look, category preset, desk layout. Stored per browser.
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { CategoryId, CategoryPresetId } from '@raightway/core';
import { CATEGORY_PRESETS } from '@raightway/core';
import { env, type Direction } from '@/config/env';

export type PaneId = 'footage' | 'player' | 'map';
interface UiState {
  direction: Direction;
  preset: CategoryPresetId;
  hidden: CategoryId[];
  order: PaneId[];
  widths: { a: number; c: number };
  mapView: 'drive' | 'city';
  rate: number;
  /** The VSS footage search: the footage list and the timeline lane read the same query. Not restored on reload. */
  topic: string;
  setDirection: (d: Direction) => void;
  setPreset: (p: CategoryPresetId) => void;
  toggleCategory: (c: CategoryId) => void;
  setOrder: (o: PaneId[]) => void;
  setWidths: (w: Partial<{ a: number; c: number }>) => void;
  setMapView: (v: 'drive' | 'city') => void;
  setRate: (r: number) => void;
  setTopic: (q: string) => void;
  resetLayout: () => void;
}
const noStorage: Storage = { length: 0, clear() {}, getItem: () => null, key: () => null, removeItem() {}, setItem() {} };
const DEFAULT_ORDER: PaneId[] = ['footage', 'player', 'map'];
const DEFAULT_WIDTHS = { a: 272, c: 380 };

export const useUi = create<UiState>()(persist((set, get) => ({
  direction: env.defaultDirection, preset: 'all', hidden: [], order: DEFAULT_ORDER, widths: DEFAULT_WIDTHS, mapView: 'drive', rate: 4, topic: '',
  setDirection: direction => set({ direction }),
  setPreset: preset => set({ preset, hidden: [] }),
  toggleCategory: c => {
    const { hidden, preset } = get(); const ids = CATEGORY_PRESETS[preset].ids;
    if (hidden.includes(c)) set({ hidden: hidden.filter(x => x !== c) });
    else if (ids.filter(x => !hidden.includes(x)).length > 1) set({ hidden: [...hidden, c] }); // keep at least one
  },
  setOrder: order => set({ order }),
  setWidths: w => set({ widths: { ...get().widths, ...w } }),
  setMapView: mapView => set({ mapView }),
  setRate: rate => set({ rate }),
  setTopic: topic => set({ topic: topic.trim() }),
  resetLayout: () => set({ order: DEFAULT_ORDER, widths: DEFAULT_WIDTHS }),
}), {
  name: 'raightway:ui', version: 1, skipHydration: true,
  storage: createJSONStorage(() => (typeof window === 'undefined' ? noStorage : window.localStorage)),
  // never trust stored values blindly: a renamed pane or preset must not break the desk
  merge: (persisted, current) => {
    const p = (persisted ?? {}) as Partial<UiState>; const out = { ...current, ...p };
    if (!Array.isArray(p.order) || p.order.length !== 3 || !DEFAULT_ORDER.every(k => p.order!.includes(k))) out.order = DEFAULT_ORDER;
    if (!p.preset || !(p.preset in CATEGORY_PRESETS)) out.preset = 'all';
    out.direction = current.direction;   // the look picker is hidden: always the default (survey)
    out.topic = '';                       // a search is per visit
    if (!p.widths || !Number.isFinite(p.widths.a) || !Number.isFinite(p.widths.c)) out.widths = DEFAULT_WIDTHS;
    return out;
  },
}));

/** Categories currently shown: the preset minus any the user switched off. */
export const useCategories = (): CategoryId[] => {
  const preset = useUi(s => s.preset); const hidden = useUi(s => s.hidden);
  return CATEGORY_PRESETS[preset].ids.filter(c => !hidden.includes(c));
};
