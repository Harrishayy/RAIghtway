'use client';
import { createContext, useContext, useState, type ReactNode } from 'react';
import type { RaightwayClient } from '@raightway/core';
import { makeClient } from '@/config/backend';

const Ctx = createContext<RaightwayClient | null>(null);
export function ClientProvider({ children, client }: { children: ReactNode; client?: RaightwayClient }) {
  const [c] = useState(() => client ?? makeClient());
  return <Ctx.Provider value={c}>{children}</Ctx.Provider>;
}
export function useClient(): RaightwayClient {
  const c = useContext(Ctx); if (!c) throw new Error('useClient must be used inside <ClientProvider>');
  return c;
}
