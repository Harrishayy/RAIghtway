import type { Metadata } from 'next';
import { ReportView } from '@/features/report/ReportView';
export const metadata: Metadata = { title: 'Report' };
export default function Page() { return <ReportView />; }
