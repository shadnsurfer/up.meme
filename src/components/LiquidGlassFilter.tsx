import { useEffect, useState, type CSSProperties } from 'react';

/**
 * iOS-style liquid glass: an SVG displacement filter applied to the backdrop.
 *
 * A lens displacement map is generated on a canvas once (rounded-rect SDF,
 * displacement strongest near the rim, zero in the middle), then referenced
 * from an SVG filter used as `backdrop-filter: url(#...)`. Browsers without
 * SVG backdrop-filter support (Firefox) keep the frosted-blur fallback.
 */

export const LG_FILTER_ID = 'up-liquid-glass';

// map geometry — wide bar proportions (nav / tab pill)
const MW = 1024;
const MH = 64;
const RADIUS = 30;
const EDGE = 16; // rim falloff depth in map px

function roundedRectSDF(x: number, y: number): number {
  const qx = Math.abs(x - MW / 2) - (MW / 2 - RADIUS);
  const qy = Math.abs(y - MH / 2) - (MH / 2 - RADIUS);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - RADIUS;
}

let cachedMap: string | null = null;

function buildDisplacementMap(): string {
  if (cachedMap) return cachedMap;

  const canvas = document.createElement('canvas');
  canvas.width = MW;
  canvas.height = MH;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(MW, MH);
  const eps = 1;

  for (let y = 0; y < MH; y++) {
    for (let x = 0; x < MW; x++) {
      const sd = roundedRectSDF(x, y); // negative inside
      const gx = roundedRectSDF(x + eps, y) - roundedRectSDF(x - eps, y);
      const gy = roundedRectSDF(x, y + eps) - roundedRectSDF(x, y - eps);
      const len = Math.hypot(gx, gy) || 1;

      // 1 at the rim → 0 once we're EDGE px inside
      const inside = Math.max(0, -sd);
      const t = Math.max(0, Math.min(1, 1 - inside / EDGE));
      const falloff = t * t * (3 - 2 * t);

      // pull samples inward near the rim → lens refraction feel
      const dx = (-gx / len) * falloff;
      const dy = (-gy / len) * falloff;

      const i = (y * MW + x) * 4;
      img.data[i] = 128 + dx * 127;
      img.data[i + 1] = 128 + dy * 127;
      img.data[i + 2] = 128;
      img.data[i + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  cachedMap = canvas.toDataURL('image/png');
  return cachedMap;
}

export function supportsLiquidGlass(): boolean {
  return (
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    CSS.supports('backdrop-filter', 'url(#x)')
  );
}

/** renders the hidden SVG filter; call once near the app root */
export function LiquidGlassFilter({ scale = 26 }: { scale?: number }) {
  const [map, setMap] = useState<string | null>(null);

  useEffect(() => {
    setMap(buildDisplacementMap());
  }, []);

  if (!map) return null;

  // chromatic aberration: red is displaced hardest, blue least — the small
  // scale delta leaves a faint blue/orange fringe along the lens rim
  const fringe = 5;

  return (
    <svg aria-hidden width="0" height="0" style={{ position: 'absolute', overflow: 'hidden' }}>
      <filter id={LG_FILTER_ID}>
        <feImage
          href={map}
          x="0"
          y="0"
          width="100%"
          height="100%"
          preserveAspectRatio="none"
          result="map"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="map"
          scale={scale + fringe}
          xChannelSelector="R"
          yChannelSelector="G"
          result="dispR"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="map"
          scale={scale}
          xChannelSelector="R"
          yChannelSelector="G"
          result="dispG"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="map"
          scale={scale - fringe}
          xChannelSelector="R"
          yChannelSelector="G"
          result="dispB"
        />
        {/* isolate each channel, then recombine additively (alpha kept on all
            three — zeroing alpha clamps the channel away in premultiplied space) */}
        <feColorMatrix
          in="dispR"
          type="matrix"
          values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
          result="r"
        />
        <feColorMatrix
          in="dispG"
          type="matrix"
          values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"
          result="g"
        />
        <feColorMatrix
          in="dispB"
          type="matrix"
          values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"
          result="b"
        />
        <feBlend in="r" in2="g" mode="screen" result="rg" />
        <feBlend in="rg" in2="b" mode="screen" />
      </filter>
    </svg>
  );
}

/** inline style to apply the liquid filter, or null when unsupported */
export function liquidGlassStyle(): CSSProperties | null {
  if (!supportsLiquidGlass()) return null;
  // no saturate/tint — the nav stays color-neutral, only the lens distorts
  return {
    backdropFilter: `url(#${LG_FILTER_ID})`,
    WebkitBackdropFilter: `url(#${LG_FILTER_ID})`,
  };
}
