'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CATEGORY_PRESETS, type CategoryPresetId } from '@raightway/core';
import { dashFor } from '@/domain/derive';
import { useIssues, useVideos } from '@/domain/queries';
import { useCategories, useUi } from '@/state/ui';
import { Dash } from '@/ui/Dash';
import { Icon, type IconName } from '@/ui/Icon';
import { Seg } from '@/ui/Seg';

const TABS: Array<{ href: string; label: string; icon: IconName }> = [
  { href: '/review', label: 'Review', icon: 'film' }, { href: '/issues', label: 'Issues', icon: 'pin' },
  { href: '/report', label: 'Report', icon: 'report' }, { href: '/dispatch', label: 'Dispatch', icon: 'route' },
];

export function TopNav() {
  const path = usePathname(); const videos = useVideos(); const issues = useIssues(); const cats = useCategories();
  const { preset, setPreset } = useUi();
  const open = (issues.data ?? []).filter(i => !i.duplicate_of && cats.includes(i.category)).length;
  return (
    <nav className="nav" aria-label="Console">
      <Link href="/review" className="nav-brand"><Dash state={dashFor(videos.data)} size={22} />Raightway</Link>
      <div className="nav-tabs">
        {TABS.map(t => (
          <Link key={t.href} href={t.href} className="nav-tab" aria-current={path?.startsWith(t.href) ? 'page' : undefined}>
            <Icon name={t.icon} />{t.label}{t.href === '/issues' && issues.data ? <span className="count num">{open}</span> : null}
          </Link>
        ))}
      </div>
      <div className="nav-right">
        <Seg size="sm" label="Issue categories" value={preset} onChange={v => setPreset(v as CategoryPresetId)} options={(Object.keys(CATEGORY_PRESETS) as CategoryPresetId[]).map(id => ({ value: id, label: id === 'all' ? 'All' : CATEGORY_PRESETS[id].label.replace(' only', '').replace('Roads and markings', 'Roads') }))} />
      </div>
    </nav>
  );
}
