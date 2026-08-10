import { useRef, useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { useWallets as useSolanaWallets } from '@privy-io/react-auth/solana';
import { privyEnabled } from '../lib/privy';
import { Popover } from './Popover';

function truncate(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

/** same look before Privy is configured — login stays disabled without an app id */
function DisabledConnect() {
  return (
    <button
      onClick={() =>
        // eslint-disable-next-line no-console
        console.warn('[up.meme] wallet login disabled — set VITE_PRIVY_APP_ID in .env.local')
      }
      title="set VITE_PRIVY_APP_ID to enable login"
      className="btn-pump px-4 py-2 text-[13px]"
    >
      connect
    </button>
  );
}

function PrivyConnect() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useSolanaWallets();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  if (!ready) {
    return (
      <button disabled className="btn-ghost px-4 py-2 text-[13px] opacity-60">
        …
      </button>
    );
  }

  if (!authenticated) {
    return (
      <button onClick={login} className="btn-pump px-4 py-2 text-[13px]">
        connect
      </button>
    );
  }

  // external solana wallet from login; fall back to an embedded wallet if present
  const wallet = wallets[0]?.address ?? '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(wallet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`btn-ghost flex items-center gap-2 px-3.5 py-2 font-mono text-[13px] ${
          open ? 'border-pump/50 text-ink' : ''
        }`}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-pump shadow-[0_0_8px_rgba(95,203,136,0.8)]" />
        {wallet ? truncate(wallet) : 'connected'}
        <span
          className={`text-[9px] text-ink-ghost transition-transform duration-200 ${
            open ? 'rotate-180' : ''
          }`}
        >
          ▾
        </span>
      </button>

      <Popover open={open} onClose={() => setOpen(false)} within={wrapRef} className="w-60">
        <div className="float overflow-hidden p-1.5" style={{ borderRadius: 18 }}>
          <div className="px-3 pb-1.5 pt-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-ghost">
              wallet
            </div>
            <div className="mt-0.5 font-mono text-[12px] text-ink-dim">
              {wallet ? truncate(wallet) : 'embedded wallet'}
            </div>
          </div>
          <button onClick={copy} className="menu-item">
            {copied ? <span className="text-pump">copied ✓</span> : 'copy address'}
          </button>
          <a
            href={`https://solscan.io/account/${wallet}`}
            target="_blank"
            rel="noreferrer"
            onClick={() => setOpen(false)}
            className="menu-item"
          >
            view on solscan ↗
          </a>
          <div className="mx-2 my-1 border-t border-white/[0.07]" />
          <button
            onClick={() => {
              setOpen(false);
              logout();
            }}
            className="menu-item menu-item-danger"
          >
            disconnect
          </button>
        </div>
      </Popover>
    </div>
  );
}

export function ConnectButton() {
  return privyEnabled ? <PrivyConnect /> : <DisabledConnect />;
}
