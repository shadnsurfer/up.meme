import { useEffect, useState } from 'react';

function pad(n: number) {
  return n.toString().padStart(2, '0');
}

export function useNowSeconds(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function Countdown({ endsAt }: { endsAt: number }) {
  const now = useNowSeconds();
  const left = Math.max(0, endsAt - now);
  const d = Math.floor(left / 86400);
  const h = Math.floor((left % 86400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;

  const text = d > 0 ? `${d}d ${pad(h)}h ${pad(m)}m` : `${pad(h)}:${pad(m)}:${pad(s)}`;

  return (
    <span className="font-mono text-[13px] font-semibold tabular-nums tracking-tight text-pump-soft">
      {left === 0 ? 'closing…' : text}
    </span>
  );
}
