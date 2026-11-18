import { createLoop } from './loop.js';
import { createInput } from './input.js';
import { Ship } from 'shared/sim/ship';
import { TICK_DT } from 'shared/constants';
import { codecs } from 'shared/codec/index';
import { GameClient } from './net/gameclient.js';
import { mountNetgraph } from './ui/netgraph.js';
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

/** URL switches for the experiments in the write-up: ?predict=0&reconcile=0&interp=0&delay=100&codec=json&lag=100&jitter=30&drop=2&breakdet=1 */
const params = new URLSearchParams(location.search);
const flag = (name, dflt = true) => (params.has(name) ? params.get(name) !== '0' : dflt);

if (flag('breakdet', false)) {
  // Determinism experiment, client only: the browser's copy of the ship physics drifts, the server's does not.
  const original = Ship.prototype.update;
  Ship.prototype.update = function (dt, input, arena) {
    original.call(this, dt, input, arena);
    this.vel.x += (Math.random() - 0.5) * 20 * dt;
    this.vel.y += (Math.random() - 0.5) * 20 * dt;
  };
}

function startGame({ room, playerName, assets, manifest, audio, net }) {
  const arena = { width: assets.arena.width, height: assets.arena.height };
  const input = createInput();
  const bus = new EventTarget(); // what the old local World's bus was: HUD + audio subscribe, the netcode dispatches
  const draw = createSpriteDrawer(assets.sprites, manifest.sprites.frames);
  const hud = createHud(hudEl, bus);
  audio.attach(bus);

  let client = null;
  let lastScore = 0;
  let drawn = [];
  const conn = net.conn;

  // (Re)created on every welcome: after a reconnect the server gives us a NEW ship and a fresh tick counter.
  function onWelcome(w) {
    const codecName = w.codec in codecs ? w.codec : 'json';
    client = new GameClient({
      shipId: w.shipId,
      arena: w.arena ?? arena,
      codec: codecs[codecName],
      send: (payload) => conn.sendRaw(payload),
      config: {
        predict: flag('predict'),
        reconcile: flag('reconcile'),
        interpolate: flag('interp'),
        ...(params.has('delay') ? { interpDelayMs: Number(params.get('delay')) } : {}),
      },
    });
    client.addEventListener('fired', () => bus.dispatchEvent(new CustomEvent('fired')));
    debug.client = client;
    lastScore = 0;
  }
  if (net.welcome) onWelcome(net.welcome);
  conn.addEventListener('welcome', (e) => onWelcome(e.detail));

  const onSnap = (decoded) => {
    if (!client) return;
    client.onSnapshot(decoded, conn.lastBytes);
    const mine = decoded.ents.find((e) => e.id === client.shipId);
    if (mine && mine.score > lastScore) bus.dispatchEvent(new CustomEvent('scoreChanged', { detail: { score: mine.score, delta: mine.score - lastScore } }));
    if (mine) lastScore = mine.score;
  };
  conn.addEventListener('snapshot', (e) => client?.codec === codecs.json && Array.isArray(e.detail.ents) && onSnap(e.detail));
  conn.addEventListener('binary', (e) => client?.codec === codecs.binary && onSnap(codecs.binary.decodeSnapshot(e.detail)));
  conn.addEventListener('pong', (e) => client?.onPong(e.detail.t));
  setInterval(() => client && conn.send(client.pingPayload()), 1000);

  const netgraph = mountNetgraph(document.getElementById('netgraph'), () => client);

  function update() {
    client?.step(input.getState());
  }

  function render(alpha, metrics) {
    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, SIZE, SIZE);
    if (client) {
      drawn = client.frame(alpha);
      for (const e of drawn) if (e.alive) draw(ctx, e);
    }
    const ship = client?.localView;
    hud.render([
      `${playerName} @ ${room.name} | FPS: ${metrics.fps} | UPS: ${metrics.stepsPerSecond}`,
      `Entities: ${drawn.length} | Score: ${lastScore}`,
      `HP: ${ship?.alive ? '♥'.repeat(ship.hp) : 'RESPAWNING...'} | Net: ${conn.status} | Players: ${net.state.roster.map((p) => p.name).join(', ')}`,
      'W/Up thrust, A/D turn, Space fire, [ ] interp delay',
    ]);
    netgraph.render();
  }

  debug.phase = 'playing';
  debug.input = input;
  createLoop({ update, render, timestep: TICK_DT }).start();
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
  const conn = new Connection({
    url: defaultWsUrl({ lag: params.get('lag'), jitter: params.get('jitter'), drop: params.get('drop') }),
  });
  const state = mountChat(document.getElementById('chat'), conn);
  debug.conn = conn;
  debug.net = { state };
  conn.connect({ v: 1, type: 'join', room: room.id, name: playerName, codec: params.get('codec') === 'json' ? 'json' : 'binary' });
  startGame({ room, playerName, assets, manifest, audio, net: { conn, state, welcome: null } });

}

boot();
