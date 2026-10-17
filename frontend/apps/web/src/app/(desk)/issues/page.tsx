import type { Metadata } from 'next';
import { IssuesView } from '@/features/issues/IssuesView';
export const metadata: Metadata = { title: 'Issues' };
export default function Page() { return <IssuesView />; }
