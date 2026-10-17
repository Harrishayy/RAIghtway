'use client';
// Review: footage, player + timeline + detections, and map + the selected issue, as movable panes.
import { useEffect, useMemo } from 'react';
import type { Issue } from '@raightway/core';
import { byTime, fixAt } from '@/domain/derive';
import { useIssues, useVideo, useVideos } from '@/domain/queries';
import { usePlayback } from '@/state/playback';
import { useCategories, useUi } from '@/state/ui';
import { Desk } from '@/layout/Desk';
import { MapView } from '@/features/map/MapView';
import { IssueCard } from '@/features/issues/IssueCard';
import { UploadButton } from '@/features/upload/UploadButton';
import { Seg } from '@/ui/Seg';
import { Empty, Failed, Loading } from '@/ui/State';
import { FootageList } from './FootageList';
import { Player } from './Player';
import { Timeline } from './Timeline';
import { Detections } from './Detections';

export function ReviewDesk() {
  const videos = useVideos(); const allIssues = useIssues(); const cats = useCategories();
  const { videoId, t, selectedIssue, open, select } = usePlayback();
  const mapView = useUi(s => s.mapView); const setMapView = useUi(s => s.setMapView);
  // open the first drive once data arrives
  useEffect(() => { if (!videoId && videos.data?.length) { const v = videos.data.find(x => x.status === 'done') ?? videos.data[0]!; open(v.id); } }, [videoId, videos.data, open]);
  const detail = useVideo(videoId);
  const video = detail.data?.video ?? videos.data?.find(v => v.id === videoId);
  const issues = useMemo(() => (detail.data?.issues ?? []).filter(i => cats.includes(i.category)).sort(byTime), [detail.data, cats]);
  // land on the drive's first finding rather than an empty road
  useEffect(() => { if (!selectedIssue && issues[0] && detail.data?.video.id === videoId) { select(issues[0].id); if (usePlayback.getState().t === 0) usePlayback.getState().seek(Math.max(0, issues[0].t - 0.4)); } }, [selectedIssue, issues, select, detail.data, videoId]);
  const pool = useMemo(() => { const m = new Map<string, Issue>(); (allIssues.data ?? []).forEach(i => m.set(i.id, i)); issues.forEach(i => m.set(i.id, i)); return m; }, [allIssues.data, issues]);
  const selected = selectedIssue ? pool.get(selectedIssue) : null;
  const mapIssues = useMemo(() => [...pool.values()].filter(i => cats.includes(i.category) && !i.duplicate_of), [pool, cats]);
  const fix = fixAt(video, t);

  const playerBody = detail.isError ? <Failed error={detail.error} onRetry={() => void detail.refetch()} />
    : !video ? (videos.isPending || detail.isPending ? <Loading rows={5} /> : <Empty title="No drive open">Pick one from Footage.</Empty>)
    : <div className="player"><Player video={video} issues={issues} /><Timeline video={video} issues={issues} cats={cats} /><Detections issues={issues} /></div>;

  return (
    <Desk panes={{
      footage: { id: 'footage', title: 'Footage', actions: <UploadButton />, body: <FootageList /> },
      player: { id: 'player', title: 'Player', actions: video ? <span className="fname mono muted">{video.filename}</span> : null, body: playerBody },
      map: {
        id: 'map', title: 'Map', actions: <Seg size="sm" label="Map extent" value={mapView} onChange={setMapView} options={[{ value: 'drive', label: 'Drive' }, { value: 'city', label: 'City' }]} />,
        body: <>
          <MapView label={video ? `Map of ${video.drive ?? video.filename}` : 'Map'} issues={mapIssues} emphasise={i => i.video_id === videoId} selectedId={selectedIssue}
            onSelect={i => (i.video_id === videoId ? (select(i.id), usePlayback.getState().seek(Math.max(0, i.t - 0.4))) : open(i.video_id, Math.max(0, i.t - 0.4), i.id))}
            track={video?.track} travelled={video?.duration_s ? t / video.duration_s : 0} vehicle={fix} focus={mapView === 'city' ? [] : video?.track}
            overlay={fix?.speed != null ? <span className="mapchip num">{Math.round(fix.speed)} km/h</span> : null} />
          <IssueCard issue={selected} />
        </>,
      },
    }} />
  );
}
