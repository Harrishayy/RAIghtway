import type { Metadata } from 'next';
import { DispatchView } from '@/features/dispatch/DispatchView';
export const metadata: Metadata = { title: 'Dispatch' };
export default function Page() { return <DispatchView />; }
