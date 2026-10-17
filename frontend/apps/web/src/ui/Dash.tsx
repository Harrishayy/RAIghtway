// Dash, the cone: shows what the pipeline is doing. Shapes stay put; props and the face change per state.
export type DashState = 'idle' | 'scan' | 'spot' | 'check' | 'plan' | 'route' | 'fail' | 'done';
const LABEL: Record<DashState, string> = { idle: 'Idle', scan: 'Scanning footage', spot: 'Spotted an issue', check: 'Checking history', plan: 'Planning repairs', route: 'Routing crews', fail: 'Something failed', done: 'Done' };
const MOUTH: Partial<Record<DashState, string>> = { done: 'M28.5 24.5Q32 29 35.5 24.5', spot: 'M30.6 26a1.4 1.4 0 1 0 2.8 0a1.4 1.4 0 1 0-2.8 0', fail: 'M29 26.5q1.5-1.6 3 0t3 0', plan: 'M30 25.5h4', check: 'M30 25.5h4' };

export function Dash({ state = 'idle', size = 64 }: { state?: DashState; size?: number }) {
  const big = state === 'spot'; const r = big ? 2.8 : 2.2;
  return (
    <svg className={`dash st-${state}`} width={size} height={Math.round(size * 1.2)} viewBox="-4 -12 72 92" role="img" aria-label={`Dash: ${LABEL[state]}`}>
      <ellipse className="shadow" cx="32" cy="70" rx="26" ry="3.5" />
      <g className="whole">
        <rect className="base" x="6" y="58" width="52" height="9" rx="3" />
        <path className="body" d="M25.3 7.4Q32 1.6 38.7 7.4L52 58H12z" />
        <path className="stripe" d="M18.7 30h26.6l2 8H16.7z" /><path className="stripe" d="M15.1 45h33.8l1.1 4.5H14z" opacity=".9" />
        {state === 'fail'
          ? <path className="mouth" d="M26.5 18.5l3 3M29.5 18.5l-3 3M34.5 18.5l3 3M37.5 18.5l-3 3" />
          : <g className="pupils"><circle className="eye" cx="28" cy="20" r={r} /><circle className="eye" cx="36" cy="20" r={r} /></g>}
        <circle className="cheek" cx="24.5" cy="24.5" r="2.2" /><circle className="cheek" cx="39.5" cy="24.5" r="2.2" />
        <path className="mouth" d={MOUTH[state] ?? 'M29.5 25Q32 27 34.5 25'} />
      </g>
      {state === 'scan' && <path className="prop-s" d="M48 14a8 8 0 0 1 0 12M52.5 10a14 14 0 0 1 0 20" />}
      {state === 'spot' && <><path className="prop-s" d="M32-9v6" strokeWidth="3" /><circle className="prop" cx="32" cy="1" r="1.8" /></>}
      {state === 'check' && <><circle className="prop-s" cx="51" cy="20" r="5.5" /><path className="prop-s" d="M55 24l4.5 4.5" strokeWidth="3" /></>}
      {state === 'plan' && <><rect className="prop" x="47" y="15" width="13" height="16" rx="1.6" /><path className="prop-line" d="M50 20h7M50 23.5h7M50 27h4.5" /></>}
      {state === 'route' && <><path className="prop-s" d="M0 74h64" strokeDasharray="2 4" /><circle className="prop dot" cx="32" cy="74" r="2.6" /></>}
      {state === 'done' && <><path className="prop twinkle" d="M51 3l1.3 3.2 3.2 1.3-3.2 1.3L51 12l-1.3-3.2-3.2-1.3 3.2-1.3z" /><path className="prop twinkle" style={{ animationDelay: '.4s' }} d="M12 9l.9 2.1 2.1.9-2.1.9L12 15l-.9-2.1-2.1-.9 2.1-.9z" /></>}
      {state === 'fail' && <path className="prop-s" d="M50 52l4-4M54 56l5-1M46 50l-1-5" />}
    </svg>
  );
}
