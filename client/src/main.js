import { createLoop } from './loop.js';
import { createInput } from './input.js';
import { Vector2 } from './sim/vector.js';
import { World } from './sim/world.js';
import { Ship } from './sim/ship.js';
import { Asteroid } from './sim/asteroid.js';
import { Pickup } from './sim/pickup.js';
import { Bullet } from './sim/bullet.js';
import { HomingBehavior } from './sim/homing.js';
import { Kind } from './sim/entity.js';
import { fetchJson, withRetry, loadAll } from './assets/loader.js';
import { createAudio } from './assets/audio.js';
import { createSpriteDrawer } from './assets/sprites.js';
import { Lobby } from './lobby.js';
import { mountLobbyView } from './ui/lobbyView.js';
import { createHud } from './ui/hud.js';
import { drawLoading } from './ui/loadingScreen.js';
import { Connection, defaultWsUrl } from './net/connection.js';
import { mountChat } from './ui/chat.js';

const SIZE = 1000; // logical arena units; canvas is scaled to this
const canvas = document.getElementById('scene');
const hudEl = document.getElementById('hud');
const overlay = document.getElementById('overlay');
const ctx = canvas.getContext('2d');

// Test hook: lets the end-to-end test observe the phase without scraping pixels.
const debug = (window.__lab3 = { phase: 'boot', failures: [], progress: 0, world: null, error: null });

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.resetTransform();
  ctx.scale(canvas.width / SIZE, canvas.height / SIZE);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

/** ?chaos=sprite404,corrupt,json404,slow  -- breaks the manifest on purpose (failure gallery). */
function applyChaos(manifest) {
  const chaos = new URLSearchParams(location.search).get('chaos')?.split(',') ?? [];
  if (chaos.includes('sprite404')) manifest.sprites.url = '/assets/missing.svg';
  if (chaos.includes('json404')) manifest.arena.url = '/assets/missing.json';
  if (chaos.includes('corrupt')) manifest.arena.url = '/assets/corrupt.json';
  if (chaos.includes('slow')) {
    // staggered delays so the progress bar visibly moves in steps
    [manifest.sprites, manifest.arena, ...Object.values(manifest.sounds)].forEach((spec, i) => {
      spec.url = `/__slow/${400 + 500 * i}${spec.url}`;
    });
  }
  return manifest;
}

function showOverlay(html) {
  overlay.innerHTML = html;
  overlay.hidden = false;
}
const hideOverlay = () => (overlay.hidden = true);

const waitForClick = (button) => new Promise((r) => button.addEventListener('click', r, { once: true }));

/** Resolves on the first click or key press: the user gesture the AudioContext needs. */
function waitForGesture() {
  return new Promise((resolve) => {
    const c = new AbortController();
    const done = () => {
      c.abort(); // removes both listeners at once
      resolve();
    };
    window.addEventListener('pointerdown', done, { signal: c.signal });
    window.addEventListener('keydown', done, { signal: c.signal });
  });
}

/** Load with a progress bar; on a required failure show a Retry button instead of dying. */
async function loadWithScreen(audio) {
  for (;;) {
    debug.phase = 'loading';
    try {
      const manifest = applyChaos(await withRetry((s) => fetchJson('/assets/manifest.json', { signal: s })));
      const result = await loadAll(manifest, {
        audioCtx: audio.ctx,
        onProgress: (p, _total, name) => {
          debug.progress = p;
          drawLoading(ctx, SIZE, p, name ? `loaded ${name}` : 'starting...');
        },
      });
      debug.failures = result.failures.map((f) => ({ name: f.name, url: f.url, error: f.error.message }));
      return { ...result, manifest };
    } catch (err) {
      debug.phase = 'load-error';
      debug.error = `${err.name}: ${err.message}`;
      drawLoading(ctx, SIZE, debug.progress, 'FAILED');
      showOverlay(`<p>Could not load game assets:<br>${err.message}</p><button id="retry">Retry</button>`);
      await waitForClick(document.getElementById('retry'));
      hideOverlay();
    }
  }
}

