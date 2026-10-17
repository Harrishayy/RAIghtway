import type { NextConfig } from 'next';

// RAIGHTWAY_API_URL (server-side only) points same-origin /api/* at the backend, so the browser never
// needs CORS and credentials stay on the server. Leave it unset to run on sample data.
const api = process.env.RAIGHTWAY_API_URL?.replace(/\/$/, '');

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The dev-tools bubble sits over the logo, and the README recordings are made from `pnpm dev`.
  devIndicators: false,
  transpilePackages: ['@raightway/core'],
  // The /api rewrite proxy gives up after 30 s by default; report (Nemotron) and dispatch (cuOpt) can take longer.
  experimental: { proxyTimeout: 120_000 },
  async rewrites() {
    return api ? [{ source: '/api/:path*', destination: `${api}/api/:path*` }] : [];
  },
  async headers() {
    return [{ source: '/:path*', headers: [{ key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }] }];
  },
};
export default config;
