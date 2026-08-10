import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { address, generateKeyPairSigner } from '@solana/kit';
import {
  FEE_BPS,
  RENT_FLOOR,
  buyTokensOut,
  migrationParams,
  sellSolOut,
} from '../lib/upmeme';
import {
  SOL_PRICE_USD,
  climbEndSeconds,
  curveReserves,
  displayName,
  displayTicker,
  feesClaimable,
  fetchConfig,
  fetchSolBalance,
  fetchTokenBalance,
  isClimbing,
  mcapUsd,
  priceSol,
  soldFraction,
  type LiveLaunch,
} from '../lib/chain';
import { useAttestation, useConnectedWallet, useLaunch, usePrivyLogin } from '../lib/hooks';
import { CU, buildBuy, buildClaimFees, buildMigrate, buildSell, useUpmemeTx } from '../lib/tx';
import { ensureAttested } from '../lib/attest';
import { formatSol, formatTokens, formatUsd, shortenAddress } from '../lib/format';
import { Countdown } from '../components/Countdown';
import { TabsPill } from '../components/TabsPill';
import { RollingNumber } from '../components/RollingNumber';

const SLIPPAGE = 95n; // 5% min-out protection

type Phase = 'idle' | 'verifying' | 'confirming' | 'sending';

function CoinSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_340px]">
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <div className="skeleton h-12 w-12 rounded-full" />
          <div className="grid gap-2">
            <div className="skeleton h-4 w-40 rounded-md" />
            <div className="skeleton h-3 w-24 rounded-md" />
          </div>
        </div>
        <div className="skeleton h-28 rounded-[20px]" />
        <div className="skeleton h-20 rounded-[20px]" />
      </div>
      <div className="skeleton h-72 rounded-[20px]" />
    </div>
  );
}

