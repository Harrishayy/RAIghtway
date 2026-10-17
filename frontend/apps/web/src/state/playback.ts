// The one playhead every view follows: the player, the timeline, the map's vehicle and the table.
import { create } from 'zustand';

interface PlaybackState {
  videoId: string | null;
  t: number;
  playing: boolean;
  selectedIssue: string | null;
  /** Bumps when a seek should be pushed into a <video> element. */
  seekNonce: number;
  open: (videoId: string, t?: number, issueId?: string | null) => void;
  seek: (t: number) => void;
  tick: (t: number) => void;
  setPlaying: (p: boolean) => void;
  select: (id: string | null) => void;
}
export const usePlayback = create<PlaybackState>()((set, get) => ({
  videoId: null, t: 0, playing: false, selectedIssue: null, seekNonce: 0,
  open: (videoId, t = 0, issueId = null) => set({ videoId, t: Math.max(0, t), playing: false, selectedIssue: issueId, seekNonce: get().seekNonce + 1 }),
  seek: t => set({ t: Math.max(0, t), seekNonce: get().seekNonce + 1 }),
  tick: t => set({ t }),
  setPlaying: playing => set({ playing }),
  select: selectedIssue => set({ selectedIssue }),
}));
