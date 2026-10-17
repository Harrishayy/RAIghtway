import { parseRich } from '@raightway/core';
/** Model text with `**bold**` markers. Never renders HTML from the model. */
export function RichText({ text, className }: { text: string | null | undefined; className?: string }) {
  const parts = parseRich(text);
  return <p className={className}>{parts.map((p, i) => (p.strong ? <b key={i}>{p.text}</b> : <span key={i}>{p.text}</span>))}</p>;
}
