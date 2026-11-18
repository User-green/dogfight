/** DOM rendering for the Lobby. Knows the Lobby's events; the Lobby knows nothing about the DOM. */
export function mountLobbyView(root, lobby) {
  root.innerHTML = `
    <h2>Lobby</h2>
    <label>Name <input id="lobby-name" value="Pilot" maxlength="16"></label>
    <ul id="lobby-rooms"></ul>
    <p id="lobby-status"></p>`;
  const list = root.querySelector('#lobby-rooms');
  const status = root.querySelector('#lobby-status');
  const nameInput = root.querySelector('#lobby-name');

  lobby.addEventListener('roomsChanged', (e) => {
    status.textContent = '';
    list.replaceChildren(
      ...e.detail.map((room) => {
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
  lobby.addEventListener('error', (e) => {
    status.textContent = `Cannot reach server (${e.detail.name}). Retrying...`;
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
