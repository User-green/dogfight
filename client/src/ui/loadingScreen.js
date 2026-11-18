/** Canvas loading screen with a real progress bar (and an error state with a Retry button). */
export function drawLoading(ctx, size, progress, label) {
  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#fff';
  ctx.font = '28px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('LOADING', size / 2, size / 2 - 40);
  ctx.strokeStyle = '#fff';
  ctx.strokeRect(size / 2 - 200, size / 2 - 12, 400, 24);
  ctx.fillStyle = '#00ff66';
  ctx.fillRect(size / 2 - 198, size / 2 - 10, 396 * progress, 20);
  ctx.fillStyle = '#888';
  ctx.font = '16px monospace';
  ctx.fillText(label, size / 2, size / 2 + 44);
}
