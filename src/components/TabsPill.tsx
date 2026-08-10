import { useLayoutEffect, useRef, useState } from 'react';

export type TabOption = { id: string; label: string };

/**
 * Segmented pill control with a sliding indicator behind the active tab.
 */
export function TabsPill({
  options,
  value,
  onChange,
}: {
  options: TabOption[];
  value: string;
  onChange: (id: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState({ x: 0, w: 0, ready: false });

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLButtonElement>(`[data-tab="${value}"]`);
    if (!active) return;
    setIndicator({ x: active.offsetLeft, w: active.offsetWidth, ready: true });
  }, [value, options]);

  return (
    <div
      ref={listRef}
      className="relative flex w-fit items-center gap-0.5 rounded-full border border-white/[0.12] bg-[#16181acc] p-[3px] shadow-[inset_0_1px_#ffffff14]"
    >
      <span
        className="pointer-events-none absolute top-[3px] rounded-full bg-[#1c1c1c] shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-all duration-200 ease-out"
        style={{
          left: 0,
          height: 'calc(100% - 6px)',
          transform: `translateX(${indicator.x}px)`,
          width: indicator.w,
          opacity: indicator.ready ? 1 : 0,
        }}
      />
      {options.map((o) => (
        <button
          key={o.id}
          data-tab={o.id}
          onClick={() => onChange(o.id)}
          className={`relative z-10 whitespace-nowrap rounded-full px-3 py-[7px] text-[12px] font-medium leading-tight transition-colors duration-150 ${
            value === o.id ? 'text-ink' : 'text-ink-mute hover:text-ink-dim'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
