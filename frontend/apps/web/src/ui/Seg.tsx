// Segmented control: a group of toggle buttons with one value.
export function Seg<T extends string | number>({ value, options, onChange, label, size }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string; size?: 'sm' }) {
  return (
    <span className={`seg${size ? ` seg-${size}` : ''}`} role="group" aria-label={label}>
      {options.map(o => <button key={String(o.value)} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </span>
  );
}
