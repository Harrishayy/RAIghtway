'use client';
// A small frame thumbnail. Shows the backend's JPEG when it loads; otherwise (no image served, or a 404)
// a neutral tile with the category glyph, so a list of thumbnails never shows broken images.
import { useState } from 'react';
import type { CategoryId } from '@raightway/core';
import { Icon } from './Icon';

export function Thumb({ src, category }: { src: string | null; category: CategoryId }) {
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span className="thumb" data-cat={category} aria-hidden="true">
      {src && failed !== src ? <img src={src} alt="" loading="lazy" onError={() => setFailed(src)} /> : <Icon name={category} />}
    </span>
  );
}
