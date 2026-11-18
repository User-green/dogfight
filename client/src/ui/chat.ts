import { query } from '../dom.ts';
import type { RosterEntry } from 'shared/protocol';
import type { Connection, Status } from '../net/connection.ts';

export interface ChatState {
  roster: RosterEntry[];
  status: Status;
}

/** Chat panel + roster. Listens to Connection events; sends via conn.send. */
export function mountChat(root: HTMLElement, conn: Connection): ChatState {
  root.innerHTML = '<div id="chat-log"></div><input id="chat-input" maxlength="200" placeholder="chat... (Enter)">';
  root.hidden = false;
  const log = query(root, '#chat-log');
  const input = query<HTMLInputElement>(root, '#chat-input');
  const state: ChatState = { roster: [], status: 'connecting' };

  const line = (text: string, cls = ''): void => {
    const div = document.createElement('div');
    div.textContent = text; // textContent, never innerHTML: chat text is untrusted
    div.className = cls;
    log.append(div);
    log.scrollTop = log.scrollHeight;
  };

  conn.on('chat', (m) => line(`${m.from}: ${m.text}`));
  conn.on('roster', (m) => (state.roster = m.players));
  conn.on('welcome', () => line('connected', 'sys'));
  conn.on('shutdown', () => line('server is restarting...', 'sys'));
  conn.on('status', (d) => {
    state.status = d.status;
    if (d.status === 'reconnecting') line(`connection lost, retrying (#${d.attempt})...`, 'sys');
    if (d.status === 'closed') line(`disconnected (${d.reason || d.code})`, 'sys');
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
