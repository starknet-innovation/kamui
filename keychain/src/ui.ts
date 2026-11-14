// Small DOM helpers. Everything a site or a token supplies is written with textContent, never as HTML.
import { statusLine, view } from './context';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function show(...nodes: Node[]) {
  view.replaceChildren(...nodes);
}

export const status = (text: string) => (statusLine.textContent = text);

/**
 * A button that disables every button on the page while its action runs. An action normally
 * ends by drawing another page or leaving this one. One that does neither (a declined
 * confirmation, a download) returns false, and the buttons work again.
 */
export function button(label: string, onClick: () => void | false | Promise<void | false>, primary = false): HTMLButtonElement {
  const node = el('button', label, primary ? 'primary' : '');
  node.onclick = async () => {
    for (const b of view.querySelectorAll('button')) b.disabled = true;
    try {
      if ((await onClick()) === false) {
        for (const b of view.querySelectorAll('button')) b.disabled = false;
      }
    } catch (error) {
      status('');
      view.append(el('p', (error as Error).message, 'error'));
      for (const b of view.querySelectorAll('button')) b.disabled = false;
    }
  };
  return node;
}

/**
 * Asks the user to confirm, inside the page. Not `window.confirm`: embedded browsers and webviews
 * often suppress native dialogs and answer "cancel" without showing anything, which made these
 * buttons do nothing there. Shown under the button that asked; resolves when one is chosen.
 */
export function ask(question: string, yes: string): Promise<boolean> {
  const asker = document.activeElement instanceof HTMLButtonElement && view.contains(document.activeElement) ? document.activeElement : null;
  const box = el('div', '', 'confirm');
  box.setAttribute('role', 'alertdialog');
  box.setAttribute('aria-label', 'Confirm');
  const text = el('p', question);
  text.id = 'confirm-question';
  box.setAttribute('aria-describedby', text.id);
  const accept = el('button', yes, 'primary');
  const cancel = el('button', 'Cancel');
  box.append(text, accept, cancel);
  if (asker) asker.after(box);
  else view.append(box);
  cancel.focus();
  return new Promise((resolve) => {
    const answer = (value: boolean) => {
      box.remove();
      resolve(value);
    };
    accept.onclick = () => answer(true);
    cancel.onclick = () => answer(false);
  });
}

export function table(headers: string[], rows: (string | Node)[][]): HTMLTableElement {
  const node = el('table');
  if (headers.length) {
    const head = el('tr');
    for (const header of headers) head.append(el('th', header));
    node.append(head);
  }
  for (const row of rows) {
    const tr = el('tr');
    for (const cell of row) {
      const td = el('td');
      td.append(typeof cell === 'string' ? document.createTextNode(cell) : cell);
      tr.append(td);
    }
    node.append(tr);
  }
  return node;
}

export const short = (felt: string) => (felt.length > 20 ? `${felt.slice(0, 10)}…${felt.slice(-6)}` : felt);
export const code = (text: string) => el('code', text);
export const sameFelt = (a: string, b: string) => BigInt(a) === BigInt(b);

/** Fails if `work` has not settled after `ms`. The work itself is not stopped. */
export function within<T>(ms: number, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    work.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (error) => (clearTimeout(timer), reject(error)),
    );
  });
}
