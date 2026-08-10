import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

/**
 * Anchored dropdown with enter/exit animation.
 * Rendered as a sibling of its trigger inside a `relative` wrapper.
 * `within` should cover trigger + panel so trigger clicks don't double-toggle.
 */
export function Popover({
  open,
  onClose,
  within,
  align = 'right',
  className = '',
  children,
}: {
  open: boolean;
  onClose: () => void;
  within?: RefObject<HTMLElement | null>;
  align?: 'left' | 'right';
  className?: string;
  children: ReactNode;
}) {
  const [render, setRender] = useState(open);
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setRender(true);
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    }
    setShown(false);
    const t = window.setTimeout(() => setRender(false), 180);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!render) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (within?.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [render, onClose, within]);

  if (!render) return null;

  return (
    <div
      ref={ref}
      data-open={shown}
      className={`popover absolute top-[calc(100%+10px)] z-[150] ${
        align === 'right' ? 'right-0' : 'left-0'
      } ${className}`}
    >
      {children}
    </div>
  );
}
