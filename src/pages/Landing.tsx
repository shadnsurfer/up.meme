import { Link } from 'react-router-dom';
import { Logo } from '../components/Logo';
import { RollingNumber } from '../components/RollingNumber';
import { useNowSeconds } from '../components/Countdown';
import { SOL_PRICE_USD, displayTicker, isClimbing, mcapUsd, solRaised } from '../lib/chain';
import { useLaunches } from '../lib/hooks';
import { formatUsd } from '../lib/format';

export function Landing() {
  const { launches } = useLaunches();
  const now = useNowSeconds();
  const climbing = launches.filter((l) => isClimbing(l, now)).length;
  // no volume index exists on-chain — net SOL seated in all curves is the
  // closest real aggregate
  const totalVolume =
    (launches.reduce((a, l) => a + solRaised(l), 0n) * BigInt(Math.round(SOL_PRICE_USD))) / 1_000_000_000n;

  const stats = [
    { label: 'launches', value: launches.length.toString() },
    { label: 'climbing', value: climbing.toString(), live: true },
    { label: 'seated in curves', value: formatUsd(Number(totalVolume)) },
  ];

  const tickerItems = [...launches, ...launches];

  return (
    <div className="animate-page-up relative flex min-h-[100dvh] flex-col overflow-hidden bg-void">
      {/* ambient glow */}
      <div className="pointer-events-none absolute inset-0">
        <div className="animate-hero-drift absolute left-1/2 top-[8%] h-[460px] w-[460px] -translate-x-1/2 rounded-full bg-pump/[0.08] blur-[120px]" />
        <div className="absolute bottom-[-24%] left-[-10%] h-[380px] w-[380px] rounded-full bg-pump/[0.05] blur-[110px]" />
      </div>

      {/* minimal top bar */}
      <header className="relative z-10 flex h-[52px] w-full items-center justify-between px-4 sm:px-6 lg:px-8">
        <Logo size={22} />
        <a
          href="https://x.com"
          target="_blank"
          rel="noreferrer"
          className="well rounded-full px-3.5 py-1.5 text-[12px] font-semibold text-ink-mute transition hover:bg-white/[0.09] hover:text-ink"
        >
          X ↗
        </a>
      </header>

      {/* hero */}
      <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 py-10 text-center">
        <div className="animate-in-slide stagger-1">
          <img
            src="/logo-white.png"
            alt="up.meme"
            className="animate-hero-drift mx-auto h-20 w-20 object-contain sm:h-24 sm:w-24"
          />
        </div>

        <h1 className="display-serif animate-in-slide stagger-2 mt-7 max-w-3xl text-[44px] leading-[1.02] text-ink sm:text-[68px]">
          the fairest launches
          <br />
          on solana.
          <em className="text-pump"> the only way is up.</em>
        </h1>

        <p className="animate-in-slide stagger-3 mt-5 max-w-md text-[14px] leading-relaxed text-ink-mute sm:text-[15px]">
          one wallet deploys. one wallet seeds. no bundling, no snipers, no insiders.
          every coin opens with a climb — a window where only verified people can buy.
        </p>

        {/* CTAs */}
        <div className="animate-in-slide stagger-3 mx-auto mt-7 flex w-full max-w-[300px] flex-col justify-center gap-2.5 md:mt-9 md:max-w-none md:flex-row md:gap-3">
          <Link to="/explore" className="btn-pump px-8 py-3.5 text-[14px]">
            enter app
          </Link>
          <Link to="/launch" className="btn-ghost px-8 py-3.5 text-[14px]">
            launch a coin
          </Link>
        </div>

        {/* stats */}
        <div className="animate-in-slide stagger-4 mt-9 flex items-center justify-center gap-8 md:mt-12 md:gap-14">
          {stats.map((s) => (
            <div key={s.label} className="text-center">
              <div className="font-mono text-[22px] font-extrabold tabular-nums text-ink md:text-[26px]">
                {s.live && (
                  <span className="live-dot mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-pump align-middle shadow-[0_0_10px_rgba(95,203,136,0.8)]" />
                )}
                <RollingNumber value={s.value} />
              </div>
              <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-widest text-ink-ghost">
                {s.label}
              </div>
            </div>
          ))}
        </div>

        {/* ticker marquee — hidden when the chain has no launches yet */}
        {tickerItems.length > 0 && (
          <div className="animate-in-fade stagger-5 marquee mt-10 w-full max-w-3xl md:mt-14">
            <div className="marquee-track gap-2.5 pr-2.5">
              {tickerItems.map((l, i) => {
                const mcap = mcapUsd(l);
                return (
                  <Link
                    to={`/coin/${l.state.mint}`}
                    key={`${l.state.mint}-${i}`}
                    className="well flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[12px] font-semibold text-ink-dim transition hover:bg-white/[0.09] hover:text-ink"
                  >
                    <span className="grid h-5 w-5 place-items-center overflow-hidden rounded-full text-[13px]">
                      {l.meta?.image ? (
                        <img src={l.meta.image} alt="" className="h-full w-full object-cover" />
                      ) : (
                        '👁️'
                      )}
                    </span>
                    <span className="font-mono">${displayTicker(l)}</span>
                    <span className={isClimbing(l, now) ? 'text-pump' : 'text-ink-ghost'}>
                      {isClimbing(l, now) ? 'climbing' : mcap !== null ? formatUsd(mcap) : '···'}
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        <p className="animate-in-fade stagger-5 mt-9 font-mono text-[11px] text-ink-ghost">
          1B supply · 100% seeded · locked liquidity · $5K start · 50% fees to creators
        </p>
      </main>

      {/* bottom disclaimer strip */}
      <footer className="animate-in-fade stagger-5 relative z-10 flex flex-wrap items-center justify-end gap-4 border-t border-white/5 bg-void px-5 py-5 sm:px-7">
        <p className="mr-auto max-w-2xl text-[10px] leading-relaxed text-ink-ghost sm:text-[11px]">
          up.meme is an independent launchpad. tokens here are launched by anyone — names, images
          and links come from whoever created them, so do your own research. nothing here is
          financial advice.
        </p>
        <Link to="/explore" className="text-[12px] font-semibold text-ink-mute transition hover:text-pump">
          enter app →
        </Link>
      </footer>
    </div>
  );
}
