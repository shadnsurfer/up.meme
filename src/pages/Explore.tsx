import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  climbEndSeconds,
  createdAtSeconds,
  displayName,
  displayTicker,
  isClimbing,
  mcapUsd,
  solRaised,
  soldFraction,
  type LiveLaunch,
} from '../lib/chain';
import { useLaunches } from '../lib/hooks';
import { formatSol, formatUsd, shortenAddress } from '../lib/format';
import { Countdown, useNowSeconds } from '../components/Countdown';
import { TabsPill } from '../components/TabsPill';
import { Pagination } from '../components/Pagination';
import { RollingNumber } from '../components/RollingNumber';
import { useSearchOpen } from '../components/SearchPalette';

type SortKey = 'recent' | 'newest' | 'mcap' | 'volume';

const sortOptions = [
  { id: 'recent', label: 'climbing' },
  { id: 'newest', label: 'newest' },
  { id: 'mcap', label: 'market cap' },
  { id: 'volume', label: 'volume' },
];

const PAGE_SIZE = 6;

/** fraction of the climb window elapsed, 0..1 (falls back to curve sold %) */
function climbProgress(l: LiveLaunch, now: number): number {
  if (!isClimbing(l, now)) return 1;
  const created = createdAtSeconds(l);
  if (created !== null) {
    const total = climbEndSeconds(l) - created;
    if (total > 0) return Math.min(1, Math.max(0.04, (now - created) / total));
  }
  const sold = soldFraction(l);
  return Math.min(1, Math.max(0.04, sold ?? 0.04));
}

function LaunchCard({ launch, index, now }: { launch: LiveLaunch; index: number; now: number }) {
  const navigate = useNavigate();
  const climbing = isClimbing(launch, now);
  const progress = climbProgress(launch, now);
  const mcap = mcapUsd(launch);

  return (
    <li className="animate-in-slide" style={{ animationDelay: `${Math.min(index, 10) * 35}ms` }}>
      <button
        onClick={() => navigate(`/coin/${launch.state.mint}`)}
        className="group grid w-full grid-rows-[auto_1fr] gap-2.5 rounded-[20px] border border-transparent bg-white/[0.03] p-2.5 text-left transition duration-200 hover:-translate-y-1 hover:border-white/[0.12] hover:bg-white/[0.07] hover:shadow-[0_16px_40px_rgba(0,0,0,0.5)]"
      >
        {/* media */}
        <div className="relative">
          <div className="grid aspect-square w-full place-items-center overflow-hidden rounded-[14px] bg-void text-5xl">
            {launch.meta?.image ? (
              <img
                src={launch.meta.image}
                alt=""
                className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-110"
              />
            ) : (
              <span className="transition-transform duration-300 ease-out group-hover:scale-110">👁️</span>
            )}
          </div>
          <div className="absolute left-2 top-2 z-10 flex items-center gap-1">
            {climbing ? (
              <span className="rounded-full bg-black/70 px-2 py-1 text-[10px] font-semibold tracking-tight text-pump backdrop-blur-md">
                climbing
              </span>
            ) : (
              <span className="rounded-full bg-black/70 px-2 py-1 text-[10px] font-semibold tracking-tight text-white/80 backdrop-blur-md">
                open
              </span>
            )}
          </div>
        </div>

        {/* body */}
        <div className="grid min-w-0 gap-1 px-0.5 pb-0.5">
          <strong className="truncate text-[14px] font-semibold tracking-tight text-ink transition-colors group-hover:text-pump-soft">
            {displayName(launch)}
          </strong>
          <small className="truncate font-mono text-[12px] text-ink-mute">${displayTicker(launch)}</small>

          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="font-mono text-[14px] font-bold tabular-nums text-ink">
              {mcap !== null ? formatUsd(mcap) : '···'}
            </span>
            <span className="text-[11px] text-ink-ghost">mcap</span>
          </div>

          {/* climb progress */}
          <div className="mt-1.5 flex items-center gap-2">
            <span className="relative h-1 flex-1 overflow-hidden rounded-full bg-white/[0.09]">
              <span
                className={`block h-full rounded-full transition-all duration-500 ${
                  climbing ? 'bg-pump/70' : 'bg-white/25'
                }`}
                style={{ width: `${progress * 100}%` }}
              />
            </span>
            <span className="flex-none font-mono text-[11px] tabular-nums text-ink-ghost">
              {climbing ? <Countdown endsAt={climbEndSeconds(launch)} /> : 'live'}
            </span>
          </div>

          <div className="mt-1 flex items-center justify-between text-[11px] text-ink-ghost">
            <span className="truncate font-mono">{shortenAddress(launch.state.creator)}</span>
            <span className="flex-none tabular-nums">
              {launch.state.migrated ? 'migrated' : `◎${formatSol(solRaised(launch))} raised`}
            </span>
          </div>
        </div>
      </button>
    </li>
  );
}

