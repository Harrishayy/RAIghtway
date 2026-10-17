'use client';
// Mark issue: the operator pauses on a frame, drags a box round what they see, and files it with a category,
// a severity, a few words and an optional name. A new one is saved as an operator report (source "manual"),
// never as a model finding; the backend adds the keyframe, GPS, a Nemotron work order and an embedding when it can.
// Edit mode: started on a finding (selected on the playback, or at the playhead), the form opens prefilled from
// it and Save updates that issue (name, pin, operator severity: overlay rows, nothing is rewritten). Its box and
// category are what the model found, so they stay read-only; "Save as new issue" files a manual one instead.
// Keyboard: M or the button starts, Esc cancels, Enter saves (new: once a box exists; no box = the whole frame).
import { useEffect, useId, useRef, useState } from 'react';
import { CATEGORIES, CATEGORY, SEVERITY, clamp, fmtTimecode, issueLabel, severityDef, type BBox, type CategoryId, type Issue, type Severity, type Video } from '@raightway/core';
import { useCreateIssue, useUpdateIssue } from '@/domain/queries';
import { toast } from '@/state/toast';
import { Icon } from '@/ui/Icon';
import { Seg } from '@/ui/Seg';

/** `target`: the finding being edited (edit mode); absent or null for a new issue. */
export interface MarkDraft { t: number; box: BBox | null; target?: Issue | null }

const MIN = 0.01;   // a drag smaller than 1% of the frame is a click, not a box
export const NAME_MAX = 80;

/** Drawn over the paused frame: press and drag to box the issue; the box can be redrawn. */
export function MarkLayer({ box, onBox }: { box: BBox | null; onBox: (b: BBox | null) => void }) {
  const layer = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<BBox | null>(null);
  const shown = live ?? box;
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = layer.current; if (!el || e.button !== 0) return;
    e.preventDefault(); el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    const at = (ev: { clientX: number; clientY: number }) => [clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1)] as const;
    const [x0, y0] = at(e);
    const rect = (ev: { clientX: number; clientY: number }): BBox => { const [x1, y1] = at(ev); return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) }; };
    el.onpointermove = ev => setLive(rect(ev));
    el.onpointerup = ev => {
      el.onpointermove = null; el.onpointerup = null; setLive(null);
      const b = rect(ev); if (b.w >= MIN && b.h >= MIN) onBox(b);
    };
  };
  return (
    <div ref={layer} className="mark-layer" onPointerDown={down} aria-hidden="true">
      {shown ? (
        <div className="mark-draft" style={{ left: `${shown.x * 100}%`, top: `${shown.y * 100}%`, width: `${shown.w * 100}%`, height: `${shown.h * 100}%` }}>
          <span className="mark-draft-tag">New issue</span>
        </div>
      ) : <span className="mark-hint">Drag to box the issue · Esc cancels</span>}
    </div>
  );
}

/** Edit mode: the finding's own box (drawn by Frame) is shown as is; this only frames it and says so. */
export function EditLayer() {
  return <div className="mark-layer is-edit" aria-hidden="true"><span className="mark-hint">Editing this finding · box is the model’s</span></div>;
}

const cleanName = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();

