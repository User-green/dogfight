/** HUD owner. Subscribes to world events; the sim does not import this. */
export function createHud(el, bus) {
  let toast = '';
  let toastUntil = 0;
  bus.addEventListener('scoreChanged', (e) => {
    toast = `+${e.detail.delta}`;
    toastUntil = performance.now() + 800;
  });
  return {
    render(lines) {
      const t = performance.now() < toastUntil ? `  <b>${toast}</b>` : '';
      el.innerHTML = lines.map((l, i) => (i === 1 ? l + t : l)).join('<br>');
    },
  };
}
