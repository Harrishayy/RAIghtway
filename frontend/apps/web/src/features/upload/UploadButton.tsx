'use client';
import { useRef, useState } from 'react';
import { useClient } from '@/domain/client';
import { useUpload } from '@/domain/queries';
import { toast } from '@/state/toast';
import { Icon } from '@/ui/Icon';

/** Sends one or more clips; each starts its own analysis. Hidden when the backend can't take uploads. */
export function UploadButton({ compact }: { compact?: boolean }) {
  const c = useClient(); const up = useUpload(); const input = useRef<HTMLInputElement>(null); const [pct, setPct] = useState<number | null>(null);
  if (!c.capabilities.upload) return null;
  const send = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      // the backend takes MP4 only; names like set04_video_0008_t0310.mp4 also give it the drive and start time
      if (!/\.mp4$/i.test(file.name)) { toast({ tone: 'bad', title: 'Upload an MP4 file', body: file.name }); continue; }
      setPct(0); try { await up.mutateAsync({ file, onProgress: setPct }); } catch { /* toast shown by the hook */ } }
    setPct(null); if (input.current) input.current.value = '';
  };
  return (
    <>
      <input ref={input} type="file" accept="video/mp4,.mp4" multiple hidden onChange={e => void send(e.target.files)} />
      <button type="button" className={`btn btn-primary btn-sm${compact ? ' btn-icon' : ''}`} onClick={() => input.current?.click()} disabled={pct !== null} aria-label="Upload footage">
        <Icon name="upload" />{compact ? null : pct !== null ? `Uploading ${Math.round(pct * 100)}%` : 'Upload'}
      </button>
    </>
  );
}
