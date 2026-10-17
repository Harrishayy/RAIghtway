'use client';
// Says when the category filter (top-bar preset or a chip switched off) hides findings on the open drive, so a
// summary or an Ask answer that mentions graffiti never meets a timeline with no graffiti on it in silence.
import { CATEGORIES, type CategoryId, type Issue } from '@raightway/core';
import { useUi } from '@/state/ui';

export function FilterNote({ all, cats }: { all: Issue[] | undefined; cats: CategoryId[] }) {
  const setPreset = useUi(s => s.setPreset);
  const hidden = CATEGORIES.map(c => ({ c, n: (all ?? []).filter(i => i.category === c.id).length })).filter(x => x.n && !cats.includes(x.c.id));
  if (!hidden.length) return null;
  const total = hidden.reduce((s, x) => s + x.n, 0);
  return (
    <p className="filter-note" role="status">
      <span><b>{total} finding{total === 1 ? '' : 's'}</b> hidden by the category filter: {hidden.map(x => `${x.c.label} ${x.n}`).join(' · ')}</span>
      <button type="button" className="link" onClick={() => setPreset('all')}>Show all</button>
    </p>
  );
}
