const DIGITS = Array.from({ length: 10 }, (_, i) => i);

/**
 * Odometer-style number: each digit is a vertical 0–9 strip that rolls to the
 * new value when it changes. Use inside a font-mono context (widths assume
 * tabular figures). Non-digit characters fade/slide in when they change.
 */
export function RollingNumber({ value, className = '' }: { value: string; className?: string }) {
  return (
    <span className={`inline-flex items-center ${className}`} aria-label={value} role="text">
      {value.split('').map((c, i) =>
        c >= '0' && c <= '9' ? (
          <span key={`${i}-${c}`} className="rn-digit" aria-hidden>
            <span className="rn-strip" style={{ transform: `translateY(-${Number(c)}em)` }}>
              {DIGITS.map((d) => (
                <span key={d} className="rn-cell">
                  {d}
                </span>
              ))}
            </span>
          </span>
        ) : (
          <span key={`${i}-${c}`} className="rn-static" aria-hidden>
            {c}
          </span>
        ),
      )}
    </span>
  );
}
