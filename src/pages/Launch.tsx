import { useRef, useState, type DragEvent } from 'react';
import { Countdown } from '../components/Countdown';

const blinkPresets = [
  { label: '15m', seconds: 900 },
  { label: '1h', seconds: 3600 },
  { label: '6h', seconds: 21600 },
  { label: '1d', seconds: 86400 },
  { label: '3d', seconds: 259200 },
];

type LaunchState = 'idle' | 'confirming' | 'launching' | 'done';

export function Launch() {
  const [image, setImage] = useState<string | null>(null);
  const [imageError, setImageError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [name, setName] = useState('');
  const [ticker, setTicker] = useState('');
  const [description, setDescription] = useState('');
  const [telegram, setTelegram] = useState('');
  const [website, setWebsite] = useState('');
  const [blink, setBlink] = useState(3600);
  const [state, setState] = useState<LaunchState>('idle');
  const fileRef = useRef<HTMLInputElement>(null);

  const ready = name.trim().length > 0 && ticker.trim().length > 0 && image !== null;
  const busy = state === 'confirming' || state === 'launching';

  const pickImage = (file: File | undefined) => {
    setImageError('');
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      setImageError('Use a PNG, JPG, WEBP or GIF image.');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setImageError('Image must be under 2 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setImage(reader.result as string);
    reader.readAsDataURL(file);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    pickImage(e.dataTransfer.files?.[0]);
  };

  const fakeLaunch = () => {
    setState('confirming');
    setTimeout(() => setState('launching'), 1200);
    setTimeout(() => setState('done'), 3000);
  };

  const buttonLabel = {
    idle: ready ? `launch $${ticker}` : 'connect wallet to launch',
    confirming: 'confirm in wallet…',
    launching: 'launching on-chain…',
    done: 'launched ✓',
  }[state];

  return (
    <div className="w-full pt-6">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_340px]">
        {/* form */}
        <div className="flex flex-col gap-5">
          <div className="animate-in-slide stagger-1">
            <h1 className="display-serif text-[30px] leading-tight text-ink">launch a coin</h1>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-mute">
              one click. identical terms for everyone. no presale, no allocation, no insiders.
            </p>
          </div>

          {/* image — drag & drop or tap */}
          <div className="animate-in-slide stagger-2">
            <button
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={`well group flex h-28 w-full items-center justify-center gap-3 rounded-2xl border-dashed transition-all duration-200 ${
                dragging
                  ? 'scale-[1.01] border-pump/70 bg-pump/[0.07] shadow-[0_0_28px_rgba(95,203,136,0.18)]'
                  : 'hover:border-pump/40 hover:bg-white/[0.06]'
              }`}
            >
              {image ? (
                <div className="flex items-center gap-3">
                  <img src={image} alt="token" className="h-16 w-16 rounded-2xl object-cover" />
                  <span className="text-[12px] font-semibold text-ink-mute group-hover:text-ink">
                    tap to replace · or drop a new one
                  </span>
                </div>
              ) : (
                <>
                  <span
                    className={`well flex h-9 w-9 items-center justify-center rounded-full text-[15px] text-ink-mute transition-all duration-200 group-hover:-translate-y-0.5 group-hover:text-pump ${
                      dragging ? '-translate-y-1 text-pump' : ''
                    }`}
                  >
                    ⬆
                  </span>
                  <span className="text-[13px] font-semibold text-ink-mute">
                    {dragging ? 'drop it — up it goes' : 'drag & drop or tap to upload'}{' '}
                    <span className="font-normal text-ink-ghost">· PNG, JPG, WEBP or GIF, under 2 MB</span>
                  </span>
                </>
              )}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(e) => pickImage(e.target.files?.[0])}
            />
            {imageError && <p className="animate-row-in mt-1.5 text-[12px] font-medium text-ember">{imageError}</p>}
          </div>

          {/* name / ticker */}
          <div className="animate-in-slide stagger-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-[12px] font-semibold text-ink-mute">name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Fair Cat"
                className="field"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[12px] font-semibold text-ink-mute">ticker</label>
              <input
                value={ticker}
                onChange={(e) => setTicker(e.target.value.toUpperCase().slice(0, 10))}
                placeholder="FAIRC"
                className="field font-mono"
              />
              <p className="mt-1 text-right font-mono text-[10px] text-ink-ghost">{ticker.length}/10</p>
            </div>
          </div>

          <div className="animate-in-slide stagger-3">
            <label className="mb-1.5 block text-[12px] font-semibold text-ink-mute">description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="what is this coin and why should anyone care"
              className="field resize-none"
            />
          </div>

          <div className="animate-in-slide stagger-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-[12px] font-semibold text-ink-mute">
                telegram <span className="font-normal text-ink-ghost">(optional)</span>
              </label>
              <input
                value={telegram}
                onChange={(e) => setTelegram(e.target.value)}
                placeholder="Telegram username"
                className="field"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[12px] font-semibold text-ink-mute">
                website <span className="font-normal text-ink-ghost">(optional)</span>
              </label>
              <input
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="Website address"
                className="field"
              />
            </div>
          </div>

          {/* blink window */}
          <div className="animate-in-slide stagger-4">
            <label className="mb-1.5 block text-[12px] font-semibold text-ink-mute">
              the blink — how long only verified single wallets can buy
            </label>
            <div className="flex flex-wrap gap-2">
              {blinkPresets.map((p) => (
                <button
                  key={p.seconds}
                  onClick={() => setBlink(p.seconds)}
                  className={`well rounded-full px-4 py-2 font-mono text-[12px] font-bold transition-all duration-150 hover:bg-white/[0.09] active:scale-95 ${
                    blink === p.seconds
                      ? 'border-pump/60 bg-pump/10 text-pump shadow-[0_0_16px_rgba(95,203,136,0.15)]'
                      : 'text-ink-mute'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* fixed terms */}
          <div className="animate-in-slide stagger-4 well rounded-2xl p-4 text-[12px] leading-relaxed text-ink-dim">
            <div className="mb-2 font-bold text-ink">locked-in terms — same for every launch:</div>
            <ul className="space-y-1">
              <li>· 1,000,000,000 supply, 100% seeded to permanently locked liquidity</li>
              <li>· $5,000 starting market cap</li>
              <li>· your wallet deploys, your wallet seeds — no bundling possible</li>
              <li>· you earn 50% of all trading fees, forever</li>
            </ul>
          </div>

          {/* submit */}
          <button
            disabled={busy || state === 'done'}
            onClick={fakeLaunch}
            className={`animate-in-slide stagger-5 w-full py-3.5 text-[14px] ${
              state === 'done'
                ? 'cursor-default rounded-full border border-pump/40 bg-pump/10 font-bold text-pump'
                : `btn-pump ${busy ? 'btn-loading' : ''}`
            }`}
          >
            {buttonLabel}
          </button>
        </div>

        {/* sticky live preview */}
        <div className="animate-in-slide stagger-2 flex flex-col gap-4 md:sticky md:top-24 md:self-start">
          <div className="float p-5" style={{ borderRadius: '20px' }}>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-widest text-ink-ghost">
                live preview
              </span>
              <span className="blink-dot h-1.5 w-1.5 rounded-full bg-pump" />
            </div>
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full border border-white/[0.08] bg-raised text-2xl">
                {image ? <img src={image} alt="" className="h-full w-full object-cover" /> : '👁️'}
              </div>
              <div className="min-w-0">
                <div className="truncate text-[18px] font-extrabold leading-tight tracking-tight text-white">
                  {name || 'your coin'}
                </div>
                <div className="font-mono text-[13px] text-ink-mute">${ticker || '···'}</div>
              </div>
            </div>

            <p className="mt-3 line-clamp-3 min-h-[18px] text-[12px] leading-relaxed text-ink-dim">
              {description}
            </p>

            <div className="mt-4 grid grid-cols-3 gap-2 border-t border-white/[0.06] pt-3 text-[12px]">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-ghost">mcap</div>
                <div className="font-mono font-bold tabular-nums text-pump">$5.0K</div>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-ghost">supply</div>
                <div className="font-mono font-bold tabular-nums text-ink">1B</div>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-widest text-ink-ghost">blink</div>
                <div className="font-mono font-bold text-pump-soft">
                  {blinkPresets.find((p) => p.seconds === blink)?.label}
                </div>
              </div>
            </div>

            {state === 'done' && (
              <div className="animate-rise-check mt-4 rounded-2xl border border-pump/25 bg-pump/10 p-3 text-center">
                <div className="text-[12px] font-bold text-pump">the blink is open</div>
                <div className="mt-1">
                  <Countdown endsAt={Math.floor(Date.now() / 1000) + blink} />
                </div>
              </div>
            )}
          </div>

          <p className="text-center font-mono text-[11px] text-ink-ghost">
            launches on the pump.fun bonding curve · solana
          </p>
        </div>
      </div>
    </div>
  );
}
