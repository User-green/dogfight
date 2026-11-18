import { createLoop } from './loop.ts';
import type { LoopMetrics } from './loop.ts';
import { Kind } from 'shared/sim/entity';
import { createInput } from './input.ts';
import { Ship } from 'shared/sim/ship';
import { TICK_DT } from 'shared/constants';
import { codecs } from 'shared/codec/index';
import { GameClient } from './net/gameclient.ts';
import { mountNetgraph } from './ui/netgraph.ts';
import { fetchJson, withRetry, loadAll } from './assets/loader.ts';
import { createAudio } from './assets/audio.ts';
import { createSpriteDrawer } from './assets/sprites.ts';
import { Lobby } from './lobby.ts';
import { mountLobbyView } from './ui/lobbyView.ts';
import { createHud } from './ui/hud.ts';
import { drawLoading } from './ui/loadingScreen.ts';
import { Connection, defaultWsUrl } from './net/connection.ts';
import { mountChat } from './ui/chat.ts';
import type { ChatState } from './ui/chat.ts';
import { query } from './dom.ts';
import { TypedTarget } from './typed-target.ts';
import type { Bus, GameEvents } from './events.ts';
import { ArenaConfigSchema, ManifestSchema } from './assets/manifest.ts';
import type { Manifest } from './assets/manifest.ts';
import type { Audio } from './assets/audio.ts';
import type { RoomInfo, Snapshot, Welcome } from 'shared/protocol';
import { getCodec } from 'shared/codec/index';

const SIZE = 1000; // logical arena units; canvas is scaled to this
const canvas = query<HTMLCanvasElement>(document, '#scene');
const hudEl = query(document, '#hud');
const overlay = query(document, '#overlay');
const ctx: CanvasRenderingContext2D = (() => {
  const c = canvas.getContext('2d');
  if (!c) throw new Error('2d canvas context unavailable');
  return c;
})();

/** Test hook: lets the end-to-end test observe the phase without scraping pixels. */
interface DebugHook {
  phase: string;
  failures: { name: string; url: string; error: string }[];
  progress: number;
  error: string | null;
  audioState?: () => AudioContextState;
  client?: GameClient;
  input?: ReturnType<typeof createInput>;
  conn?: Connection;
  net?: { state: ChatState };
}
declare global {
  interface Window {
    __lab3: DebugHook;
  }
}
const debug: DebugHook = (window.__lab3 = { phase: 'boot', failures: [], progress: 0, error: null });