export function Coin() {
  const params = useParams();
  const mint = useMemo(() => {
    try {
      return address(params.mint ?? '');
    } catch {
      return null;
    }
  }, [params.mint]);

  const { launch, status, refresh } = useLaunch(mint);
  const { connected, address: wallet } = useConnectedWallet();
  const login = usePrivyLogin();
  const { send } = useUpmemeTx();
  const attested = useAttestation(wallet);

  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [note, setNote] = useState<{ kind: 'status' | 'error' | 'ok'; text: string; sig?: string } | null>(null);
  const [walletSol, setWalletSol] = useState<bigint | null>(null);
  const [walletTokens, setWalletTokens] = useState<bigint>(0n);

  const now = Math.floor(Date.now() / 1000);
  const climbing = launch ? isClimbing(launch, now) : false;
  const migrated = launch?.state.migrated ?? false;
  const climbOver = launch !== null && !migrated && !climbing;

  // wallet balances for the open mint, piggybacking the launch poll
  useEffect(() => {
    if (!wallet || !mint) {
      setWalletSol(null);
      setWalletTokens(0n);
      return;
    }
    let cancelled = false;
    void Promise.all([fetchSolBalance(wallet), fetchTokenBalance(mint, wallet)])
      .then(([sol, tokens]) => {
        if (!cancelled) {
          setWalletSol(sol);
          setWalletTokens(tokens);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [wallet, mint, launch]);

  // ---- live estimates (exact curve math, fees included) ----
  const estimate = useMemo<{ out: bigint; min: bigint; lamports?: bigint; tokens?: bigint } | null>(() => {
    if (!launch) return null;
    const r = curveReserves(launch);
    if (!r) return null;
    const v = Number(amount);
    if (!Number.isFinite(v) || v <= 0) return null;
    if (side === 'buy') {
      const lamports = BigInt(Math.round(v * 1e9));
      const fee = (lamports * FEE_BPS) / 10_000n;
      const out = buyTokensOut(r.x, r.y, lamports - fee);
      return { out, min: (out * SLIPPAGE) / 100n, lamports };
    }
    const tokens = BigInt(Math.round(v * 1e6));
    if (tokens <= 0n || tokens > r.y) return null;
    const gross = sellSolOut(r.x, r.y, tokens);
    const payout = gross - (gross * FEE_BPS) / 10_000n;
    return { out: payout, min: (payout * SLIPPAGE) / 100n, tokens };
  }, [launch, amount, side]);

  if (status === 'missing' || mint === null) {
    return (
      <div className="flex w-full flex-col items-center justify-center gap-4 py-32 text-center">
        <p className="text-[15px] font-bold text-ink">this coin went up without you.</p>
        <p className="text-[13px] text-ink-mute">no launch exists at this mint.</p>
        <Link to="/explore" className="btn-pump mt-2 px-5 py-2.5 text-[13px]">
          back to explore
        </Link>
      </div>
    );
  }

  if (status === 'loading' && !launch) {
    return (
      <div className="w-full pt-6">
        <CoinSkeleton />
      </div>
    );
  }

  if (!launch) {
    return (
      <div className="flex w-full flex-col items-center justify-center gap-3 py-32 text-center">
        <p className="text-[13px] font-semibold text-ink-dim">couldn't reach the chain.</p>
        <p className="text-[12px] text-ink-ghost">retrying in the background…</p>
      </div>
    );
  }

  const l = launch as LiveLaunch;
  const name = displayName(l);
  const ticker = displayTicker(l);
  const mcap = mcapUsd(l);
  const price = priceSol(l);
  const sold = soldFraction(l);
  const claimable = feesClaimable(l);
  const busy = phase === 'verifying' || phase === 'confirming' || phase === 'sending';

  const runTx = async (what: () => Promise<string>, okText: string) => {
    setNote(null);
    try {
      const sig = await what();
      setNote({ kind: 'ok', text: okText, sig });
      setAmount('');
      refresh();
      window.setTimeout(refresh, 4_000);
    } catch (e) {
      setNote({ kind: 'error', text: e instanceof Error ? e.message : 'transaction failed' });
    } finally {
      setPhase('idle');
    }
  };

  const doTrade = () => {
    if (!wallet || !estimate) return;
    if (side === 'buy' && walletSol !== null && estimate.lamports! >= walletSol) {
      setNote({ kind: 'error', text: 'insufficient SOL balance.' });
      return;
    }
    if (side === 'sell' && estimate.tokens! > walletTokens) {
      setNote({ kind: 'error', text: `you only hold ${formatTokens(walletTokens)} $${ticker}.` });
      return;
    }
    void runTx(async () => {
      if (side === 'buy') {
        if (climbing && !attested) {
          setPhase('verifying');
          await ensureAttested(wallet, (s) => setNote({ kind: 'status', text: s }));
        }
        setPhase('confirming');
        const ix = await buildBuy({
          trader: wallet,
          mint: l.state.mint,
          lamports: estimate.lamports!,
          minTokensOut: estimate.min,
          attested: climbing ? true : attested === true,
        });
        setPhase('sending');
        return send([ix], { cuLimit: CU.trade });
      }
      setPhase('confirming');
      const ix = await buildSell({
        trader: wallet,
        mint: l.state.mint,
        tokenAmount: estimate.tokens!,
        minSolOut: estimate.min,
        attested: attested === true,
      });
      setPhase('sending');
      return send([ix], { cuLimit: CU.trade });
    }, side === 'buy' ? `bought $${ticker} ✓` : `sold $${ticker} ✓`);
  };

  const doMigrate = () => {
    if (!wallet || l.solVaultLamports === null || l.curveTokenBalance === null) return;
    void runTx(async () => {
      const params = migrationParams(l.curveTokenBalance!, l.solVaultLamports!);
      if (!params) throw new Error("the curve's SOL vault can't cover migration rent yet — buy pressure first");
      setPhase('confirming');
      const nft = await generateKeyPairSigner();
      const ix = await buildMigrate({
        cranker: wallet,
        mint: l.state.mint,
        positionNftMint: nft.address,
        liquidity: params.liquidity,
      });
      setPhase('sending');
      return send([ix], { signers: [nft], cuLimit: CU.migrate });
    }, 'migrated — liquidity is locked on the open market ✓');
  };

  const doClaim = () => {
    if (!wallet) return;
    void runTx(async () => {
      const config = await fetchConfig();
      if (!config) throw new Error('protocol config not found on-chain');
      setPhase('confirming');
      const ix = await buildClaimFees({
        mint: l.state.mint,
        creator: l.state.creator,
        protocolVault: config.protocolVault,
      });
      setPhase('sending');
      return send([ix], { cuLimit: CU.claimFees });
    }, 'fees claimed — split 50/50 ✓');
  };

  const tradeLabel = !connected
    ? `connect wallet to ${side}`
    : phase === 'verifying'
      ? 'verifying pump.fun profile…'
      : phase === 'confirming'
        ? 'confirm in wallet…'
        : phase === 'sending'
          ? 'sending…'
          : `${side} $${ticker}`;

  return (
    <div className="w-full pt-6">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_340px]">
        {/* left — identity, stats, curve, fees */}
        <div className="flex flex-col gap-5">
          <div className="animate-in-slide stagger-1 flex items-center gap-3">
            <div className="flex h-12 w-12 flex-none items-center justify-center overflow-hidden rounded-full border border-white/[0.08] bg-raised text-2xl">
              {l.meta?.image ? <img src={l.meta.image} alt="" className="h-full w-full object-cover" /> : '👁️'}
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-[22px] font-semibold leading-tight tracking-tight text-ink">{name}</h1>
              <div className="flex items-center gap-2 font-mono text-[12px] text-ink-mute">
                <span>${ticker}</span>
                <a
                  href={`https://solscan.io/account/${l.state.mint}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-ink-ghost transition hover:text-pump"
                >
                  {shortenAddress(l.state.mint)} ↗
                </a>
              </div>
            </div>
          </div>

          {/* stats */}
          <div className="animate-in-slide stagger-2 float p-5" style={{ borderRadius: '20px' }}>
            <div className="grid grid-cols-3 gap-2 text-[12px]">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-ghost">mcap</div>
                <div className="font-mono font-bold tabular-nums text-pump">
                  {mcap !== null ? <RollingNumber value={formatUsd(mcap)} /> : '···'}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-ghost">price</div>
                <div className="font-mono font-bold tabular-nums text-ink">
                  {price !== null ? formatUsd(price * SOL_PRICE_USD) : '···'}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-ghost">in curve</div>
                <div className="font-mono font-bold tabular-nums text-ink">
                  ◎{l.solVaultLamports !== null ? formatSol(l.solVaultLamports - RENT_FLOOR) : '···'}
                </div>
              </div>
            </div>

            {/* curve progress — how much of the supply has left the curve */}
            <div className="mt-4 border-t border-white/[0.06] pt-3">
              <div className="mb-1.5 flex items-center justify-between text-[11px] text-ink-ghost">
                <span>curve progress</span>
                <span className="font-mono tabular-nums">{sold !== null ? `${(sold * 100).toFixed(1)}%` : '···'}</span>
              </div>
              <span className="relative block h-1 w-full overflow-hidden rounded-full bg-white/[0.09]">
                <span
                  className="block h-full rounded-full bg-pump/70 transition-all duration-500"
                  style={{ width: `${Math.max(0.4, (sold ?? 0) * 100)}%` }}
                />
              </span>
            </div>
          </div>

          {/* climb status / migrate crank */}
          <div className="animate-in-slide stagger-3 float p-5" style={{ borderRadius: '20px' }}>
            {climbing && (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-ghost">
                    climb ends in
                  </div>
                  <div className="mt-0.5">
                    <Countdown endsAt={climbEndSeconds(l)} />
                  </div>
                </div>
                <p className="max-w-[30ch] text-[12px] leading-relaxed text-ink-mute">
                  only verified single wallets can buy during the climb.
                </p>
              </div>
            )}
            {climbOver && (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-[13px] font-bold text-ink">the climb is over</div>
                  <p className="mt-1 max-w-[36ch] text-[12px] leading-relaxed text-ink-mute">
                    buys are open to everyone. anyone can crank the migration — liquidity seats into a
                    permanently locked DAMM v2 pool.
                  </p>
                </div>
                {connected ? (
                  <button onClick={doMigrate} disabled={busy} className={`btn-pump px-5 py-2.5 text-[13px] ${busy ? 'btn-loading' : ''}`}>
                    migrate
                  </button>
                ) : (
                  <button onClick={login} className="btn-ghost px-5 py-2.5 text-[13px]">
                    connect to migrate
                  </button>
                )}
              </div>
            )}
            {migrated && (
              <div>
                <div className="text-[13px] font-bold text-pump">migrated ✓</div>
                <p className="mt-1 max-w-[46ch] text-[12px] leading-relaxed text-ink-mute">
                  the transfer hook is torn down forever and the curve's liquidity is permanently locked
                  in a DAMM v2 pool — this token trades freely everywhere.
                </p>
              </div>
            )}
          </div>

          {/* fees — permissionless claim crank */}
          <div className="animate-in-slide stagger-4 float flex flex-wrap items-center justify-between gap-3 p-5" style={{ borderRadius: '20px' }}>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-ghost">
                fees accrued
              </div>
              <div className="font-mono text-[15px] font-bold tabular-nums text-pump">
                ◎{formatSol(claimable)}
              </div>
              <div className="text-[10px] text-ink-ghost">splits 50/50 creator / protocol</div>
            </div>
            <button
              onClick={connected ? doClaim : login}
              disabled={connected && (busy || claimable <= 0n)}
              className="btn-ghost px-4 py-1.5 text-[12px]"
            >
              claim
            </button>
          </div>
        </div>

        {/* right — trade panel */}
        <div className="animate-in-slide stagger-2 flex flex-col gap-4 md:sticky md:top-24 md:self-start">
          <div className="float p-5" style={{ borderRadius: '20px' }}>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-widest text-ink-ghost">trade</span>
              {climbing && <span className="live-dot h-1.5 w-1.5 rounded-full bg-pump" />}
            </div>

            {migrated ? (
              <div className="py-2">
                <p className="text-[13px] font-semibold text-ink-dim">the curve is closed.</p>
                <p className="mt-1 text-[12px] leading-relaxed text-ink-ghost">
                  migrated — trade on the open market.
                </p>
              </div>
            ) : (
              <>
                {connected && walletTokens > 0n && (
                  <div className="mb-3 font-mono text-[11px] tabular-nums text-ink-mute">
                    you hold {formatTokens(walletTokens)} ${ticker}
                  </div>
                )}

                <TabsPill
                  options={[
                    { id: 'buy', label: 'buy' },
                    { id: 'sell', label: 'sell' },
                  ]}
                  value={side}
                  onChange={(v) => {
                    setSide(v as 'buy' | 'sell');
                    setAmount('');
                    setNote(null);
                  }}
                />

                <div className="mt-4">
                  <div className="mb-1.5 flex items-center justify-between">
                    <label className="text-[12px] font-semibold text-ink-mute">
                      amount · {side === 'buy' ? 'SOL' : `$${ticker}`}
                    </label>
                    {side === 'sell' && walletTokens > 0n && (
                      <button
                        onClick={() => setAmount((Number(walletTokens) / 1e6).toString())}
                        className="font-mono text-[11px] text-ink-ghost transition hover:text-pump"
                      >
                        max
                      </button>
                    )}
                  </div>
                  <input
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    inputMode="decimal"
                    placeholder="0.0"
                    className="field font-mono"
                  />
                  <p className="mt-1 text-right font-mono text-[10px] text-ink-ghost">
                    {side === 'buy'
                      ? `balance ◎${walletSol !== null ? formatSol(walletSol) : '···'}`
                      : `balance ${formatTokens(walletTokens)} $${ticker}`}
                  </p>
                </div>

                <div className="well mt-2 rounded-2xl p-4 text-[12px] leading-relaxed text-ink-dim">
                  {estimate ? (
                    <>
                      <div>
                        you receive ≈{' '}
                        <span className="font-mono font-bold text-ink">
                          {side === 'buy' ? `${formatTokens(estimate.out)} $${ticker}` : `◎${formatSol(estimate.out)}`}
                        </span>
                      </div>
                      <div className="text-ink-ghost">
                        min {side === 'buy' ? formatTokens(estimate.min) : `◎${formatSol(estimate.min)}`} · 5%
                        slippage · 1% fee
                      </div>
                    </>
                  ) : (
                    <div className="text-ink-ghost">enter an amount — 1% fee · 5% slippage protection</div>
                  )}
                </div>

                <button
                  disabled={connected && (busy || !estimate)}
                  onClick={connected ? doTrade : login}
                  className={`btn-pump mt-4 w-full py-3.5 text-[14px] ${busy ? 'btn-loading' : ''}`}
                >
                  {tradeLabel}
                </button>

                {climbing && connected && attested === false && phase === 'idle' && (
                  <p className="mt-2 text-center text-[11px] leading-relaxed text-ink-ghost">
                    buying during the climb verifies your pump.fun profile first.
                  </p>
                )}

                {note && (
                  <p
                    className={`animate-row-in mt-2 text-[12px] font-medium ${
                      note.kind === 'error' ? 'text-ember' : note.kind === 'ok' ? 'text-pump' : 'text-ink-mute'
                    }`}
                  >
                    {note.text}
                    {note.sig && (
                      <>
                        {' '}
                        <a
                          href={`https://solscan.io/tx/${note.sig}`}
                          target="_blank"
                          rel="noreferrer"
                          className="underline"
                        >
                          view ↗
                        </a>
                      </>
                    )}
                  </p>
                )}
              </>
            )}
          </div>

          <p className="text-center font-mono text-[11px] text-ink-ghost">
            1B supply · locked liquidity · 50% of fees to the creator
          </p>
        </div>
      </div>
    </div>
  );
}
