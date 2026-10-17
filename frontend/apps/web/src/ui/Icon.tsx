import type { CategoryId } from '@raightway/core';

const P = {
  graffiti: <><rect x="7" y="9" width="9" height="12" rx="2" /><path d="M9 9V6h5v3M11.5 6V3.5M18.5 5h.01M20.5 3h.01M20.5 7.5h.01" /></>,
  markings: <path d="M5 3v18M19 3v18M12 4v3M12 10.5v3M12 17v3" />,
  work_zone: <path d="M9.8 4h4.4l4.3 15.5h-13z M7.9 10.5h8.2M6.6 15h10.8M3 20h18" />,
  pavement: <><path d="M3 18h18" /><ellipse cx="12" cy="13" rx="7" ry="3" /><path d="M8.5 12.6l1.8 1 1.9-1.4 1.9 1.4 1.4-.8" /></>,
  signage: <><path d="M8.6 2.5h6.8l3.1 3.1v4.8l-3.1 3.1H8.6l-3.1-3.1V5.6z" /><path d="M12 13.5V21" /></>,
  waste: <path d="M4.5 7h15M10 7V4h4v3M6.5 7l1 13h9l1-13M10 11v5M14 11v5" />,
  play: <path d="M7 4.5v15l12.5-7.5z" fill="currentColor" />,
  pause: <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" stroke="none" />,
  prev: <><path d="M18 5.5L9.5 12l8.5 6.5z" /><path d="M6 5v14" /></>,
  next: <><path d="M6 5.5l8.5 6.5L6 18.5z" /><path d="M18 5v14" /></>,
  grip: <><circle cx="9" cy="6" r="1.2" /><circle cx="15" cy="6" r="1.2" /><circle cx="9" cy="12" r="1.2" /><circle cx="15" cy="12" r="1.2" /><circle cx="9" cy="18" r="1.2" /><circle cx="15" cy="18" r="1.2" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></>,
  zoom: <><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2M11 8v6M8 11h6" /></>,
  expand: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  upload: <path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />,
  route: <><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="6" r="2.5" /><path d="M8.5 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5" /></>,
  plus: <path d="M12 5v14M5 12h14" />, minus: <path d="M5 12h14" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  pin: <><path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.3" /></>,
  film: <><rect x="3.5" y="5" width="17" height="14" rx="2" /><path d="M3.5 9.5h17M3.5 14.5h17M8 5v14M16 5v14" /></>,
  report: <><path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 6 20V4a.5.5 0 0 1 .5-.5z" /><path d="M9 12h6M9 15.5h6M9 8.5h3" /></>,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  refresh: <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" />,
  layout: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M9 4.5v15M15 4.5v15" /></>,
  plug: <path d="M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 0 1-11 0zM12 16.5V21" />,
  alert: <><path d="M12 3.5l9.5 16.5h-19z" /><path d="M12 10v4.5M12 17.5h.01" /></>,
  list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  site: <path d="M3 20V9l9-5 9 5v11M3 20h18M9 20v-6h6v6" />,
  spark: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6" />,
} as const;
export type IconName = keyof typeof P;

export function Icon({ name, className, title }: { name: IconName | CategoryId; className?: string; title?: string }) {
  return (
    <svg className={`ic${className ? ` ${className}` : ''}`} viewBox="0 0 24 24" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      {P[name as IconName]}
    </svg>
  );
}
