'use client';
// Footage, HUD and transport. Plays the backend's video when it serves one; otherwise a clock drives
// the playhead and the frame steps through findings. Either way every view follows the same playhead.
import { useCallback, useEffect, useRef, useState } from 'react';
import { fmtClock, fmtCoord, fmtTimecode, hashStr, issueLabel, type Issue, type Video } from '@raightway/core';
import { useClient } from '@/domain/client';
import { fixAt, issueAt } from '@/domain/derive';
import { usePlayback } from '@/state/playback';
import { useUi } from '@/state/ui';
import { Frame } from '@/ui/Footage/Frame';
import { Icon } from '@/ui/Icon';
import { Seg } from '@/ui/Seg';
import { EditLayer, MarkForm, MarkLayer, type MarkDraft } from './MarkIssue';

const HOLD_MS = 1100;

export function Player({ video, issues }: { video: Video; issues: Issue[] }) {
  const client = useClient(); const url = client.videoUrl(video);
  // a 404 or undecodable file falls back to stepping through keyframes. Keyed by status too: a Run clip 404s
  // until it has been fetched from VAST, so a status change (analysing -> done) tries the file again.
  const fileKey = url ? `${url}|${video.status}` : null;
  const [badUrl, setBadUrl] = useState<string | null>(null); const src = url && fileKey !== badUrl ? url : null;
  const { t, playing, seekNonce, setPlaying, seek, tick, select } = usePlayback();
  const rate = useUi(s => s.rate); const setRate = useUi(s => s.setRate);
  const el = useRef<HTMLVideoElement>(null);
  const [mediaDur, setMediaDur] = useState(0);
  // While playing, passing a finding holds on its keyframe with the box for HOLD_MS, then playback carries on.
  // The box only fits that exact frame (the camera keeps moving), so at 2x or 4x it would otherwise just flash.
  // A hold is tied to the seek and file it started on, so pausing, seeking or switching drives ends it at once.
  const [hold, setHold] = useState<{ id: string; nonce: number; src: string | null } | null>(null); const holdTimer = useRef(0);
  const dur = video.duration_s || mediaDur;
  const rates = src ? [1, 2, 4] : [1, 4, 16]; const r = rates.includes(rate) ? rate : rates[1]!;
  // Mark issue: paused on the current frame, the operator boxes and files an issue (MarkIssue.tsx).
  // `form` keys the form: a new key starts it fresh; redrawing an edit as a new issue keeps the values typed so far.
  const [stored, setDraft] = useState<(MarkDraft & { videoId: string; form: number }) | null>(null);
  const sample = client.id === 'mock';
  // a real backend grabs the keyframe from the playable file, so a new issue needs one; editing a finding does not
  const canCreate = client.capabilities.markIssues && (sample || Boolean(src));
  // the finding "Mark issue" edits: the one selected on the playback when it is near the playhead, else the one at it
  const editTarget = useCallback((): Issue | null => {
    const s = usePlayback.getState(); const sel = issues.find(i => i.id === s.selectedIssue && !i.provisional);
    if (sel) { const d = s.t - sel.t; if (d > -1.2 && d < 7) return sel; }
    const at = issueAt(issues, s.t); return at && !at.provisional ? at : null;
  }, [issues]);
  const startMark = useCallback(() => {
    setPlaying(false); const target = editTarget();
    if (target) { select(target.id); setDraft({ videoId: video.id, t: target.t, box: target.bbox, target, form: Date.now() }); return; }
    if (canCreate) setDraft({ videoId: video.id, t: usePlayback.getState().t, box: null, form: Date.now() });
  }, [setPlaying, editTarget, select, canCreate, video.id]);
  // a mark belongs to its drive; scrubbing while marking moves a new one to the new frame (a box from the old frame
  // no longer fits). An edit stays on its finding's keyframe.
  const draft = stored && stored.videoId === video.id ? (!stored.target && Math.abs(stored.t - t) > 0.04 ? { ...stored, t, box: null } : stored) : null;
  const editing = draft?.target ?? null;
  const marking = Boolean(draft);
  const setBox = (box: MarkDraft['box']) => setDraft(draft ? { ...draft, box } : null);

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
  useEffect(() => () => window.clearTimeout(holdTimer.current), []);
  // push seeks into the <video>
  useEffect(() => { const v = el.current; if (v && Math.abs(v.currentTime - usePlayback.getState().t) > 0.25) v.currentTime = usePlayback.getState().t; }, [seekNonce]);
  // pull time from the <video>
  useEffect(() => {
    const v = el.current; if (!v || !src) return; let id = 0;
    const onFrame = () => {
      const s = usePlayback.getState(); const t1 = v.currentTime; const passed = issues.find(i => i.t > s.t && i.t <= t1);
      if (passed && s.playing && passed.bbox && !passed.provisional) {
        v.pause(); s.select(passed.id); tick(passed.t); setHold({ id: passed.id, nonce: s.seekNonce, src }); window.clearTimeout(holdTimer.current);
        holdTimer.current = window.setTimeout(() => { setHold(null); if (usePlayback.getState().playing) void v.play().catch(() => setPlaying(false)); }, HOLD_MS);
      } else { if (passed) s.select(passed.id); tick(t1); }
      id = v.requestVideoFrameCallback?.(onFrame) ?? 0;
    };
    id = v.requestVideoFrameCallback?.(onFrame) ?? 0; const onTime = () => { if (!v.requestVideoFrameCallback) tick(v.currentTime); };
    v.addEventListener('timeupdate', onTime); v.addEventListener('ended', () => setPlaying(false));
    return () => { v.cancelVideoFrameCallback?.(id); v.removeEventListener('timeupdate', onTime); };
  }, [src, issues, tick, setPlaying]);
  // keyboard: K / space play, [ ] previous/next finding, ← → five seconds
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tg = e.target as HTMLElement; if (tg.closest('input,textarea,select,[contenteditable]')) return;
      if (marking) return;                                 // marking: the form owns the keyboard
      if ((e.key === 'm' || e.key === 'M') && client.capabilities.markIssues && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); startMark(); return; }
      if (e.key === 'k' || e.key === 'K' || (e.key === ' ' && !tg.closest('button'))) { e.preventDefault(); setPlaying(!usePlayback.getState().playing); }
      else if (e.key === '[') step(-1); else if (e.key === ']') step(1);
      else if (e.key === 'ArrowLeft' && !tg.closest('[role=separator],.pane-grip')) seek(Math.max(0, usePlayback.getState().t - 5));
      else if (e.key === 'ArrowRight' && !tg.closest('[role=separator],.pane-grip')) seek(Math.min(dur, usePlayback.getState().t + 5));
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [step, seek, setPlaying, dur, marking, client.capabilities.markIssues, startMark]);

  const near = issueAt(issues, t);
  // real backends: without a video file, hold the nearest real keyframe (never a drawn stand-in)
  const held = !sample && !near ? issues.reduce<Issue | null>((b, i) => (!b || Math.abs(i.t - t) < Math.abs(b.t - t) ? i : b), null) : null;
  const shown = near ?? held; const fix = fixAt(video, t);
  // On footage the camera moves, so a box only fits close to its keyframe; paused on a finding, show that
  // exact keyframe over the video so the box sits on what the model saw.
  const d = near ? t - near.t : Infinity;
  const holding = hold && playing && hold.nonce === seekNonce && hold.src === src ? issues.find(i => i.id === hold.id) ?? null : null;
  const boxed = holding ?? (src ? (d > -0.6 && d < (playing ? 0.35 : 0.6) ? near : null) : shown);
  const still = Boolean(src && boxed && (!playing || holding));
  const drift = shown ? (t - shown.t + 1.2) / 8.2 : (t % 9) / 9;
  return (
    <>
      <Frame placeholder={sample ? 'scene' : 'blank'} emptyLabel={issues.length ? 'No frame' : video.status === 'done' ? 'No findings on this drive' : 'Analysing…'}
        issue={editing ?? (draft ? null : boxed)} src={editing ? client.frameUrl(editing) : !draft && boxed ? client.frameUrl(boxed) : null} still={editing ? true : draft ? false : still}
        overlay={editing ? <EditLayer /> : draft ? <MarkLayer box={draft.box} onBox={setBox} /> : undefined} seed={hashStr(`${video.id}${Math.floor(t / 9)}`)} drift={drift}
        video={src ? <video ref={el} src={src} playsInline muted preload="metadata" onLoadedMetadata={e => setMediaDur(e.currentTarget.duration || 0)} onError={() => setBadUrl(fileKey)} /> : undefined}
        hud={{
          tl: <><span className="rec" /><span className="hud-cam">{video.camera_id ?? 'camera'} · </span>{video.drive ?? video.filename}</>,
          bl: fix ? <><span className="hud-gps">{fmtCoord(fix.at[0], fix.at[1])}{fix.speed != null ? ' · ' : ''}</span>{fix.speed != null ? `${Math.round(fix.speed)} km/h` : ''}</> : null,
          br: held ? <>keyframe {fmtTimecode(held.t)}</> : fmtTimecode(video.start_s + t),
        }} />
      {draft ? (
        <MarkForm key={draft.form} video={video} draft={draft} defaultCategory={near?.category ?? 'pavement'} canCreate={canCreate} onClearBox={() => setBox(null)}
          onRedraw={() => { seek(draft.t); setDraft({ ...draft, target: null }); }} onNew={() => { seek(draft.t); setDraft({ videoId: video.id, t: draft.t, box: null, form: Date.now() }); }}
          onCancel={() => setDraft(null)} onSaved={i => { setDraft(null); select(i.id); }} />
      ) : (
      <div className="transport">
        <span className="transport-keys">
          <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={() => step(-1)} aria-label="Previous finding" title="Previous finding [">{<Icon name="prev" />}</button>
          <button type="button" className="btn btn-primary btn-sm btn-icon" onClick={() => { if (!playing && t >= dur - 0.1) seek(0); setPlaying(!playing); }} aria-label={playing ? 'Pause' : 'Play'} title="Play / pause (K)"><Icon name={playing ? 'pause' : 'play'} /></button>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={() => step(1)} aria-label="Next finding" title="Next finding ]"><Icon name="next" /></button>
        </span>
        <span className="tc num">{fmtTimecode(t)}<small> / {fmtClock(dur)}</small></span>
        <span className="speed"><span className="speed-l">Speed</span><Seg label="Playback speed" value={r} onChange={setRate} options={rates.map(x => ({ value: x, label: `${x}×` }))} /></span>
        {client.capabilities.markIssues ? (
          <button type="button" className="btn btn-secondary btn-sm mark-btn" onClick={startMark} disabled={!canCreate && !near}
            title={near ? `Mark issue: edit “${issueLabel(near)}” or save as new (M)` : canCreate ? 'Mark an issue on this frame (M)' : 'Marking needs the playable footage for this drive'}><Icon name="plus" /><span className="mark-btn-l">Mark issue</span></button>
        ) : null}
      </div>
      )}
    </>
  );
}
