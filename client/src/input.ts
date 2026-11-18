// createInput(): обробка клавіатури як замикання (closure), без глобального стану.
// Повертає знімок стану натиснутих клавіш на поточний момент.

export interface InputState {
  thrust: boolean;
  rotateLeft: boolean;
  rotateRight: boolean;
  fire: boolean;
}

export function createInput(): { getState(): InputState; destroy(): void } {
  const keys = new Set<string>();

  function onKeyDown(event: KeyboardEvent): void {
    keys.add(event.code);
  }

  function onKeyUp(event: KeyboardEvent): void {
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
