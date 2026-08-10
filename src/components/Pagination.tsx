import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Page-number control with a sliding pill indicator (same motion as TabsPill).
 * Renders nothing when there's only one page.
 */
export function Pagination({
  page,
  pages,
  onChange,
  className = '',
}: {
  page: number;
  pages: number;
  onChange: (p: number) => void;
  className?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [ind, setInd] = useState({ x: 0, w: 0, ready: false });

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLButtonElement>(`[data-page="${page}"]`);
    if (!active) return;
    setInd({ x: active.offsetLeft, w: active.offsetWidth, ready: true });
  }, [page, pages]);

  if (pages <= 1) return null;

  const nums = Array.from({ length: pages }, (_, i) => i + 1);

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <button
        className="pg-arrow"
        disabled={page === 1}
        onClick={() => onChange(page - 1)}
        aria-label="previous page"
      >
        ‹
      </button>
      <div
        ref={listRef}
        className="relative flex items-center gap-0.5 rounded-full border border-white/[0.12] bg-[#16181acc] p-[3px] shadow-[inset_0_1px_#ffffff14]"
      >
        <span
          className="pointer-events-none absolute top-[3px] rounded-full bg-pump/[0.14] shadow-[inset_0_0_0_1px_rgba(95,203,136,0.35)] transition-all duration-200 ease-out"
          style={{
            left: 0,
            height: 'calc(100% - 6px)',
            transform: `translateX(${ind.x}px)`,
            width: ind.w,
            opacity: ind.ready ? 1 : 0,
          }}
        />
        {nums.map((n) => (
          <button
            key={n}
            data-page={n}
            onClick={() => onChange(n)}
            className={`relative z-10 grid h-7 min-w-7 place-items-center rounded-full px-1.5 font-mono text-[11.5px] font-bold tabular-nums transition-colors duration-150 ${
              page === n ? 'text-pump' : 'text-ink-mute hover:text-ink'
            }`}
          >
            {n}
          </button>
        ))}
      </div>
      <button
        className="pg-arrow"
        disabled={page === pages}
        onClick={() => onChange(page + 1)}
        aria-label="next page"
      >
        ›
      </button>
    </div>
  );
}
