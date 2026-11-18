import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { log } from './logger.ts';
import type { RoomInfo, RosterEntry } from 'shared/protocol';

/** The least a Room needs from a socket. A real `ws` WebSocket satisfies it, and so does a 5-line fake in a test. */
export interface SocketLike {
  readonly OPEN: number;
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(payload: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

export interface Player {
  readonly id: string;
  readonly name: string;
  readonly socket: SocketLike;
}

/** What goes into the match log: a discriminated union, one member per event type. */
export type RoomEvent =
  | { t: number; type: 'join'; player: string; name: string }
  | { t: number; type: 'leave'; player: string }
  | { t: number; type: 'chat'; player: string; text: string };

/** event name -> the tuple of arguments its listeners receive. `emit('chat', 1)` is now a compile error. */
interface RoomEvents {
  join: [Player];
  leave: [Player];
  chat: [Player, string];
  empty: [Room];
  event: [RoomEvent];
  error: [Error];
}

export interface RoomOptions {
  id: string;
  name: string;
  asteroids?: number;
  maxPlayers?: number;
  persistent?: boolean;
}

export class Room extends EventEmitter<RoomEvents> {
  readonly players = new Map<string, Player>();
  readonly id: string;
  readonly name: string;
  readonly asteroids: number;
  readonly maxPlayers: number;
  readonly persistent: boolean; // seeded rooms are not deleted when empty
  readonly createdAt = Date.now();

  constructor({ id, name, asteroids = 4, maxPlayers = 8, persistent = false }: RoomOptions) {
    super();
    this.id = id;
    this.name = name;
    this.asteroids = asteroids;
    this.maxPlayers = maxPlayers;
    this.persistent = persistent;
    // An 'error' event with no listener THROWS and kills the process. Always have one.
    this.on('error', (err) => log.error({ event: 'room.error', roomId: id, err }));
  }

  get full(): boolean {
    return this.players.size >= this.maxPlayers;
  }

  roster(): RosterEntry[] {
    return [...this.players.values()].map((p) => ({ id: p.id, name: p.name }));
  }

  join(name: string, socket: SocketLike): Player {
    if (this.full) throw new Error('room-full');
    const player: Player = { id: randomUUID().slice(0, 8), name, socket };
    this.players.set(player.id, player);
    this.emit('join', player);
    this.emit('event', { t: Date.now(), type: 'join', player: player.id, name });
    return player;
  }

  leave(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player) return;
    this.players.delete(playerId);
    this.emit('leave', player);
    this.emit('event', { t: Date.now(), type: 'leave', player: playerId });
    if (this.players.size === 0) this.emit('empty', this);
  }

  chat(player: Player, text: string): void {
    this.emit('chat', player, text);
    this.emit('event', { t: Date.now(), type: 'chat', player: player.id, text });
  }

  toJSON(): RoomInfo {
    return { id: this.id, name: this.name, players: this.players.size, maxPlayers: this.maxPlayers, asteroids: this.asteroids };
  }
}

interface ManagerEvents {
  created: [Room];
  deleted: [Room];
  error: [Error];
}

export interface CreateOptions {
  id?: string;
  name: string;
  asteroids?: number;
  persistent?: boolean;
}

export class RoomManager extends EventEmitter<ManagerEvents> {
  readonly #rooms = new Map<string, Room>();
  readonly maxRooms: number;
  readonly maxPlayersPerRoom: number;

  constructor({ maxRooms, maxPlayersPerRoom }: { maxRooms: number; maxPlayersPerRoom: number }) {
    super();
    this.maxRooms = maxRooms;
    this.maxPlayersPerRoom = maxPlayersPerRoom;
    this.on('error', (err) => log.error({ event: 'roommanager.error', err }));
  }

  create({ id, name, asteroids, persistent = false }: CreateOptions): Room {
    if (this.#rooms.size >= this.maxRooms) throw new Error('too-many-rooms');
    const slug = id ?? `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 16) || 'room'}-${randomUUID().slice(0, 4)}`;
    if (this.#rooms.has(slug)) throw new Error('room-exists');
    const room = new Room({ id: slug, name, maxPlayers: this.maxPlayersPerRoom, persistent, ...(asteroids === undefined ? {} : { asteroids }) });
    // a room that empties is deleted (unless persistent)
    room.on('empty', () => {
      if (!room.persistent) this.delete(room.id);
    });
    this.#rooms.set(slug, room);
    this.emit('created', room);
    return room;
  }

  get(id: string): Room | undefined {
    return this.#rooms.get(id);
  }

  delete(id: string): void {
    const room = this.#rooms.get(id);
    if (!room) return;
    this.#rooms.delete(id);
    this.emit('deleted', room);
  }

  list(): Room[] {
    return [...this.#rooms.values()];
  }
}
