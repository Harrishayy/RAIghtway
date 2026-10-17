'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@raightway/core';
import { ClientProvider } from '@/domain/client';
import { useUi } from '@/state/ui';
import { Toaster } from '@/ui/Toaster';

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 2000, refetchOnWindowFocus: true, refetchIntervalInBackground: false,
        // retry transient failures with backoff; a 4xx will not fix itself
        retry: (n, e) => (e instanceof ApiError ? e.retryable && n < 3 : n < 2),
        retryDelay: n => Math.min(8000, 600 * 2 ** n),
      },
      mutations: { retry: 0 },
    },
  }));
  return (
    <QueryClientProvider client={qc}>
      <ClientProvider>
        <DirectionSync />
        {children}
        <Toaster />
      </ClientProvider>
    </QueryClientProvider>
  );
}

/** Loads saved preferences after hydration (so server and client render the same first frame) and mirrors the look onto <html>. */
function DirectionSync() {
  const dir = useUi(s => s.direction);
  useEffect(() => { void useUi.persist.rehydrate(); }, []);
  useEffect(() => { document.documentElement.dataset.dir = dir; }, [dir]);
  return null;
}
