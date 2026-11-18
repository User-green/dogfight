// createLoop(): фіксований крок симуляції (Fix Your Timestep) на requestAnimationFrame.
//
// Вимоги з завдання:
// - симуляція рівно 60 разів/с на будь-якому моніторі (акумулятор часу)
// - рендер — з інтерполяцією між попереднім і поточним станом
// - HUD показує steps/s, frames/s і час кадру

export interface LoopMetrics {
  fps: number;
  stepsPerSecond: number;
  frameTimeMs: number;
}

export interface LoopOptions {
  update: (dt: number) => void;
  render: (alpha: number, metrics: LoopMetrics) => void;
  timestep?: number;
}

export function createLoop({ update, render, timestep = 1 / 60 }: LoopOptions): { start(): void; stop(): void } {
  const TIMESTEP = timestep; // за замовчуванням 60 оновлень/с; мережевий клієнт ставить 1/30 = крок сервера
  let lastTime = 0;
  let accumulator = 0;
  let running = false;
  let rafId: number | null = null;

  // Метрики для HUD
  let framesThisSecond = 0;
  let stepsThisSecond = 0;
  let lastFpsUpdate = 0;
  let fps = 0;
  let stepsPerSecond = 0;
  let lastFrameDurationMs = 0;

  function tick(currentTimeMs: number): void {
    if (!running) return;

    // Edge case 2.1: Перший кадр
    if (lastTime === 0) {
      lastTime = currentTimeMs;
    }

    let frameTime = (currentTimeMs - lastTime) / 1000;
    lastTime = currentTimeMs;
    lastFrameDurationMs = frameTime * 1000;

    // Edge case 3.1: Захист від "спіралі смерті" при паузі/перемиканні вкладок
    if (frameTime > 0.25) {
      frameTime = 0.25;
    }

    accumulator += frameTime;

    // Крок 4: Вичерпуємо накопичений час фіксованими квантами
    while (accumulator >= TIMESTEP) {
      update(TIMESTEP);
      accumulator -= TIMESTEP;
      stepsThisSecond++;
    }

    // Крок 5: alpha — частка кроку, що залишилася (для інтерполяції)
    const alpha = accumulator / TIMESTEP;
    render(alpha, {
      fps,
      stepsPerSecond,
      frameTimeMs: lastFrameDurationMs
    });
    framesThisSecond++;

    // Оновлення лічильників HUD кожну секунду
    if (currentTimeMs - lastFpsUpdate >= 1000) {
      fps = framesThisSecond;
      stepsPerSecond = stepsThisSecond;
      framesThisSecond = 0;
      stepsThisSecond = 0;
      lastFpsUpdate = currentTimeMs;
    }

    rafId = requestAnimationFrame(tick);
  }

  return {
    start() {
      if (running) return;
      running = true;
      lastTime = 0;
      rafId = requestAnimationFrame(tick);
    },
    stop() {
      running = false;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    }
  };
}
