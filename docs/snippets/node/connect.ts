// Gets a Kamui session for a script or server, with one approval in the browser.
//
// The keychain only answers pages on the origin it redirects to, and http is allowed only for
// `localhost`. So this starts a small server on http://localhost:<port>:
//
//   /start     a page that sends the browser to the keychain (so the keychain sees where the
//              request came from: a bare redirect from a pasted URL carries no referrer)
//   /callback  where the keychain sends the user back; the page posts the answer to /answer
//
// The session key is generated here and never leaves this machine.
import { createServer } from 'node:http';
import type { ProviderInterface } from 'starknet';
import {
  beginConnect,
  finishConnect,
  forgetConnection,
  isConnectionAlive,
  loadConnection,
  type ConnectOptions,
  type Connection,
  type KeyValueStore,
} from '@kamui/sdk';

export type NodeConnectOptions = Omit<ConnectOptions, 'redirectUri'> & {
  provider: ProviderInterface;
  store: KeyValueStore;
  /** Local port for the approval round trip. */
  port?: number;
};

/** Returns the stored session if it is still live on chain, or asks the user for a new one. */
export async function connect(options: NodeConnectOptions): Promise<Connection> {
  const stored = loadConnection(options.store);
  if (stored && (await isConnectionAlive(stored, options.provider))) return stored;
  forgetConnection(options.store);
  return approveInBrowser(options);
}

function approveInBrowser({ provider: _provider, store, port = 8765, ...request }: NodeConnectOptions): Promise<Connection> {
  const origin = `http://localhost:${port}`;
  const html = (body: string) => `<!doctype html><meta charset="utf-8"><title>Kamui</title><body>${body}</body>`;

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const path = new URL(req.url ?? '/', origin).pathname;

      if (req.method === 'GET' && path === '/start') {
        const url = beginConnect({ ...request, redirectUri: `${origin}/callback` }, store);
        res.writeHead(200, { 'content-type': 'text/html', 'referrer-policy': 'strict-origin-when-cross-origin' });
        res.end(html(`<p>Opening Kamui…</p><script>location.assign(${JSON.stringify(url)})</script>`));
        return;
      }

      if (req.method === 'GET' && path === '/callback') {
        // The answer is in the URL fragment, which browsers never send to a server.
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(html(`<p id="m">Finishing…</p><script>
          fetch('/answer', { method: 'POST', body: location.hash }).then(r => r.text()).then(t => { m.textContent = t; history.replaceState(null, '', '/callback'); });
        </script>`));
        return;
      }

      if (req.method === 'POST' && path === '/answer') {
        let fragment = '';
        for await (const chunk of req) fragment += chunk;
        try {
          const connection = finishConnect(fragment, store);
          if (!connection) throw new Error('no answer from the keychain');
          res.end('Connected. You can close this tab.');
          server.close();
          resolve(connection);
        } catch (error) {
          res.end(`Not connected: ${(error as Error).message}`);
          server.close();
          reject(error);
        }
        return;
      }

      res.writeHead(404).end();
    });

    server.listen(port, 'localhost', () => {
      console.log(`Approve the session in your browser: ${origin}/start`);
    });
  });
}
