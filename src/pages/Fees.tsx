import { useEffect, useState } from 'react';
import { formatUsd } from '../data/mock';
import { RollingNumber } from '../components/RollingNumber';

type FeeEntry = {
  token: string;
  ticker: string;
  emoji: string;
  claimable: number;
  lifetime: number;
};

const mockFees: FeeEntry[] = [
  { token: 'Fair Cat', ticker: 'FAIRC', emoji: '🐱', claimable: 412.5, lifetime: 1093.2 },
  { token: 'Signal', ticker: 'SGNL', emoji: '⚡', claimable: 96.1, lifetime: 2210.0 },
];

export function Fees() {
  const [connected] = useState(true);

  // mock live accrual — fees trickle in so the odometer digits roll
  const [total, setTotal] = useState(() => mockFees.reduce((a, f) => a + f.claimable, 0));
  useEffect(() => {
    const t = window.setInterval(() => {
      setTotal((v) => v + Math.random() * 1.4);
    }, 3200);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div className="animate-in-slide w-full max-w-3xl pt-6">
      <h1 className="display-serif text-[30px] leading-tight text-ink">fees</h1>
      <p className="mt-1 max-w-lg text-[13px] leading-relaxed text-ink-mute">
        50% of every trade goes to the creator. fees accumulate onchain — anyone can trigger the
        payout, it always splits the same way.
      </p>

      <div className="float mt-5 p-5" style={{ borderRadius: '20px' }}>
        {!connected ? (
          <div className="flex flex-col items-center gap-3 py-10">
            <p className="text-[13px] font-semibold text-ink-dim">connect your wallet to view fees</p>
            <button className="btn-pump px-6 py-2.5 text-[13px]">connect wallet</button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-ghost">
                  claimable now
                </div>
                <div className="font-mono text-[30px] font-extrabold tabular-nums leading-tight text-pump">
                  <RollingNumber value={formatUsd(total)} />
                </div>
              </div>
              <button disabled={total === 0} className="btn-pump px-7 py-2.5 text-[13px]">
                claim all
              </button>
            </div>

            <div className="mt-4 flex flex-col gap-1 border-t border-white/[0.06] pt-3">
              {mockFees.length === 0 ? (
                <div className="py-8 text-center">
                  <p className="text-[13px] font-semibold text-ink-dim">No fees yet</p>
                  <p className="mt-1 text-[12px] text-ink-ghost">Nothing to claim yet</p>
                </div>
              ) : (
                mockFees.map((f, i) => (
                  <div
                    key={f.ticker}
                    className="animate-row-in flex flex-wrap items-center gap-3 rounded-2xl px-3 py-2.5 transition hover:bg-white/[0.05] sm:flex-nowrap sm:gap-4"
                    style={{ animationDelay: `${i * 60}ms` }}
                  >
                    <div className="flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.08] bg-raised text-lg">
                      {f.emoji}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-bold text-ink">{f.token}</div>
                      <div className="font-mono text-[11px] text-ink-mute">${f.ticker}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-[13px] font-bold tabular-nums text-pump">
                        {formatUsd(f.claimable)}
                      </div>
                      <div className="text-[10px] text-ink-ghost">
                        {formatUsd(f.lifetime)} lifetime
                      </div>
                    </div>
                    <button className="btn-ghost px-4 py-1.5 text-[12px]">claim</button>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>

      <div className="float-graduated mt-3 p-5" style={{ borderRadius: '20px' }}>
        <h3 className="text-[13px] font-bold text-pump">the other 50% buys & burns $UP</h3>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-dim">
          the protocol share accumulates in an onchain vault. anyone can crank it: it market-buys
          $UP and burns it. every trade on every launch makes $UP scarcer.
        </p>
      </div>
    </div>
  );
}
