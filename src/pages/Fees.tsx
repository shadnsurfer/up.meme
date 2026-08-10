import { useMemo, useState } from 'react';
import {
  SOL_PRICE_USD,
  displayName,
  displayTicker,
  feesClaimable,
  fetchConfig,
  type LiveLaunch,
} from '../lib/chain';
import { useConnectedWallet, useLaunches, usePrivyLogin } from '../lib/hooks';
import { CU, buildClaimFees, useUpmemeTx } from '../lib/tx';
import { formatSol, formatUsd } from '../lib/format';
import { RollingNumber } from '../components/RollingNumber';

/** the creator's half of a launch's claimable fees, in USD (cosmetic rate) */
function creatorClaimableUsd(l: LiveLaunch): number {
  return (Number(feesClaimable(l)) / 2 / 1e9) * SOL_PRICE_USD;
}

export function Fees() {
  const { connected, address: wallet } = useConnectedWallet();
  const login = usePrivyLogin();
  const { send } = useUpmemeTx();
  const { launches, refresh } = useLaunches();
  const [busyMint, setBusyMint] = useState<string | 'all' | null>(null);
  const [error, setError] = useState('');

  // every launch this wallet created with fees sitting in its vault
  const mine = useMemo(
    () => launches.filter((l) => wallet !== null && l.state.creator === wallet && feesClaimable(l) > 0n),
    [launches, wallet],
  );
  const total = mine.reduce((a, l) => a + creatorClaimableUsd(l), 0);

  const claim = async (targets: LiveLaunch[]) => {
    if (!wallet || targets.length === 0) return;
    setError('');
    setBusyMint(targets.length > 1 ? 'all' : targets[0].state.mint);
    try {
      const config = await fetchConfig();
      if (!config) throw new Error('protocol config not found on-chain');
      const ixs = await Promise.all(
        targets.map((l) =>
          buildClaimFees({ mint: l.state.mint, creator: l.state.creator, protocolVault: config.protocolVault }),
        ),
      );
      await send(ixs, { cuLimit: Math.min(CU.claimFees * ixs.length, CU.migrate) });
      refresh();
      window.setTimeout(refresh, 4_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'claim failed');
    } finally {
      setBusyMint(null);
    }
  };

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
            <button onClick={login} className="btn-pump px-6 py-2.5 text-[13px]">
              connect wallet
            </button>
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
              <button
                disabled={total === 0 || busyMint !== null}
                onClick={() => void claim(mine)}
                className={`btn-pump px-7 py-2.5 text-[13px] ${busyMint === 'all' ? 'btn-loading' : ''}`}
              >
                claim all
              </button>
            </div>
            {error && <p className="animate-row-in mt-2 text-[12px] font-medium text-ember">{error}</p>}

            <div className="mt-4 flex flex-col gap-1 border-t border-white/[0.06] pt-3">
              {mine.length === 0 ? (
                <div className="py-8 text-center">
                  <p className="text-[13px] font-semibold text-ink-dim">No fees yet</p>
                  <p className="mt-1 text-[12px] text-ink-ghost">Nothing to claim yet</p>
                </div>
              ) : (
                mine.map((l, i) => (
                  <div
                    key={l.state.mint}
                    className="animate-row-in flex flex-wrap items-center gap-3 rounded-2xl px-3 py-2.5 transition hover:bg-white/[0.05] sm:flex-nowrap sm:gap-4"
                    style={{ animationDelay: `${i * 60}ms` }}
                  >
                    <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border border-white/[0.08] bg-raised text-lg">
                      {l.meta?.image ? (
                        <img src={l.meta.image} alt="" className="h-full w-full object-cover" />
                      ) : (
                        '👁️'
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-bold text-ink">{displayName(l)}</div>
                      <div className="font-mono text-[11px] text-ink-mute">${displayTicker(l)}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-[13px] font-bold tabular-nums text-pump">
                        {formatUsd(creatorClaimableUsd(l))}
                      </div>
                      <div className="text-[10px] text-ink-ghost">
                        ◎{formatSol(feesClaimable(l) / 2n)} claimable
                      </div>
                    </div>
                    <button
                      disabled={busyMint !== null}
                      onClick={() => void claim([l])}
                      className={`btn-ghost px-4 py-1.5 text-[12px] ${busyMint === l.state.mint ? 'btn-loading' : ''}`}
                    >
                      claim
                    </button>
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
