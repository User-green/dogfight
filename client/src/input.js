// createInput(): обробка клавіатури як замикання (closure), без глобального стану.
// Повертає знімок стану натиснутих клавіш на поточний момент.

export function createInput() {
  const keys = new Set();

  function onKeyDown(event) {
    keys.add(event.code);
  }

  function onKeyUp(event) {
    keys.delete(event.code);
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  return {
    getState() {
      return {
        thrust: keys.has('KeyW') || keys.has('ArrowUp'),
        rotateLeft: keys.has('KeyA') || keys.has('ArrowLeft'),
        rotateRight: keys.has('KeyD') || keys.has('ArrowRight'),
        fire: keys.has('Space'),
      };
    },
    destroy() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    }
  };
}