function startGame({ room, playerName, assets, manifest, audio, net }) {
  const arena = { width: assets.arena.width, height: assets.arena.height };
  const input = createInput();
  const world = new World();
  debug.world = world;
  const draw = createSpriteDrawer(assets.sprites, manifest.sprites.frames);
  const hud = createHud(hudEl, world.bus);
  audio.attach(world.bus); // audio subscribes to the sim; the sim never imports audio

  const playerShip = new Ship({ pos: new Vector2(arena.width / 2, arena.height / 2) });
  world.spawn(playerShip);

  function spawnWave(count) {
    for (let i = 0; i < count; i++) {
      let pos;
      do pos = new Vector2(Math.random() * arena.width, Math.random() * arena.height);
      while (pos.sub(playerShip.pos).length() < assets.arena.shipSafeRadius);
      world.spawn(new Asteroid({ pos, tier: 3 }));
    }
  }
  spawnWave(room.asteroids);
  world.spawn(new Pickup({ pos: new Vector2(250, 250), type: 'SHIELD' }));
  world.spawn(new Pickup({ pos: new Vector2(750, 750), type: 'RAPID_FIRE' }));

  function fireHomingMissile() {
    if (!playerShip.alive) return;
    const heading = Vector2.fromAngle(playerShip.angle);
    const missile = new Bullet({
      pos: playerShip.pos.add(heading.scale(20)),
      vel: playerShip.vel.add(heading.scale(400)),
      ttl: 3.5,
      shooterId: playerShip.id,
    });
    missile.homing = new HomingBehavior({
      target: () => {
        let nearest = null;
        let best = Infinity;
        for (const a of world.ofKind(Kind.ASTEROID)) {
          const d = a.pos.sub(missile.pos).lengthSq();
          if (d < best) [best, nearest] = [d, a];
        }
        return nearest;
      },
      turnRate: 4.5,
    });
    world.spawn(missile);
    world.emit('fired', { shooterId: playerShip.id });
  }
  window.addEventListener('keydown', (e) => e.code === 'KeyH' && fireHomingMissile());

  function update(dt) {
    world.step(dt, arena, input.getState());
    let n = 0;
    for (const _ of world.ofKind(Kind.ASTEROID)) n++;
    if (n === 0) spawnWave(room.asteroids + 2);
  }

  function render(_alpha, metrics) {
    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, SIZE, SIZE);
    world.render(ctx, draw);
    hud.render([
      `${playerName} @ ${room.name} | FPS: ${metrics.fps} | UPS: ${metrics.stepsPerSecond}`,
      `Entities: ${world.size} | Score: ${world.score}`,
      `HP: ${playerShip.alive ? '♥'.repeat(playerShip.hp) : 'RESPAWNING...'} | Net: ${net.state.status} | Players: ${net.state.roster.map((p) => p.name).join(', ')}`,
      'W/Up thrust, A/D turn, Space fire, H homing',
    ]);
  }

  debug.phase = 'playing';
  debug.ship = playerShip;
  debug.input = input;
  createLoop({ update, render }).start();
}

async function boot() {
  const audio = createAudio();
  debug.audioState = () => audio.ctx.state;
  const { assets, failures, manifest } = await loadWithScreen(audio);
  for (const [name, buffer] of Object.entries(assets)) {
    if (name.startsWith('sound:')) audio.setBuffer(name.slice(6), buffer);
  }

  const note = failures.length ? `<br><small>${failures.length} optional asset(s) failed; using fallbacks</small>` : '';
  debug.phase = 'press-to-start';
  showOverlay(`<p>Assets loaded.${note}<br>Click or press any key to start</p>`);
  await waitForGesture();
  await audio.unlock();
  hideOverlay();

  const lobby = new Lobby();
  const view = mountLobbyView(document.getElementById('lobby'), lobby);
  debug.phase = 'lobby';
  view.show();
  const { room, playerName } = await new Promise((resolve) =>
    lobby.addEventListener('joined', (e) => resolve(e.detail), { once: true }),
  );
  view.hide();

  // Real server connection: join on every (re)connect, chat + roster over the socket.
  const conn = new Connection({ url: defaultWsUrl() });
  const state = mountChat(document.getElementById('chat'), conn);
  debug.conn = conn;
  debug.net = { state };
  conn.connect({ v: 1, type: 'join', room: room.id, name: playerName });
  startGame({ room, playerName, assets, manifest, audio, net: { conn, state } });
}

boot();