function SkeletonCard({ index }: { index: number }) {
  return (
    <div
      className="animate-row-in grid grid-rows-[auto_1fr] gap-2.5 rounded-[20px] bg-white/[0.03] p-2.5"
      style={{ animationDelay: `${index * 45}ms` }}
      aria-hidden
    >
      <div className="relative">
        <div className="skeleton aspect-square w-full rounded-[14px]" />
        <div className="skeleton absolute left-2 top-2 h-5 w-14 rounded-full" />
      </div>
      <div className="grid content-start gap-2 px-0.5 pb-0.5 pt-0.5">
        <div className="skeleton h-3.5 w-3/4 rounded-md" />
        <div className="skeleton h-3 w-1/3 rounded-md" />
        <div className="skeleton mt-1 h-4 w-1/2 rounded-md" />
        <div className="skeleton mt-1.5 h-1 w-full rounded-full" />
        <div className="mt-1 flex items-center justify-between gap-2">
          <div className="skeleton h-2.5 w-16 rounded-md" />
          <div className="skeleton h-2.5 w-10 rounded-md" />
        </div>
      </div>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <SkeletonCard key={i} index={i} />
      ))}
    </div>
  );
}

function paged<T>(list: T[], page: number): T[] {
  return list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
}

export function Explore() {
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const openSearch = useSearchOpen();
  const [sort, setSort] = useState<SortKey>('recent');
  const [pageActive, setPageActive] = useState(1);
  const [pageOpen, setPageOpen] = useState(1);
  const now = useNowSeconds();
  const { launches, status } = useLaunches();

  // brief skeleton pass on mount and whenever sort/filter changes
  const [skeletonPass, setSkeletonPass] = useState(true);
  useEffect(() => {
    setSkeletonPass(true);
    const t = window.setTimeout(() => setSkeletonPass(false), 650);
    return () => window.clearTimeout(t);
  }, [sort, query]);
  const loading = skeletonPass || status === 'loading';

  // reset paging whenever the filter or sort changes
  useEffect(() => {
    setPageActive(1);
    setPageOpen(1);
  }, [query, sort]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = [...launches];
    if (q) {
      list = list.filter(
        (l) =>
          (l.meta?.name ?? '').toLowerCase().includes(q) ||
          (l.meta?.symbol ?? '').toLowerCase().includes(q) ||
          l.state.mint.toLowerCase().includes(q),
      );
    }
    list.sort((a, b) => {
      if (sort === 'recent') {
        const ab = isClimbing(a, now) ? 0 : 1;
        const bb = isClimbing(b, now) ? 0 : 1;
        if (ab !== bb) return ab - bb;
        return (mcapUsd(b) ?? 0) - (mcapUsd(a) ?? 0);
      }
      if (sort === 'newest') {
        return (
          (createdAtSeconds(b) ?? climbEndSeconds(b)) - (createdAtSeconds(a) ?? climbEndSeconds(a))
        );
      }
      if (sort === 'mcap') return (mcapUsd(b) ?? 0) - (mcapUsd(a) ?? 0);
      // no trade-volume index exists on-chain — SOL seated in the curve is the
      // closest real signal
      const av = solRaised(a);
      const bv = solRaised(b);
      return bv > av ? 1 : bv < av ? -1 : 0;
    });
    return list;
  }, [launches, query, sort, now]);

  const active = results.filter((l) => isClimbing(l, now));
  const graduated = results.filter((l) => !isClimbing(l, now));

  return (
    <div className="animate-in-slide flex flex-col gap-4">
      {/* toolbar — clicking the search bar opens the palette */}
      <div className="flex items-center gap-3">
        <div
          role="button"
          tabIndex={0}
          onClick={openSearch}
          onKeyDown={(e) => {
            if (e.key === 'Enter') openSearch();
          }}
          className="float relative flex h-[46px] min-w-0 flex-1 cursor-pointer items-center rounded-full pl-10 pr-14 text-left text-[13px] text-ink transition hover:border-white/25 active:scale-[0.99]"
        >
          <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[14px] text-ink-ghost">
            ⌕
          </span>
          {query ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-mono text-pump">{query}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setParams({});
                }}
                className="grid h-5 w-5 flex-none cursor-pointer place-items-center rounded-full bg-white/[0.08] text-[10px] text-ink-mute transition hover:bg-white/[0.14] hover:text-ink"
                aria-label="clear search"
              >
                ✕
              </button>
            </span>
          ) : (
            <span className="text-ink-ghost">Search tokens</span>
          )}
          <kbd className="pointer-events-none absolute right-4 top-1/2 hidden -translate-y-1/2 rounded-lg border border-white/10 bg-white/[0.06] px-2 py-1 font-mono text-[10px] text-ink-ghost sm:block">
            ⌘K
          </kbd>
        </div>
        <a href="/launch" className="btn-pump flex h-[46px] flex-none items-center gap-2 px-5 text-[13px]">
          <span className="text-[15px] leading-none">+</span> create
        </a>
      </div>

      {/* active climbs panel */}
      <section className="float grid gap-5 p-5 sm:p-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid min-w-0 gap-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-[22px] font-normal tracking-tight text-ink">climbing now</h1>
              <span className="grid h-7 min-w-7 place-items-center rounded-full bg-white/[0.07] px-2 font-mono text-[12px] tabular-nums text-ink-mute">
                <RollingNumber value={String(active.length)} />
              </span>
            </div>
            <p className="max-w-[42ch] text-[13px] leading-relaxed text-ink-mute">
              tokens still inside the window — only verified single wallets can buy.
            </p>
          </div>
          <div className="ml-auto">
            <TabsPill options={sortOptions} value={sort} onChange={(v) => setSort(v as SortKey)} />
          </div>
        </header>

        {loading ? (
          <SkeletonGrid />
        ) : active.length === 0 ? (
          <div className="grid justify-items-start gap-4 px-1 py-6">
            {status === 'error' ? (
              <>
                <p className="text-[13px] font-semibold text-ink-dim">couldn't reach the chain.</p>
                <p className="text-[12px] text-ink-ghost">check your connection — retrying in the background.</p>
              </>
            ) : (
              <>
                <p className="text-[13px] font-semibold text-ink-dim">No climbs live right now.</p>
                <p className="text-[12px] text-ink-ghost">Be the first. The only way is up.</p>
                <a href="/launch" className="btn-pump min-w-[160px] px-5 py-2.5 text-center text-[13px]">
                  launch a coin
                </a>
              </>
            )}
          </div>
        ) : (
          <>
            <ul
              key={`active-${pageActive}`}
              className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-3"
            >
              {paged(active, pageActive).map((l, i) => (
                <LaunchCard key={l.state.mint} launch={l} index={i} now={now} />
              ))}
            </ul>
            <Pagination
              page={pageActive}
              pages={Math.ceil(active.length / PAGE_SIZE)}
              onChange={setPageActive}
              className="justify-center pt-1"
            />
          </>
        )}
      </section>

      {/* graduated panel — mint tinted */}
      {!loading && graduated.length > 0 && (
        <section className="float-graduated grid gap-5 p-5 sm:p-6">
          <header className="flex flex-wrap items-start justify-between gap-4">
            <div className="grid min-w-0 gap-1.5">
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 className="text-[22px] font-normal tracking-tight text-ink">open market</h2>
                <span className="grid h-7 min-w-7 place-items-center rounded-full bg-pump/[0.14] px-2 font-mono text-[12px] tabular-nums text-pump">
                  <RollingNumber value={String(graduated.length)} />
                </span>
              </div>
              <p className="max-w-[42ch] text-[13px] leading-relaxed text-ink-mute">
                the climb ended — these trade freely everywhere.
              </p>
            </div>
          </header>
          <ul
            key={`grad-${pageOpen}`}
            className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-3"
          >
            {paged(graduated, pageOpen).map((l, i) => (
              <LaunchCard key={l.state.mint} launch={l} index={i} now={now} />
            ))}
          </ul>
          <Pagination
            page={pageOpen}
            pages={Math.ceil(graduated.length / PAGE_SIZE)}
            onChange={setPageOpen}
            className="justify-center pt-1"
          />
        </section>
      )}
    </div>
  );
}
