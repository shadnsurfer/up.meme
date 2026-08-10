import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState, type CSSProperties } from 'react';
import { Logo } from './Logo';
import { TabsPill } from './TabsPill';
import { ConnectButton } from './ConnectButton';
import { LiquidGlassFilter, liquidGlassStyle } from './LiquidGlassFilter';
import { SearchTrigger } from './SearchPalette';

const tabs = [
  { id: '/explore', label: 'explore' },
  { id: '/launch', label: 'launch' },
  { id: '/fees', label: 'fees' },
];

export function Shell() {
  const location = useLocation();
  const navigate = useNavigate();
  const current = tabs.some((t) => t.id === location.pathname) ? location.pathname : '/explore';

  // SVG backdrop-filter support is detected after mount; default to frosted blur
  const [lg, setLg] = useState<CSSProperties | null>(null);
  useEffect(() => {
    setLg(liquidGlassStyle());
  }, []);

  return (
    <div className="relative flex min-h-[100dvh] flex-col bg-void">
      <LiquidGlassFilter />

      {/* sticky full-width liquid-glass nav */}
      <div className="sticky top-0 z-[100]">
        <header className="liquid-glass nav-glass h-[60px]" style={lg ?? undefined}>
          <div className="flex h-full w-full items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
            <NavLink to="/" className="flex min-w-0 items-center gap-2.5">
              <img
                key={location.pathname}
                src="/logo-white.png"
                alt="up.meme"
                className="animate-logo-hop h-8 w-8 object-contain"
              />
              <span className="hidden text-[15px] font-medium tracking-tight text-ink sm:block">
                up.meme
              </span>
            </NavLink>

            <div className="hidden md:block">
              <TabsPill options={tabs} value={current} onChange={(id) => navigate(id)} />
            </div>

            <div className="flex items-center gap-2">
              <SearchTrigger className="hidden items-center gap-2 rounded-full border border-white/[0.12] bg-white/[0.04] px-3.5 py-2 text-[12px] font-semibold text-ink-mute transition hover:border-pump/40 hover:bg-white/[0.07] hover:text-ink lg:flex">
                <span className="text-[13px] leading-none">⌕</span>
                <span>search</span>
                <kbd className="rounded-md border border-white/10 bg-white/[0.06] px-1.5 py-0.5 font-mono text-[9.5px] text-ink-ghost">
                  ⌘K
                </kbd>
              </SearchTrigger>
              <ConnectButton />
            </div>
          </div>
        </header>
      </div>

      {/* page content — re-mounts per route so the rise animation replays */}
      <main
        key={location.pathname}
        className="animate-page-up relative z-0 flex w-full flex-1 flex-col px-4 pb-tabbar pt-5 sm:px-6 lg:px-8 md:pb-0"
      >
        <Outlet />
      </main>

      {/* footer — floating glass card */}
      <footer className="hidden w-full px-4 pb-8 pt-10 sm:px-6 lg:px-8 md:block">
        <div className="float relative overflow-hidden p-7">
          <div className="relative z-10 flex flex-col gap-6">
            <div className="grid grid-cols-[1.4fr_1fr_1fr] gap-6">
              <div>
                <Logo size={20} />
                <p className="mt-3 max-w-[38ch] text-[12px] leading-relaxed text-ink-mute">
                  launch and explore fair fixed-supply tokens on solana. your wallet submits every
                  transaction — up.meme does not custody assets.
                </p>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-ink-ghost">product</p>
                <ul className="mt-3 space-y-2 text-[13px] text-ink-mute">
                  <li><NavLink to="/explore" className="transition hover:text-ink">explore</NavLink></li>
                  <li><NavLink to="/launch" className="transition hover:text-ink">launch</NavLink></li>
                  <li><NavLink to="/fees" className="transition hover:text-ink">fees</NavLink></li>
                </ul>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-widest text-ink-ghost">legal</p>
                <ul className="mt-3 space-y-2 text-[13px] text-ink-mute">
                  <li><span className="cursor-pointer transition hover:text-ink">privacy policy</span></li>
                  <li><span className="cursor-pointer transition hover:text-ink">terms of use</span></li>
                </ul>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.08] pt-5">
              <p className="max-w-[52ch] text-[10.5px] leading-relaxed text-ink-ghost">
                risk notice — transactions are submitted through your wallet and may be
                irreversible. tokens can be volatile or lose all value. up.meme does not provide
                custody, warranties, or financial advice.
              </p>
              <div className="flex items-center gap-4 text-[12px] text-ink-ghost">
                <span>© 2026 up.meme</span>
                <a href="https://x.com" target="_blank" rel="noreferrer" className="font-semibold transition hover:text-pump">
                  X ↗
                </a>
              </div>
            </div>
          </div>
        </div>
      </footer>

      {/* mobile bottom tab bar — floating glass pill */}
      <nav className="pointer-events-none fixed inset-x-0 bottom-3 z-[100] flex justify-center px-4 md:hidden">
        <div
          className="float pointer-events-auto grid h-[64px] w-full max-w-sm grid-cols-3 rounded-full px-1.5"
          style={{
            marginBottom: 'env(safe-area-inset-bottom, 0px)',
            borderRadius: '999px',
            ...(lg ?? {}),
          }}
        >
          {tabs.map((t) => {
            const active = current === t.id;
            return (
              <button
                key={t.id}
                onClick={() => navigate(t.id)}
                className={`m-1.5 rounded-full text-[12px] font-semibold transition ${
                  active ? 'bg-pump text-[#0a1f13]' : 'text-ink-mute'
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
