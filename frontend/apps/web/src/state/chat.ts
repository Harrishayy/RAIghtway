// The Review chat: one thread per drive, kept for this visit (not persisted). A reply lands in the thread it was
// asked in, even if the operator has opened another drive meanwhile.
import { create } from 'zustand';
import type { AskAnswer, ChatTurn } from '@raightway/core';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** user: the playhead the question was asked at (null: the whole drive). */
  t?: number | null;
  answer?: AskAnswer;
  pending?: boolean;
  error?: string;
  /** assistant: the question it answers, so Retry can ask it again. */
  question?: { text: string; t: number | null };
}

interface ChatState {
  threads: Record<string, ChatMessage[]>;
  push: (videoId: string, m: ChatMessage) => void;
  patch: (videoId: string, id: string, m: Partial<ChatMessage>) => void;
  clear: (videoId: string) => void;
}

export const useChat = create<ChatState>()(set => ({
  threads: {},
  push: (videoId, m) => set(s => ({ threads: { ...s.threads, [videoId]: [...(s.threads[videoId] ?? []), m] } })),
  patch: (videoId, id, m) => set(s => ({ threads: { ...s.threads, [videoId]: (s.threads[videoId] ?? []).map(x => (x.id === id ? { ...x, ...m } : x)) } })),
  clear: videoId => set(s => { const threads = { ...s.threads }; delete threads[videoId]; return { threads }; }),
}));

/** Earlier answered turns, oldest first, as context for the next question (failed and pending turns left out). */
export function history(thread: ChatMessage[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  thread.forEach((m, k) => {
    if (m.role === 'user') { const reply = thread[k + 1]; if (reply?.answer) out.push({ role: 'user', content: m.text }, { role: 'assistant', content: reply.answer.answer }); }
  });
  return out.slice(-8);
}

let seq = 0;
export const chatId = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;
