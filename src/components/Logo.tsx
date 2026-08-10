/**
 * Brand lockup: the up-arrow mark + ".meme".
 * Uses the green mark on dark surfaces.
 */
export function Logo({ size = 24, withWord = true }: { size?: number; withWord?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <img
        src="/logo-green.png"
        alt="up.meme"
        style={{ height: size, width: size }}
        className="object-contain"
      />
      {withWord && (
        <span className="text-[15px] font-extrabold tracking-tight text-ink">
          up<span className="text-pump">.meme</span>
        </span>
      )}
    </span>
  );
}
