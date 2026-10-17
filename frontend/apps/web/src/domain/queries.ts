'use client';
// Server state. Every screen reads through these hooks; polling speeds up while a job is running and
// stops when the tab is hidden. Keys are centralised so mutations can invalidate precisely.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CrewCounts, LatLon, Video } from '@raightway/core';
import { env } from '@/config/env';
import { toast } from '@/state/toast';
import { useClient } from './client';

export const keys = {
  videos: ['videos'] as const,
  video: (id: string) => ['video', id] as const,
  issues: ['issues'] as const,
  similar: (id: string) => ['similar', id] as const,
  report: ['report'] as const,
  topic: (q: string) => ['topic', q] as const,
  hazards: ['hazards'] as const,
};
const isLive = (v: Video[] | undefined) => Boolean(v?.some(x => x.status === 'queued' || x.status === 'analysing'));

export function useVideos() {
  const c = useClient();
  return useQuery({ queryKey: keys.videos, queryFn: ({ signal }) => c.listVideos(signal), refetchInterval: q => (isLive(q.state.data) ? env.pollLiveMs : env.pollIdleMs) });
}
export function useLive() { const { data } = useVideos(); return isLive(data); }
export function useIssues() {
  const c = useClient(); const live = useLive();
  return useQuery({ queryKey: keys.issues, queryFn: ({ signal }) => c.listIssues(signal), refetchInterval: live ? env.pollLiveMs : env.pollIdleMs });
}
export function useVideo(id: string | null) {
  const c = useClient(); const { data: videos } = useVideos(); const v = videos?.find(x => x.id === id);
  const live = v ? v.status === 'queued' || v.status === 'analysing' : false;
  return useQuery({ queryKey: keys.video(id ?? ''), queryFn: ({ signal }) => c.getVideo(id!, signal), enabled: Boolean(id), refetchInterval: live ? env.pollLiveMs : false, placeholderData: prev => (prev?.video.id === id ? prev : undefined) });
}
export function useSimilar(id: string | null) {
  const c = useClient();
  return useQuery({ queryKey: keys.similar(id ?? ''), queryFn: ({ signal }) => c.similar(id!, signal), enabled: Boolean(id) && c.capabilities.similar, staleTime: 60_000 });
}
export function useReport() {
  const c = useClient();
  return useQuery({ queryKey: keys.report, queryFn: ({ signal }) => c.getReport(signal), refetchInterval: q => (q.state.data?.updating ? env.pollLiveMs : env.pollIdleMs * 3) });
}
export function useRegenerateReport() {
  const c = useClient(); const qc = useQueryClient();
  return useMutation({ mutationFn: () => c.regenerateReport(), onSuccess: r => { qc.setQueryData(keys.report, r); toast({ tone: 'ok', title: 'Report updated' }); }, onError: e => toast({ tone: 'bad', title: 'Report failed', body: (e as Error).message }) });
}
export function useDispatch() {
  const c = useClient();
  return useMutation({ mutationFn: (crews: CrewCounts) => c.dispatch(crews), onError: e => toast({ tone: 'bad', title: 'Routing failed', body: (e as Error).message }) });
}
/** Road closures and work zones near the work; the city feed changes slowly, so poll rarely. */
export function useHazards(enabled = true) {
  const c = useClient();
  return useQuery({ queryKey: keys.hazards, queryFn: ({ signal }) => c.hazards(signal), enabled: enabled && c.capabilities.directions, staleTime: 5 * 60_000, refetchInterval: 15 * 60_000 });
}
export function useDirections() {
  const c = useClient();
  return useMutation({ mutationFn: ({ from, to }: { from: LatLon; to: LatLon }) => c.directions(from, to), onError: e => toast({ tone: 'bad', title: 'Directions failed', body: (e as Error).message }) });
}
export function useUpload() {
  const c = useClient(); const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file, onProgress }: { file: File; onProgress?: (f: number) => void }) => c.upload(file, { onProgress }),
    onSuccess: v => { qc.setQueryData<Video[]>(keys.videos, old => [v, ...(old ?? []).filter(x => x.id !== v.id)]); void qc.invalidateQueries({ queryKey: keys.videos }); toast({ tone: 'info', title: 'Analysing', body: v.filename }); },
    onError: e => toast({ tone: 'bad', title: 'Upload failed', body: (e as Error).message }),
  });
}
export function useTopic(query: string) {
  const c = useClient(); const q = query.trim();
  return useQuery({ queryKey: keys.topic(q), queryFn: ({ signal }) => c.searchTopic(q, signal), enabled: c.capabilities.topicSearch && q.length > 2, staleTime: 5 * 60_000 });
}
