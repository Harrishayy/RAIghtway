import type { Metadata } from 'next';
import { ReviewDesk } from '@/features/review/ReviewDesk';
export const metadata: Metadata = { title: 'Review' };
export default function Page() { return <ReviewDesk />; }
