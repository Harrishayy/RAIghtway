'use client';
// Review: footage, player + timeline + detections, and map + the selected issue, as movable panes.
import { useEffect, useMemo } from 'react';
import { isOpen, type Issue } from '@raightway/core';
import { byTime, fixAt, landingIssue } from '@/domain/derive';
import { useIssues, useVideo, useVideos } from '@/domain/queries';
import { usePlayback } from '@/state/playback';
import { useCategories, useUi } from '@/state/ui';
import { Desk } from '@/layout/Desk';
import { MapView } from '@/features/map/MapView';
import { IssueCard } from '@/features/issues/IssueCard';
import { Seg } from '@/ui/Seg';
import { Empty, Failed, Loading } from '@/ui/State';
import { RunButton } from '@/features/run/RunButton';
import { FootageList } from './FootageList';
import { Player } from './Player';
import { Timeline } from './Timeline';
import { Detections } from './Detections';
import { FilterNote } from './FilterNote';
import { ChatPanel } from './ChatPanel';

export function ReviewDesk() {
  const videos = useVideos(); const allIssues = useIssues(); const cats = useCategories();
  const { videoId, t, selectedIssue, open, select } = usePlayback();
  const mapView = useUi(s => s.mapView); const setMapView = useUi(s => s.setMapView);
  const rightPane = useUi(s => s.rightPane); const setRightPane = useUi(s => s.setRightPane);
  // once data arrives, open on the best demo pick from the footage review, else the first finished drive
  useEffect(() => {
    if (videoId || !videos.data?.length) return;
    const pick = landingIssue((allIssues.data ?? []).filter(i => i.featured != null && cats.includes(i.category)));
    if (pick && videos.data.some(v => v.id === pick.video_id)) { open(pick.video_id, Math.max(0, pick.t - 0.4), pick.id); return; }
    if (allIssues.isPending) return;
    const v = videos.data.find(x => x.status === 'done') ?? videos.data[0]!; open(v.id);
  }, [videoId, videos.data, allIssues.data, allIssues.isPending, cats, open]);
  const detail = useVideo(videoId);
  const video = detail.data?.video ?? videos.data?.find(v => v.id === videoId);
  const issues = useMemo(() => (detail.data?.issues ?? []).filter(i => cats.includes(i.category)).sort(byTime), [detail.data, cats]);
  // land on the drive's best demo pick, else its first finding, rather than an empty road
  useEffect(() => { const first = landingIssue(issues); if (!selectedIssue && first && detail.data?.video.id === videoId) { select(first.id); if (usePlayback.getState().t === 0) usePlayback.getState().seek(Math.max(0, first.t - 0.4)); } }, [selectedIssue, issues, select, detail.data, videoId]);
  const pool = useMemo(() => { const m = new Map<string, Issue>(); (allIssues.data ?? []).forEach(i => m.set(i.id, i)); issues.forEach(i => m.set(i.id, i)); return m; }, [allIssues.data, issues]);
  const selected = selectedIssue ? pool.get(selectedIssue) : null;
  // map pins: open issues only; findings the rating judged not to be defects stay off the map
  const mapIssues = useMemo(() => [...pool.values()].filter(i => cats.includes(i.category) && isOpen(i)), [pool, cats]);
  const fix = fixAt(video, t);

  const playerBody = detail.isError ? <Failed error={detail.error} onRetry={() => void detail.refetch()} />
    : !video ? (videos.isPending || detail.isPending ? <Loading rows={5} /> : <Empty title="No drive open">Pick one from Footage.</Empty>)
    : <div className="player"><Player video={video} issues={issues} /><FilterNote all={detail.data?.issues} cats={cats} /><Timeline video={video} issues={issues} cats={cats} /><Detections issues={issues} /></div>;

  return (
    <Desk panes={{
      footage: { id: 'footage', title: 'Footage', actions: <RunButton />, body: <FootageList /> },
      player: { id: 'player', title: 'Player', actions: video ? <span className="fname mono muted">{video.filename}</span> : null, body: playerBody },
      map: {
        id: 'map', title: rightPane === 'chat' ? 'Chat' : 'Map',
        actions: <span className="pane-tabs">
          {rightPane === 'map' ? <Seg size="sm" label="Map extent" value={mapView} onChange={setMapView} options={[{ value: 'drive', label: 'Drive' }, { value: 'city', label: 'City' }]} /> : null}
          <Seg size="sm" label="Map or chat" value={rightPane} onChange={setRightPane} options={[{ value: 'map', label: 'Map' }, { value: 'chat', label: 'Chat' }]} />
        </span>,
        body: rightPane === 'chat' ? <ChatPanel video={video} issues={issues} /> : <>
          <MapView label={video ? `Map of ${video.drive ?? video.filename}` : 'Map'} issues={mapIssues} emphasise={i => i.video_id === videoId} selectedId={selectedIssue}
            onSelect={i => (i.video_id === videoId ? (select(i.id), usePlayback.getState().seek(Math.max(0, i.t - 0.4))) : open(i.video_id, Math.max(0, i.t - 0.4), i.id))}
            track={video?.track} travelled={video?.duration_s ? t / video.duration_s : 0} vehicle={fix} focus={mapView === 'city' ? [] : video?.track}
            overlay={fix?.speed != null ? <span className="mapchip num">{Math.round(fix.speed)} km/h</span> : null} className="map-scale" />
          <IssueCard issue={selected} />
        </>,
      },
    }} />
  );
}
