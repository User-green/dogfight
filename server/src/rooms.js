import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export class Room extends EventEmitter {
  players = new Map(); // playerId -> { id, name, socket }

  constructor({ id, name, asteroids = 4, maxPlayers = 8, persistent = false }) {
    super();
    this.id = id;
    this.name = name;
    this.asteroids = asteroids;
    this.maxPlayers = maxPlayers;
    this.persistent = persistent; // seeded rooms are not deleted when empty
    this.createdAt = Date.now();
    // An 'error' event with no listener THROWS and kills the process. Always have one.
    this.on('error', (err) => console.error(`room ${id} error:`, err));
  }

  get full() {
    return this.players.size >= this.maxPlayers;
  }

  roster() {
    return [...this.players.values()].map((p) => ({ id: p.id, name: p.name }));
  }

  join(name, socket) {
    if (this.full) throw new Error('room-full');
    const player = { id: randomUUID().slice(0, 8), name, socket };
    this.players.set(player.id, player);
    this.emit('join', player);
    this.emit('event', { t: Date.now(), type: 'join', player: player.id, name });
    return player;
  }

  leave(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    this.players.delete(playerId);
    this.emit('leave', player);
    this.emit('event', { t: Date.now(), type: 'leave', player: playerId });
    if (this.players.size === 0) this.emit('empty', this);
  }

  chat(player, text) {
    this.emit('chat', player, text);
    this.emit('event', { t: Date.now(), type: 'chat', player: player.id, text });
  }

  toJSON() {
    return { id: this.id, name: this.name, players: this.players.size, maxPlayers: this.maxPlayers, asteroids: this.asteroids };
  }
}

export class RoomManager extends EventEmitter {
  #rooms = new Map();
  constructor({ maxRooms, maxPlayersPerRoom }) {
    super();
    this.maxRooms = maxRooms;
    this.maxPlayersPerRoom = maxPlayersPerRoom;
    this.on('error', (err) => console.error('room manager error:', err));
  }

  create({ id, name, asteroids, persistent = false }) {
    if (this.#rooms.size >= this.maxRooms) throw new Error('too-many-rooms');
    const slug = id ?? `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 16) || 'room'}-${randomUUID().slice(0, 4)}`;
    if (this.#rooms.has(slug)) throw new Error('room-exists');
    const room = new Room({ id: slug, name, asteroids, maxPlayers: this.maxPlayersPerRoom, persistent });
    // once('empty'): a room that empties is deleted (unless persistent)
    room.on('empty', () => {
      if (!room.persistent) this.delete(room.id);
    });
    this.#rooms.set(slug, room);
    this.emit('created', room);
    return room;
  }

  get(id) {
    return this.#rooms.get(id);
  }

  delete(id) {
    const room = this.#rooms.get(id);
    if (!room) return;
    this.#rooms.delete(id);
    this.emit('deleted', room);
  }

  list() {
    return [...this.#rooms.values()];
  }
}