/** The compact form under the frame while marking or editing. New: POST /api/issues. Edit: PATCH /api/issues/{id}. */
export function MarkForm({ video, draft, defaultCategory, canCreate, onClearBox, onRedraw, onNew, onCancel, onSaved }: {
  video: Video; draft: MarkDraft; defaultCategory: CategoryId;
  /** A new issue needs the playable footage on a real backend (the keyframe is grabbed from it). */
  canCreate: boolean;
  onClearBox: () => void;
  /** Edit mode → new issue at the playhead with this box, keeping the form's values. */
  onRedraw: () => void;
  /** Edit mode → a blank new issue. */
  onNew: () => void;
  onCancel: () => void; onSaved: (i: Issue) => void;
}) {
  const target = draft.target ?? null; const editing = Boolean(target);
  const [category, setCategory] = useState<CategoryId>(target?.category ?? defaultCategory);
  const [severity, setSeverity] = useState<Severity>(target?.severity ?? 3);
  const [description, setDescription] = useState(target?.description ?? '');
  const [name, setName] = useState(target?.name ?? '');
  const [pinned, setPinned] = useState(target ? Boolean(target.pinned) : true);
  const create = useCreateIssue(); const update = useUpdateIssue();
  const pending = create.isPending || update.isPending; const failed = create.isError ? create.error : update.isError ? update.error : null;
  const form = useRef<HTMLFormElement>(null); const first = useRef<HTMLSelectElement>(null); const nameEl = useRef<HTMLInputElement>(null);
  const id = useId();

  const saveNew = () => {
    if (pending || !canCreate) return;
    const n = cleanName(name);
    create.mutate({ video_id: video.id, t: draft.t, category, severity, description: description.trim(), bbox: draft.box, pinned, ...(n ? { name: n } : {}) }, { onSuccess: onSaved });
  };
  const saveEdit = () => {
    if (pending || !target) return;
    const n = cleanName(name);
    const patch = {
      ...(n !== (target.name ?? '') ? { name: n } : {}),                        // "" clears the name
      ...(pinned !== Boolean(target.pinned) ? { pinned } : {}),
      ...(severity !== target.severity ? { severity } : {}),
    };
    if (!Object.keys(patch).length) { onCancel(); return; }
    update.mutate({ id: target.id, patch }, {
      onSuccess: i => { toast({ tone: 'ok', title: 'Issue updated', body: issueLabel(i) }); onSaved(i); },
    });
  };
  const save = () => (editing ? saveEdit() : saveNew());
  // the fields Save cannot change on an existing finding (they are the model's), so the operator is told
  const unsaved = editing && (category !== target!.category || description.trim() !== target!.description);

  // keyboard focus lands in the form so the whole flow works without a pointer: on the name when editing
  useEffect(() => { (editing ? nameEl.current : first.current)?.focus({ preventScroll: true }); }, [editing]);
  // Esc cancels from anywhere; Enter outside the form's fields saves (a new issue once a box is drawn)
  const latest = useRef({ save, onCancel, ready: editing || Boolean(draft.box) });
  useEffect(() => { latest.current = { save, onCancel, ready: editing || Boolean(draft.box) }; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('.lightbox')) return;     // a photo open on top owns the keys
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); latest.current.onCancel(); return; }
      if (e.key !== 'Enter') return;
      const tg = e.target as HTMLElement;
      if (form.current?.contains(tg) && tg.closest('input,select,textarea,button')) return;   // the form handles its own Enter
      if (latest.current.ready) { e.preventDefault(); latest.current.save(); }
    };
    window.addEventListener('keydown', onKey, true); return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const label = target ? issueLabel(target) : '';
  return (
    <form ref={form} className={`markform${editing ? ' is-edit' : ''}`} aria-label={editing ? `Edit issue: ${label}` : 'Mark a new issue on this frame'} onSubmit={e => { e.preventDefault(); save(); }}>
      <div className="markform-h">
        {editing ? (
          <b className="markform-title"><span className="markform-mode">Edit</span><span className="markform-label" title={label}>{label}</span></b>
        ) : <b className="markform-title"><span className="markform-mode is-new">New issue</span></b>}
        <span className="mono muted small">at {fmtTimecode(draft.t)}</span>
        {editing ? (
          <span className="markform-box small"><button type="button" className="link" onClick={onRedraw} disabled={!canCreate || pending}>Redraw box</button><button type="button" className="link" onClick={onNew} disabled={!canCreate || pending}>Blank form</button></span>
        ) : (
          <span className="markform-box small">{draft.box ? <>Box drawn <button type="button" className="link" onClick={onClearBox}>Clear</button></> : <span className="muted">No box: whole frame</span>}</span>
        )}
      </div>
      <label className="markform-field" htmlFor={`${id}-name`}><span className="label">Name <span className="muted">optional, shows on maps and lists</span></span>
        <input id={`${id}-name`} ref={nameEl} value={name} maxLength={NAME_MAX} onChange={e => setName(e.target.value)} placeholder="e.g. King & Bathurst pothole" autoComplete="off" />
      </label>
      <div className="markform-row">
        <label className="markform-field" htmlFor={`${id}-cat`}><span className="label">Category</span>
          <select id={`${id}-cat`} ref={first} value={category} onChange={e => setCategory(e.target.value as CategoryId)} data-cat={category}>
            {CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
        <div className="markform-field"><span className="label" id={`${id}-sev`}>Severity · {severityDef(severity).label}{editing && severity !== target!.severity ? ' · operator grade' : ''}</span>
          <Seg size="sm" label="Severity, 1 to 5" value={severity} onChange={v => setSeverity(v as Severity)} options={SEVERITY.map(s => ({ value: s.level as number, label: `S${s.level}` }))} />
        </div>
      </div>
      <label className="markform-field" htmlFor={`${id}-desc`}><span className="label">What is it</span>
        <input id={`${id}-desc`} value={description} maxLength={200} onChange={e => setDescription(e.target.value)} placeholder={`e.g. ${CATEGORY[category].label.toLowerCase()} by the curb`} autoComplete="off" />
      </label>
      <label className="markform-check"><input type="checkbox" checked={pinned} onChange={e => setPinned(e.target.checked)} /><span>Include in next plan</span><span className="muted small">pinned: must-do in triage</span></label>
      {unsaved ? <p className="markform-note small">Category and description are the finding’s own: changes to them are kept only with <b>Save as new issue</b>.</p> : null}
      {editing && !canCreate ? <p className="markform-note small muted">Save as new needs the playable footage for this drive.</p> : null}
      {failed ? <p className="markform-err small" role="alert">{(failed as Error).message}. Try again.</p> : null}
      <div className="markform-actions">
        <button type="submit" className="btn btn-primary btn-sm" disabled={pending || (!editing && !canCreate)}><Icon name="check" />{pending ? 'Saving…' : editing ? 'Save' : 'Save issue'}</button>
        {editing ? <button type="button" className="btn btn-secondary btn-sm" onClick={saveNew} disabled={pending || !canCreate}><Icon name="plus" />Save as new issue</button> : null}
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={pending}>Cancel</button>
        <span className="muted small markform-keys" aria-live="polite">{create.isPending ? 'Grabbing the frame and writing the work order…' : update.isPending ? 'Saving…' : <><span className="kbd">Enter</span> saves · <span className="kbd">Esc</span> cancels</>}</span>
      </div>
    </form>
  );
}