function resizeCanvas(): void {
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
function applyChaos(manifest: Manifest): Manifest {
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

function showOverlay(html: string): void {
  overlay.innerHTML = html;
  overlay.hidden = false;
}
const hideOverlay = () => (overlay.hidden = true);

const waitForClick = (button: HTMLElement): Promise<void> => new Promise((r) => button.addEventListener('click', () => r(), { once: true }));

/** Resolves on the first click or key press: the user gesture the AudioContext needs. */
function waitForGesture(): Promise<void> {
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
async function loadWithScreen(audio: Audio) {
  for (;;) {
    debug.phase = 'loading';
    try {
      const manifest = applyChaos(ManifestSchema.parse(await withRetry((s) => fetchJson('/assets/manifest.json', { signal: s }))));
      const result = await loadAll(manifest, {
        audioCtx: audio.ctx,
        onProgress: (p, _total, name) => {
          debug.progress = p;
          drawLoading(ctx, SIZE, p, name ? `loaded ${name}` : 'starting...');
        },
      });
      debug.failures = result.failures.map((f) => ({ name: f.name, url: f.url, error: f.error instanceof Error ? f.error.message : String(f.error) }));
      return { ...result, manifest };
    } catch (err) {
      debug.phase = 'load-error';
      const e = err instanceof Error ? err : new Error(String(err));
      debug.error = `${e.name}: ${e.message}`;
      drawLoading(ctx, SIZE, debug.progress, 'FAILED');
      showOverlay(`<p>Could not load game assets:<br>${e.message}</p><button id="retry">Retry</button>`);
      await waitForClick(query(document, '#retry'));
      hideOverlay();
    }
  }
}

/** URL switches for the experiments in the write-up: ?predict=0&reconcile=0&interp=0&delay=100&codec=json&lag=100&jitter=30&drop=2&breakdet=1 */
const params = new URLSearchParams(location.search);
const flag = (name: string, dflt = true): boolean => (params.has(name) ? params.get(name) !== '0' : dflt);

if (flag('breakdet', false)) {
  // Determinism experiment, client only: the browser's copy of the ship physics drifts, the server's does not.
  const original = Ship.prototype.step;
  Ship.prototype.step = function (this: Ship, dt, input, arena) {
    original.call(this, dt, input, arena);
    this.vel.x += (Math.random() - 0.5) * 20 * dt;
    this.vel.y += (Math.random() - 0.5) * 20 * dt;
  };
}

interface GameStart {
  room: RoomInfo;
  playerName: string;
  assets: Record<string, unknown>;
  manifest: Manifest;
  audio: Audio;
  net: { conn: Connection; state: ChatState; welcome: Welcome | null };
}

function startGame({ room, playerName, assets, manifest, audio, net }: GameStart): void {
  const _arena = ArenaConfigSchema.parse(assets.arena); // the loader hands back `unknown`: validate where it is used
  const sheet = assets.sprites instanceof HTMLImageElement ? assets.sprites : null; // null => vector fallback
  const input = createInput();
  const bus: Bus = new TypedTarget<GameEvents>(); // what the old local World's bus was: HUD + audio subscribe, the netcode dispatches
  const draw = createSpriteDrawer(sheet, manifest.sprites.frames);
  const hud = createHud(hudEl, bus);
  audio.attach(bus);

  let client: GameClient | null = null;
  let lastScore = 0;
  let drawn: ReturnType<GameClient['frame']> = [];
  const conn = net.conn;

  // (Re)created on every welcome: after a reconnect the server gives us a NEW ship and a fresh tick counter.
  function onWelcome(w: Welcome): void {
    const c = (client = new GameClient({
      shipId: w.shipId,
      arena: w.arena,
      codec: getCodec(w.codec) ?? codecs.json,
      send: (payload) => conn.sendRaw(payload),
      config: {
        predict: flag('predict'),
        reconcile: flag('reconcile'),
        interpolate: flag('interp'),
        ...(params.has('delay') ? { interpDelayMs: Number(params.get('delay')) } : {}),
      },
    }));
    c.on('fired', () => bus.emit('fired', undefined));
    debug.client = c;
    lastScore = 0;
  }
  if (net.welcome) onWelcome(net.welcome);
  conn.on('welcome', onWelcome);

  const onSnap = (decoded: Snapshot): void => {
    if (!client) return;
    client.onSnapshot(decoded, conn.lastBytes);
    const mine = decoded.ents.find((e) => e.id === client?.shipId);
    if (mine?.kind !== Kind.SHIP) return;
    if (mine.score > lastScore) bus.emit('scoreChanged', { score: mine.score, delta: mine.score - lastScore });
    lastScore = mine.score;
  };
  conn.on('snapshot', (m) => client?.codec === codecs.json && onSnap(m)); // already validated by the connection's zod parse
  conn.on('binary', (data) => {
    if (client?.codec !== codecs.binary) return;
    try {
      onSnap(codecs.binary.decodeSnapshot(data));
    } catch {
      // a malformed binary frame: drop it, the next snapshot supersedes it
    }
  });
  conn.on('pong', (m) => client?.onPong(m.t));
  setInterval(() => client && conn.send(client.pingPayload()), 1000);

  const netgraph = mountNetgraph(query(document, '#netgraph'), () => client);

  function update(): void {
    client?.step(input.getState());
  }

  function render(alpha: number, metrics: LoopMetrics): void {
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

async function boot(): Promise<void> {
  const audio = createAudio();
  debug.audioState = () => audio.ctx.state;
  const { assets, failures, manifest } = await loadWithScreen(audio);
  for (const [name, buffer] of Object.entries(assets)) {
    if (name.startsWith('sound:') && buffer instanceof AudioBuffer) audio.setBuffer(name.slice(6), buffer);
  }

  const note = failures.length ? `<br><small>${failures.length} optional asset(s) failed; using fallbacks</small>` : '';
  debug.phase = 'press-to-start';
  showOverlay(`<p>Assets loaded.${note}<br>Click or press any key to start</p>`);
  await waitForGesture();
  await audio.unlock();
  hideOverlay();

  const lobby = new Lobby();
  const view = mountLobbyView(query(document, '#lobby'), lobby);
  debug.phase = 'lobby';
  view.show();
  const { room, playerName } = await new Promise<{ room: RoomInfo; playerName: string }>((resolve) =>
    lobby.on('joined', resolve, { once: true }),
  );
  view.hide();

  // Real server connection: join on every (re)connect, chat + roster over the socket.
  const conn = new Connection({
    url: defaultWsUrl({ lag: params.get('lag'), jitter: params.get('jitter'), drop: params.get('drop') }),
  });
  const state = mountChat(query(document, '#chat'), conn);
  debug.conn = conn;
  debug.net = { state };
  conn.connect({ v: 1, type: 'join', room: room.id, name: playerName, codec: params.get('codec') === 'json' ? 'json' : 'binary' });
  startGame({ room, playerName, assets, manifest, audio, net: { conn, state, welcome: null } });

}

void boot();

// Version stamp (git SHA baked into the image) so you can see which build is live.
void fetch('/health')
  .then((r) => r.json())
  .then((h: { version?: string }) => {
    const tag = document.createElement('div');
    tag.textContent = `build ${h.version ?? '?'}`;
    tag.style.cssText = 'position:fixed;right:6px;bottom:4px;font:10px monospace;color:#888;pointer-events:none;z-index:10';
    document.body.append(tag);
  })
  .catch(() => {});

// PWA: the service worker makes the app installable; skipped on localhost unless ?sw=1 so dev and e2e stay uncached.
if ('serviceWorker' in navigator && (location.hostname !== 'localhost' || new URLSearchParams(location.search).has('sw'))) {
  void navigator.serviceWorker.register('/sw.js').catch(() => {});
}
