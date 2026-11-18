import { query } from '../dom.ts';
import type { Lobby } from '../lobby.ts';

/** DOM rendering for the Lobby. Knows the Lobby's events; the Lobby knows nothing about the DOM. */
export function mountLobbyView(root: HTMLElement, lobby: Lobby): { show(): void; hide(): void } {
  root.innerHTML = `
    <h2>Lobby</h2>
    <label>Name <input id="lobby-name" value="Pilot" maxlength="16"></label>
    <ul id="lobby-rooms"></ul>
    <p id="lobby-status"></p>`;
  const list = query(root, '#lobby-rooms');
  const status = query(root, '#lobby-status');
  const nameInput = query<HTMLInputElement>(root, '#lobby-name');

  lobby.on('roomsChanged', (rooms) => {
    status.textContent = '';
    list.replaceChildren(
      ...rooms.map((room) => {
        const li = document.createElement('li');
        li.textContent = `${room.name} - ${room.players} players `;
        const btn = document.createElement('button');
        btn.textContent = 'Join';
        btn.dataset.room = room.id;
        btn.addEventListener('click', () => lobby.join(room.id, nameInput.value.trim() || 'Pilot'));
        li.append(btn);
        return li;
      }),
    );
  });
  lobby.on('error', (err) => {
    status.textContent = `Cannot reach server (${err.name}). Retrying...`;
  });

  return {
    show() {
      root.hidden = false;
      lobby.startPolling();
    },
    hide() {
      root.hidden = true;
      lobby.stopPolling();
    },
  };
}
