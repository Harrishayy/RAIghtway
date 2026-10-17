'use client';
// Footage, HUD and transport. Plays the backend's video when it serves one; otherwise a clock drives
// the playhead and the frame steps through findings. Either way every view follows the same playhead.
import { useCallback, useEffect, useRef, useState } from 'react';
import { fmtClock, fmtCoord, fmtTimecode, hashStr, type Issue, type Video } from '@raightway/core';
import { useClient } from '@/domain/client';
import { fixAt, issueAt } from '@/domain/derive';
import { usePlayback } from '@/state/playback';
import { useUi } from '@/state/ui';
import { Frame } from '@/ui/Footage/Frame';
import { Icon } from '@/ui/Icon';
import { Seg } from '@/ui/Seg';

export function Player({ video, issues }: { video: Video; issues: Issue[] }) {
  const client = useClient(); const src = client.videoUrl(video);
  const { t, playing, seekNonce, setPlaying, seek, tick, select } = usePlayback();
  const rate = useUi(s => s.rate); const setRate = useUi(s => s.setRate);
  const el = useRef<HTMLVideoElement>(null);
  const [mediaDur, setMediaDur] = useState(0);
  const dur = video.duration_s || mediaDur;
  const rates = src ? [1, 2, 4] : [1, 4, 16]; const r = rates.includes(rate) ? rate : rates[1]!;

  const step = useCallback((dir: 1 | -1) => {
    const cur = usePlayback.getState().t + 0.41;
    const target = dir > 0 ? issues.find(i => i.t > cur + 0.05) : [...issues].reverse().find(i => i.t < cur - 0.6);
    if (target) { setPlaying(false); select(target.id); seek(Math.max(0, target.t - 0.4)); }
  }, [issues, seek, select, setPlaying]);

  // the clock: a real <video> or a virtual one
  useEffect(() => {
    if (!playing) { el.current?.pause(); return; }
    if (src && el.current) { el.current.playbackRate = r; void el.current.play().catch(() => setPlaying(false)); return; }
    let raf = 0, last = 0;
    const loop = (ts: number) => {
      const s = usePlayback.getState(); const dt = last ? (ts - last) / 1000 : 0; last = ts;
      const t0 = s.t, t1 = Math.min(dur, t0 + dt * r);
      const passed = issues.find(i => i.t > t0 && i.t <= t1); if (passed) s.select(passed.id);
      s.tick(t1); if (t1 >= dur) { s.setPlaying(false); return; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop); return () => cancelAnimationFrame(raf);
  }, [playing, src, r, dur, issues, setPlaying]);
  // push seeks into the <video>
  useEffect(() => { const v = el.current; if (v && Math.abs(v.currentTime - usePlayback.getState().t) > 0.25) v.currentTime = usePlayback.getState().t; }, [seekNonce]);
  // pull time from the <video>
  useEffect(() => {
    const v = el.current; if (!v || !src) return; let id = 0;
    const onFrame = () => { const s = usePlayback.getState(); const t1 = v.currentTime; const passed = issues.find(i => i.t > s.t && i.t <= t1); if (passed) s.select(passed.id); tick(t1); id = v.requestVideoFrameCallback?.(onFrame) ?? 0; };
    id = v.requestVideoFrameCallback?.(onFrame) ?? 0; const onTime = () => { if (!v.requestVideoFrameCallback) tick(v.currentTime); };
    v.addEventListener('timeupdate', onTime); v.addEventListener('ended', () => setPlaying(false));
    return () => { v.cancelVideoFrameCallback?.(id); v.removeEventListener('timeupdate', onTime); };
  }, [src, issues, tick, setPlaying]);
  // keyboard: K / space play, [ ] previous/next finding, ← → five seconds
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tg = e.target as HTMLElement; if (tg.closest('input,textarea,select,[contenteditable]')) return;
      if (e.key === 'k' || e.key === 'K' || (e.key === ' ' && !tg.closest('button'))) { e.preventDefault(); setPlaying(!usePlayback.getState().playing); }
      else if (e.key === '[') step(-1); else if (e.key === ']') step(1);
      else if (e.key === 'ArrowLeft' && !tg.closest('[role=separator],.pane-grip')) seek(Math.max(0, usePlayback.getState().t - 5));
      else if (e.key === 'ArrowRight' && !tg.closest('[role=separator],.pane-grip')) seek(Math.min(dur, usePlayback.getState().t + 5));
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [step, seek, setPlaying, dur]);

  const shown = issueAt(issues, t); const fix = fixAt(video, t);
  const drift = shown ? (t - shown.t + 1.2) / 8.2 : (t % 9) / 9;
  return (
    <>
      <Frame issue={src ? null : shown} src={shown ? client.frameUrl(shown) : null} seed={hashStr(`${video.id}${Math.floor(t / 9)}`)} drift={drift}
        video={src ? <video ref={el} src={src} playsInline muted preload="metadata" onLoadedMetadata={e => setMediaDur(e.currentTarget.duration || 0)} /> : undefined}
        hud={{
          tl: <><span className="rec" /><span className="hud-cam">{video.camera_id ?? 'camera'} · </span>{video.drive ?? video.filename}</>,
          bl: fix ? <><span className="hud-gps">{fmtCoord(fix.at[0], fix.at[1])}{fix.speed != null ? ' · ' : ''}</span>{fix.speed != null ? `${Math.round(fix.speed)} km/h` : ''}</> : null,
          br: fmtTimecode(video.start_s + t),
        }} />
      <div className="transport">
        <span className="transport-keys">
          <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={() => step(-1)} aria-label="Previous finding" title="Previous finding [">{<Icon name="prev" />}</button>
          <button type="button" className="btn btn-primary btn-sm btn-icon" onClick={() => { if (!playing && t >= dur - 0.1) seek(0); setPlaying(!playing); }} aria-label={playing ? 'Pause' : 'Play'} title="Play / pause (K)"><Icon name={playing ? 'pause' : 'play'} /></button>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={() => step(1)} aria-label="Next finding" title="Next finding ]"><Icon name="next" /></button>
        </span>
        <span className="tc num">{fmtTimecode(t)}<small> / {fmtClock(dur)}</small></span>
        <span className="speed"><span className="speed-l">Speed</span><Seg label="Playback speed" value={r} onChange={setRate} options={rates.map(x => ({ value: x, label: `${x}×` }))} /></span>
      </div>
    </>
  );
}
