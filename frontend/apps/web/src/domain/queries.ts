'use client';
// Server state. Every screen reads through these hooks; polling speeds up while a job is running and
// stops when the tab is hidden. Keys are centralised so mutations can invalidate precisely.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CrewCounts, DispatchOptions, Facility, FacilityInput, Issue, IssuePatch, LatLon, ManualIssueInput, Plan, Recommendation, RecommendOptions, Video, Zone } from '@raightway/core';
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
  facilities: ['facilities'] as const,
  plan: ['plan', 'latest'] as const,
  recommendation: ['recommendation'] as const,
  recommendProgress: ['recommendation', 'progress'] as const,
  zones: ['zones'] as const,
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
  const c = useClient(); const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ crews = {}, opts }: { crews?: CrewCounts; opts?: DispatchOptions }) => c.dispatch(crews, opts),
    // Kept in the cache so the plan survives switching tabs; the report reads the saved plan.
    onSuccess: plan => { qc.setQueryData(keys.plan, plan); void qc.invalidateQueries({ queryKey: keys.report }); },
    onError: e => toast({ tone: 'bad', title: 'Routing failed', body: (e as Error).message }),
  });
}
/** The plan made in this session (set by useDispatch); null until one is made. */
export function useLatestPlan() {
  return useQuery<Plan | null>({ queryKey: keys.plan, queryFn: () => null, enabled: false, initialData: null, staleTime: Infinity });
}
/** Operating sites (transfer stations, collection, road and cleaning yards) with trucks per day. */
export function useFacilities() {
  const c = useClient();
  return useQuery({ queryKey: keys.facilities, queryFn: ({ signal }) => c.listFacilities(signal), enabled: c.capabilities.sites, staleTime: 30_000 });
}
function useSiteMutation<A>(fn: (a: A) => Promise<unknown>, done?: (a: A) => string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (_r, a) => { void qc.invalidateQueries({ queryKey: keys.facilities }); const t = done?.(a); if (t) toast({ tone: 'ok', title: t }); },
    onError: e => toast({ tone: 'bad', title: 'Site not saved', body: (e as Error).message }),
  });
}
export function useAddFacility() { const c = useClient(); return useSiteMutation((input: FacilityInput) => c.addFacility(input), i => `Added ${i.label}`); }
export function useUpdateFacility() {
  const c = useClient(); const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: FacilityInput }) => c.updateFacility(id, patch),
    // Optimistic, so truck steppers feel instant; the server's answer replaces it.
    onMutate: ({ id, patch }) => { const prev = qc.getQueryData<Facility[]>(keys.facilities); qc.setQueryData<Facility[]>(keys.facilities, old => old?.map(f => (f.id === id ? { ...f, ...patch } : f))); return { prev }; },
    onError: (e, _a, ctx) => { if (ctx?.prev) qc.setQueryData(keys.facilities, ctx.prev); toast({ tone: 'bad', title: 'Site not saved', body: (e as Error).message }); },
    onSuccess: f => qc.setQueryData<Facility[]>(keys.facilities, old => old?.map(x => (x.id === f.id ? f : x))),
  });
}
export function useRemoveFacility() { const c = useClient(); return useSiteMutation((f: Facility) => c.removeFacility(f.id), f => `Removed ${f.label}`); }
export function useResetFacilities() { const c = useClient(); return useSiteMutation(() => c.resetFacilities(), () => 'Sites reset to the City list'); }
export function useGeocode() {
  const c = useClient();
  return useMutation({ mutationFn: (q: string) => c.geocode(q), onError: e => toast({ tone: 'bad', title: 'Address lookup failed', body: (e as Error).message }) });
}
/** Nemotron + cuOpt workforce recommendation (tens of seconds). */
export function useRecommend() {
  const c = useClient(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (opts: RecommendOptions) => c.recommend(opts),
    onSuccess: r => qc.setQueryData<Recommendation | null>(keys.recommendation, r),
    onError: e => toast({ tone: 'bad', title: 'Recommendation failed', body: (e as Error).message }),
  });
}
export function useLatestRecommendation() {
  const c = useClient();
  return useQuery({ queryKey: keys.recommendation, queryFn: ({ signal }) => c.latestRecommendation(signal), enabled: c.capabilities.recommend, staleTime: 60_000 });
}
/** Polled once a second while a recommendation runs: the stage and how many scenarios cuOpt has solved. */
export function useRecommendProgress(running: boolean) {
  const c = useClient();
  return useQuery({ queryKey: keys.recommendProgress, queryFn: ({ signal }) => c.recommendProgress(signal), enabled: running && c.capabilities.recommend, refetchInterval: running ? 1000 : false, staleTime: 0 });
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
export function useRun() {
  const c = useClient(); const qc = useQueryClient();
  return useMutation({
    mutationFn: () => c.run(),
    onSuccess: v => { qc.setQueryData<Video[]>(keys.videos, old => [v, ...(old ?? []).filter(x => x.id !== v.id)]); void qc.invalidateQueries({ queryKey: keys.videos }); toast({ tone: 'info', title: 'Analysing new footage', body: v.drive ?? v.filename }); },
    // 409 is "nothing new in the VAST index": information, not a failure
    onError: e => toast({ tone: (e as { status?: number }).status === 409 ? 'info' : 'bad', title: (e as { status?: number }).status === 409 ? 'Up to date' : 'Run failed', body: (e as Error).message }),
  });
}
// Operator input changes what the plan should include, so every view of issues and plans refetches.
function useInvalidateIssueViews() {
  const qc = useQueryClient();
  return (issue: Issue) => {
    qc.setQueryData<Issue[]>(keys.issues, old => (old ? (old.some(i => i.id === issue.id) ? old.map(i => (i.id === issue.id ? { ...i, ...issue, sightings: i.sightings } : i)) : [...old, issue]) : old));
    qc.setQueryData<{ video: Video; issues: Issue[] }>(keys.video(issue.video_id), old => (old ? { video: old.video.issue_ids.includes(issue.id) ? old.video : { ...old.video, issue_ids: [...old.video.issue_ids, issue.id] }, issues: old.issues.some(i => i.id === issue.id) ? old.issues.map(i => (i.id === issue.id ? { ...i, ...issue } : i)) : [...old.issues, issue] } : old));
    for (const queryKey of [keys.issues, ['video'], keys.videos, ['plan'], keys.report]) void qc.invalidateQueries({ queryKey });
  };
}
/** Saves an issue an operator marked on footage. */
export function useCreateIssue() {
  const c = useClient(); const refresh = useInvalidateIssueViews();
  return useMutation({
    mutationFn: (input: ManualIssueInput) => c.createIssue(input),
    onSuccess: i => { refresh(i); toast({ tone: 'ok', title: 'Issue marked', body: i.pinned ? 'Pinned for the next plan' : i.description }); },
    onError: e => toast({ tone: 'bad', title: 'Could not save the issue', body: (e as Error).message }),
  });
}
/** Pin/unpin an issue for the next plan, or set and undo an operator severity. */
export function useUpdateIssue() {
  const c = useClient(); const refresh = useInvalidateIssueViews();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: IssuePatch }) => c.updateIssue(id, patch),
    onSuccess: refresh,
    onError: e => toast({ tone: 'bad', title: 'Could not update the issue', body: (e as Error).message }),
  });
}
export function useTopic(query: string) {
  const c = useClient(); const q = query.trim();
  return useQuery({ queryKey: keys.topic(q), queryFn: ({ signal }) => c.searchTopic(q, signal), enabled: c.capabilities.topicSearch && q.length > 2, staleTime: 5 * 60_000 });
}
/** Planning zones: the City's wards and areas drawn in the console (they change rarely). */
export function useZones() {
  const c = useClient();
  return useQuery({ queryKey: keys.zones, queryFn: ({ signal }) => c.listZones(signal), enabled: c.capabilities.zones, staleTime: 10 * 60_000 });
}
export function useAddZone() {
  const c = useClient(); const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ label, polygon }: { label: string; polygon: LatLon[] }) => c.addZone(label, polygon),
    onSuccess: z => { qc.setQueryData<Zone[]>(keys.zones, old => [...(old ?? []), z]); toast({ tone: 'ok', title: `Saved zone: ${z.label}` }); },
    onError: e => toast({ tone: 'bad', title: 'Zone not saved', body: (e as Error).message }),
  });
}
export function useRemoveZone() {
  const c = useClient(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (z: Zone) => c.removeZone(z.id),
    onSuccess: (_r, z) => qc.setQueryData<Zone[]>(keys.zones, old => old?.filter(x => x.id !== z.id)),
    onError: e => toast({ tone: 'bad', title: 'Zone not removed', body: (e as Error).message }),
  });
}
