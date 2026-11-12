// The demo app: connect through the keychain, then send sponsored session calls.
// The session key lives in this app's sessionStorage, which is fine for a demo.
import { RpcProvider, type Call } from 'starknet';
import {
  beginConnect,
  finishConnect,
  forgetConnection,
  isConnectionAlive,
  loadConnection,
  sessionCall,
  sponsor,
  type Connection,
} from '../../sdk/src';

type Config = { keychainUrl: string; rpcUrl: string; target: string; sponsorUrl: string };

const $ = (id: string) => document.getElementById(id)!;
const config = (await (await fetch('/config.json')).json()) as Config;
const provider = new RpcProvider({ nodeUrl: config.rpcUrl });
const started = performance.now();
const log = (text: string) => {
  $('log').textContent += `${((performance.now() - started) / 1000).toFixed(1).padStart(6)}s  ${text}\n`;
};
function button(label: string, onClick: () => Promise<void> | void) {
  const node = document.createElement('button');
  node.textContent = label;
  node.onclick = async () => {
    node.disabled = true;
    try {
      await onClick();
    } catch (error) {
      log(`failed: ${(error as Error).message}`);
    }
    node.disabled = false;
  };
  $('actions').append(node);
}

const count = async () =>
  Number(BigInt((await provider.callContract({ contractAddress: config.target, entrypoint: 'count', calldata: [] }))[0]!));

function connect() {
  location.assign(
    beginConnect(
      {
        keychainUrl: config.keychainUrl,
        redirectUri: `${location.origin}/`,
        appName: 'Ping demo',
        validUntil: Math.floor(Date.now() / 1000) + 2 * 3600,
        maxCalls: 20,
        calls: [{ to: config.target, entrypoint: 'ping' }],
      },
      sessionStorage,
    ),
  );
}

/** Sends `calls` with the session key, paid for by the relayer. */
async function send(connection: Connection, calls: Call[], label: string) {
  const prepared = await sessionCall(connection, calls, provider);
  if (!prepared) throw new Error('the session has used all its calls');
  const start = performance.now();
  const transaction = await sponsor(config.sponsorUrl, prepared.call);
  log(`${label}: sent ${transaction}`);
  await provider.waitForTransaction(transaction);
  log(`${label}: confirmed after ${((performance.now() - start) / 1000).toFixed(1)} s`);
}

async function ready(connection: Connection) {
  $('who').textContent = `Connected as ${connection.account}`;
  $('actions').replaceChildren();
  if (!(await isConnectionAlive(connection, provider))) {
    log('the session no longer exists on the account (it ends when devices change, or when it expires)');
    forgetConnection(sessionStorage);
    button('Connect with Kamui', connect);
    return;
  }
  log(`session is live; the contract has counted ${await count()} pings`);
  button('Ping', async () => {
    await send(connection, [{ contractAddress: config.target, entrypoint: 'ping', calldata: [] }], 'ping');
    log(`the contract has now counted ${await count()} pings`);
  });
  button('Try a call the session was not given', async () => {
    // transfer() is not in the session's scope: the account must refuse it.
    await send(connection, [{ contractAddress: config.target, entrypoint: 'transfer', calldata: ['0x1', '0x1', '0x0'] }], 'out-of-scope call');
  });
  button('Disconnect', () => {
    forgetConnection(sessionStorage);
    location.assign('/');
  });
}

try {
  const fresh = finishConnect(location.hash, sessionStorage);
  if (fresh) {
    history.replaceState(null, '', '/');
    log('the keychain approved the session');
  }
  const connection = fresh ?? loadConnection(sessionStorage);
  if (connection) await ready(connection);
  else button('Connect with Kamui', connect);
} catch (error) {
  history.replaceState(null, '', '/');
  log(`not connected: ${(error as Error).message}`);
  button('Connect with Kamui', connect);
}
