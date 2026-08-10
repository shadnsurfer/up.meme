import { Link } from 'react-router-dom';

export function NotFound() {
  return (
    <div className="flex min-h-[100dvh] w-full flex-col items-center justify-center gap-4 bg-void px-6 text-center">
      <img src="/logo-green.png" alt="up.meme" className="h-14 w-14 object-contain opacity-80" />
      <p className="text-[15px] font-bold text-ink">this page blinked first.</p>
      <p className="text-[13px] text-ink-mute">it's gone. this page doesn't exist.</p>
      <Link to="/" className="btn-pump mt-2 px-5 py-2.5 text-[13px]">
        back to up.meme
      </Link>
    </div>
  );
}
