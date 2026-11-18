/** Chat panel + roster. Listens to Connection events; sends via conn.send. */
export function mountChat(root, conn) {
  root.innerHTML = '<div id="chat-log"></div><input id="chat-input" maxlength="200" placeholder="chat... (Enter)">';
  root.hidden = false;
  const log = root.querySelector('#chat-log');
  const input = root.querySelector('#chat-input');
  const state = { roster: [], status: 'connecting' };

  const line = (text, cls = '') => {
    const div = document.createElement('div');
    div.textContent = text; // textContent, never innerHTML: chat text is untrusted
    div.className = cls;
    log.append(div);
    log.scrollTop = log.scrollHeight;
  };

  conn.addEventListener('chat', (e) => line(`${e.detail.from}: ${e.detail.text}`));
  conn.addEventListener('roster', (e) => (state.roster = e.detail.players));
  conn.addEventListener('welcome', () => line('connected', 'sys'));
  conn.addEventListener('shutdown', () => line('server is restarting...', 'sys'));
  conn.addEventListener('status', (e) => {
    state.status = e.detail.status;
    if (e.detail.status === 'reconnecting') line(`connection lost, retrying (#${e.detail.attempt})...`, 'sys');
    if (e.detail.status === 'closed') line(`disconnected (${e.detail.reason || e.detail.code})`, 'sys');
  });

  // Typing must not steer the ship: keep keystrokes inside the input.
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && input.value.trim()) {
      conn.send({ type: 'chat', text: input.value.trim() });
      input.value = '';
    }
  });
  input.addEventListener('keyup', (e) => e.stopPropagation());
  return state;
}
