import type { Metadata } from 'next';
import { SitesView } from '@/features/sites/SitesView';
export const metadata: Metadata = { title: 'Sites' };
export default function Page() { return <SitesView />; }
