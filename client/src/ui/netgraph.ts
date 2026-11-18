import { query } from '../dom.ts';
import type { GameClient } from '../net/gameclient.ts';

// Netgraph: the numbers that make netcode visible. Pure view: reads GameClient.metrics(), changes nothing but the interpolation delay.
export function mountNetgraph(el: HTMLElement, getClient: () => GameClient | null, { onDelay }: { onDelay?: (ms: number) => void } = {}): { render(): void } {
  el.innerHTML = '<pre></pre><canvas width="240" height="48"></canvas>';
  const pre = query(el, 'pre');
  const cv = query<HTMLCanvasElement>(el, 'canvas');
  const g = cv.getContext('2d');
  if (!g) throw new Error('2d canvas context unavailable');
  window.addEventListener('keydown', (e) => {
    const c = getClient();
    if (!c || (e.key !== '[' && e.key !== ']')) return;
    c.config.interpDelayMs = Math.max(0, Math.min(500, c.config.interpDelayMs + (e.key === ']' ? 16 : -16)));
    onDelay?.(c.config.interpDelayMs);
  });
  return {
    render() {
      const c = getClient();
      if (!c) return;
      const m = c.metrics();
      const cfg = c.config;
      pre.textContent = [
        `rtt ${m.rttMs.toFixed(0)} ms   snap age ${m.snapshotAgeMs.toFixed(0)} ms   ${m.snapshotsPerSec.toFixed(0)} snap/s`,
        `in ${(m.bytesInPerSec / 1024).toFixed(2)} KB/s   out ${(m.bytesOutPerSec / 1024).toFixed(2)} KB/s   codec ${c.codec.name}`,
        `pending inputs ${m.pending}   starved ${m.starved}   out-of-order ${m.outOfOrder}`,
        `correction ${m.correction.toFixed(2)} (max ${m.correctionMax.toFixed(1)})`,
        `interp ${cfg.interpDelayMs} ms [ / ]   predict ${+cfg.predict} reconcile ${+cfg.reconcile} interp ${+cfg.interpolate}`,
      ].join('\n');
      g.clearRect(0, 0, cv.width, cv.height);
      g.strokeStyle = '#333';
      g.strokeRect(0.5, 0.5, cv.width - 1, cv.height - 1);
      const h = m.history.slice(-120);
      g.fillStyle = '#ff6644';
      h.forEach((x, i) => {
        const bar = Math.min(cv.height - 2, Math.log10(1 + x.mag * 10) * 14); // log scale: 0.1 and 100 units are both visible
        g.fillRect(2 + i * 2, cv.height - 1 - bar, 1.5, bar);
      });
    },
  };
}
