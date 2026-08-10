import { useLocation } from 'react-router-dom';

/**
 * Brand page transition: a thin mint bar sweeps across the top of the viewport
 * on every navigation / reload — the page being "uploaded". Re-mounts per
 * pathname so the keyframe replays each time.
 */
export function PageSweep() {
  const { pathname } = useLocation();
  return <div key={pathname} className="page-sweep" aria-hidden />;
}
