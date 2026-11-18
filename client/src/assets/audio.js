// Owns the AudioContext. It listens to world events; the simulation never imports this file.

export function createAudio() {
  const ctx = new AudioContext(); // starts 'suspended' until a user gesture
  const buffers = new Map();

  return {
    ctx,
    setBuffer(name, buffer) {
      if (buffer) buffers.set(name, buffer);
    },
    /** Must be called from a click / keydown handler (autoplay policy). */
    unlock() {
      return ctx.state === 'running' ? Promise.resolve() : ctx.resume();
    },
    play(name, { volume = 0.4 } = {}) {
      const buffer = buffers.get(name);
      if (!buffer || ctx.state !== 'running') return; // missing asset => silence, not a crash
      const src = ctx.createBufferSource(); // one-shot node: cheap, allows overlapping playback
      const gain = ctx.createGain();
      gain.gain.value = volume;
      src.buffer = buffer;
      src.connect(gain).connect(ctx.destination);
      src.start();
    },
    /** Subscribe to the world's event bus. */
    attach(bus) {
      bus.addEventListener('fired', () => this.play('shoot', { volume: 0.25 }));
      bus.addEventListener('hit', () => this.play('hit'));
      bus.addEventListener('exploded', () => this.play('explosion', { volume: 0.5 }));
    },
  };
}
