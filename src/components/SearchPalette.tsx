import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { formatUsd, mockLaunches, type Launch } from '../data/mock';
import { PageSweep } from './PageSweep';

const SearchCtx = createContext<() => void>(() => {});

/** call from anywhere to open the search palette */
export const useSearchOpen = () => useContext(SearchCtx);

/** wraps the whole router — provides search state + renders the palette */
export function RootLayout() {
  const [open, setOpen] = useState(false);
  const openSearch = useCallback(() => setOpen(true), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <SearchCtx.Provider value={openSearch}>
      <PageSweep />
      <Outlet />
      {open && <SearchPalette onClose={() => setOpen(false)} />}
    </SearchCtx.Provider>
  );
}

/** pill trigger — used in the nav and as the explore page search bar */
export function SearchTrigger({
  className = '',
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  const open = useSearchOpen();
  return (
    <button onClick={open} className={`group ${className}`}>
      {children}
    </button>
  );
}

function StatusChip({ launch }: { launch: Launch }) {
  const climbing = launch.climbEndsAt !== null;
  return (
    <span
      className={`flex-none rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-tight ${
        climbing ? 'bg-pump/[0.14] text-pump' : 'bg-white/[0.07] text-ink-mute'
      }`}
    >
      {climbing ? 'climbing' : 'open'}
    </span>
  );
}

function SearchPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const [closing, setClosing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();

  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    const list = t
      ? mockLaunches.filter(
          (l) =>
            l.name.toLowerCase().includes(t) ||
            l.ticker.toLowerCase().includes(t) ||
            l.creator.toLowerCase().includes(t),
        )
      : mockLaunches;
    return list.slice(0, 8);
  }, [q]);

  useEffect(() => {
    inputRef.current?.focus();
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  useEffect(() => setIdx(0), [q]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  const close = useCallback(() => {
    setClosing(true);
    window.setTimeout(onClose, 150);
  }, [onClose]);

  const pick = useCallback(
    (l: Launch) => {
      navigate(`/explore?q=${encodeURIComponent(l.ticker)}`);
      close();
    },
    [navigate, close],
  );

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIdx((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && results[idx]) {
      pick(results[idx]);
    } else if (e.key === 'Escape') {
      close();
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex flex-col" role="dialog" aria-modal="true" aria-label="search">
      <div
        className={`absolute inset-0 bg-[#080808b8] backdrop-blur-[16px] backdrop-saturate-150 ${
          closing ? 'animate-overlay-out' : 'animate-overlay-in'
        }`}
        onClick={close}
      />
      <div
        className={`float relative mx-auto mb-3 mt-auto flex max-h-[82vh] w-[calc(100%-1.5rem)] max-w-xl flex-col overflow-hidden sm:mb-auto sm:mt-[14vh] sm:max-h-[76vh] sm:w-full ${
          closing ? 'animate-palette-out' : 'animate-palette-in'
        }`}
        style={{ borderRadius: 24 }}
      >
        {/* input */}
        <div className="flex items-center gap-3 border-b border-white/[0.08] px-5">
          <span className="text-[16px] text-ink-ghost">⌕</span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="search coins by name or ticker…"
            className="h-[58px] w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-ghost"
          />
          <kbd className="flex-none rounded-md border border-white/10 bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-ink-ghost">
            esc
          </kbd>
        </div>

        {/* results */}
        <div className="nice-scroll min-h-0 flex-1 overflow-y-auto p-2" key={q}>
          {results.length === 0 ? (
            <div className="animate-in-fade px-4 py-10 text-center">
              <p className="text-[13px] font-semibold text-ink-dim">no coins match “{q}”</p>
              <p className="mt-1 text-[12px] text-ink-ghost">try a name, ticker or creator</p>
            </div>
          ) : (
            results.map((l, i) => (
              <button
                key={l.id}
                ref={i === idx ? activeRef : undefined}
                onMouseEnter={() => setIdx(i)}
                onClick={() => pick(l)}
                className={`animate-row-in flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors duration-100 ${
                  i === idx ? 'bg-white/[0.07]' : ''
                }`}
                style={{ animationDelay: `${i * 25}ms` }}
              >
                <span className="grid h-9 w-9 flex-none place-items-center rounded-full border border-white/[0.08] bg-raised text-[16px]">
                  {l.emoji}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold text-ink">
                    {l.name}
                  </span>
                  <span className="block truncate font-mono text-[11.5px] text-ink-mute">
                    ${l.ticker}
                  </span>
                </span>
                <span className="flex-none font-mono text-[12px] font-bold tabular-nums text-ink-dim">
                  {formatUsd(l.marketCap)}
                </span>
                <StatusChip launch={l} />
              </button>
            ))
          )}
        </div>

        {/* footer hints */}
        <div className="flex items-center gap-4 border-t border-white/[0.08] px-5 py-2.5 text-[10.5px] text-ink-ghost">
          <span className="flex items-center gap-1.5">
            <kbd className="rounded border border-white/10 bg-white/[0.06] px-1 font-mono">↑↓</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className="rounded border border-white/10 bg-white/[0.06] px-1 font-mono">↵</kbd>
            open
          </span>
          <span className="ml-auto font-mono">{results.length} coins</span>
        </div>
      </div>
    </div>
  );
}
