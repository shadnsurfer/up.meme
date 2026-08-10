/**
 * React bindings for the chain layer.
 *
 * Privy is optional in this app (main.tsx mounts PrivyProvider only when
 * VITE_PRIVY_APP_ID is set), so every hook that needs Privy has two module-level
 * implementations and the export picks one based on the build-time constant
 * `privyEnabled` — components can call them unconditionally without crashing
 * when the provider is absent.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { useWallets as useSolanaWallets } from '@privy-io/react-auth/solana';
import type { ConnectedStandardSolanaWallet } from '@privy-io/react-auth/solana';
import { address, type Address } from '@solana/kit';
import {
  fetchAllLaunches,
  fetchAttestationExists,
  fetchLaunchByMint,
  getCachedMeta,
  hasMetaSettled,
  onMetaSettled,
  type LiveLaunch,
} from './chain';
import { privyEnabled } from './privy';

// ---------- connected wallet ----------
export interface ConnectedWallet {
  ready: boolean;
  connected: boolean;
  address: Address | null;
  wallet: ConnectedStandardSolanaWallet | null;
}

function useConnectedWalletReal(): ConnectedWallet {
  const { ready, authenticated } = usePrivy();
  const { wallets } = useSolanaWallets();
  const wallet = wallets[0] ?? null;
  return {
    ready,
    connected: authenticated && wallet !== null,
    address: wallet ? address(wallet.address) : null,
    wallet,
  };
}

function useConnectedWalletStub(): ConnectedWallet {
  return { ready: true, connected: false, address: null, wallet: null };
}

export const useConnectedWallet = privyEnabled ? useConnectedWalletReal : useConnectedWalletStub;

// ---------- login trigger ----------
function usePrivyLoginReal(): () => void {
  const { login } = usePrivy();
  return login;
}

function usePrivyLoginStub(): () => void {
  return () =>
    // eslint-disable-next-line no-console
    console.warn('[up.meme] wallet login disabled — set VITE_PRIVY_APP_ID in .env.local');
}

export const usePrivyLogin = privyEnabled ? usePrivyLoginReal : usePrivyLoginStub;

// ---------- shared launches store ----------
export type LaunchesStatus = 'loading' | 'ready' | 'error';
interface LaunchesSnapshot {
  launches: LiveLaunch[];
  status: LaunchesStatus;
}

const POLL_MS = 15_000;
let snapshot: LaunchesSnapshot = { launches: [], status: 'loading' };
const listeners = new Set<() => void>();
let timer: number | null = null;
let stopMeta: (() => void) | null = null;
let fetching = false;

function emit() {
  for (const cb of listeners) cb();
}

/** drop freshly-arrived metadata into the cached launch objects */
function withMeta(l: LiveLaunch): LiveLaunch {
  return { ...l, meta: getCachedMeta(l.state.mint), metaLoaded: hasMetaSettled(l.state.mint) };
}

async function pullLaunches() {
  if (fetching) return;
  fetching = true;
  try {
    const launches = (await fetchAllLaunches()).map(withMeta);
    snapshot = { launches, status: 'ready' };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[up.meme] failed to load launches', e);
    // keep serving the last good list; only flap to error when there is nothing
    snapshot = { launches: snapshot.launches, status: snapshot.launches.length > 0 ? 'ready' : 'error' };
  } finally {
    fetching = false;
    emit();
  }
}

function subscribeLaunches(cb: () => void): () => void {
  listeners.add(cb);
  if (listeners.size === 1) {
    void pullLaunches();
    timer = window.setInterval(() => void pullLaunches(), POLL_MS);
    stopMeta = onMetaSettled(() => {
      snapshot = { ...snapshot, launches: snapshot.launches.map(withMeta) };
      emit();
    });
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      stopMeta?.();
      stopMeta = null;
    }
  };
}

/** every launch on the program, polling while mounted anywhere */
export function useLaunches(): LaunchesSnapshot & { refresh: () => void } {
  const snap = useSyncExternalStore(subscribeLaunches, () => snapshot);
  return { ...snap, refresh: () => void pullLaunches() };
}

// ---------- single launch (coin page) ----------
export type LaunchStatus = 'loading' | 'ready' | 'missing' | 'error';

export function useLaunch(mint: Address | null, pollMs = 4_000): {
  launch: LiveLaunch | null;
  status: LaunchStatus;
  refresh: () => void;
} {
  const [launch, setLaunch] = useState<LiveLaunch | null>(null);
  const [status, setStatus] = useState<LaunchStatus>('loading');

  const refresh = useCallback(async () => {
    if (!mint) return;
    try {
      const next = await fetchLaunchByMint(mint);
      if (next === null) {
        setStatus('missing');
        return;
      }
      setLaunch({ ...next, meta: getCachedMeta(next.state.mint), metaLoaded: hasMetaSettled(next.state.mint) });
      setStatus('ready');
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[up.meme] failed to load launch', e);
      setStatus((s) => (s === 'ready' ? s : 'error'));
    }
  }, [mint]);

  useEffect(() => {
    setLaunch(null);
    setStatus('loading');
    void refresh();
    const t = window.setInterval(() => void refresh(), pollMs);
    return () => window.clearInterval(t);
    // refresh identity tracks mint; pollMs restarts the cadence
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mint, pollMs]);

  // pick up launch metadata when it streams in
  useEffect(
    () =>
      onMetaSettled(() => {
        setLaunch((l) => (l ? { ...l, meta: getCachedMeta(l.state.mint), metaLoaded: hasMetaSettled(l.state.mint) } : l));
      }),
    [],
  );

  return { launch, status, refresh: () => void refresh() };
}

// ---------- attestation ----------
/** null while unknown; permanent once true (attestations never expire) */
export function useAttestation(wallet: Address | null, pollMs = 6_000): boolean | null {
  const [attested, setAttested] = useState<boolean | null>(null);

  useEffect(() => {
    if (!wallet) {
      setAttested(null);
      return;
    }
    let cancelled = false;
    const check = async () => {
      try {
        const yes = await fetchAttestationExists(wallet);
        if (!cancelled) setAttested(yes);
        return yes;
      } catch {
        return false;
      }
    };
    void check();
    const t = window.setInterval(() => {
      if (attested) return; // permanent — stop polling once set
      void check();
    }, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [wallet, pollMs, attested]);

  return attested;
}
