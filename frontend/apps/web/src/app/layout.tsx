import type { Metadata, Viewport } from 'next';
import { Barlow_Semi_Condensed, Chivo, Chivo_Mono, Familjen_Grotesk, Hanken_Grotesk, IBM_Plex_Mono, Instrument_Sans, Public_Sans, Red_Hat_Mono } from 'next/font/google';
import { env } from '@/config/env';
import { Providers } from './providers';
import '@/styles/tokens.css';
import '@/styles/components.css';
import '@/styles/app.css';

// Survey's faces preload; the other directions' load on demand when someone switches.
const barlow = Barlow_Semi_Condensed({ subsets: ['latin'], weight: ['500', '600', '700', '800'], variable: '--ff-barlow', display: 'swap' });
const publicSans = Public_Sans({ subsets: ['latin'], variable: '--ff-public', display: 'swap' });
const plexMono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--ff-plex-mono', display: 'swap' });
const chivo = Chivo({ subsets: ['latin'], variable: '--ff-chivo', display: 'swap', preload: false });
const chivoMono = Chivo_Mono({ subsets: ['latin'], variable: '--ff-chivo-mono', display: 'swap', preload: false });
const instrument = Instrument_Sans({ subsets: ['latin'], variable: '--ff-instrument', display: 'swap', preload: false });
const familjen = Familjen_Grotesk({ subsets: ['latin'], variable: '--ff-familjen', display: 'swap', preload: false });
const hanken = Hanken_Grotesk({ subsets: ['latin'], variable: '--ff-hanken', display: 'swap', preload: false });
const redhat = Red_Hat_Mono({ subsets: ['latin'], variable: '--ff-redhat-mono', display: 'swap', preload: false });
const fonts = [barlow, publicSans, plexMono, chivo, chivoMono, instrument, familjen, hanken, redhat].map(f => f.variable).join(' ');

export const metadata: Metadata = { title: { default: 'Raightway', template: '%s · Raightway' }, description: 'City maintenance dispatch from fleet dashcam footage.' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-dir={env.defaultDirection} className={fonts} suppressHydrationWarning>
      <body><Providers>{children}</Providers></body>
    </html>
  );
}
