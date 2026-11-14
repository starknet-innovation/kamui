// The demo app: connect through the keychain, then send sponsored session calls.
// The session key lives in this app's sessionStorage, which is fine for a demo.
import { RpcProvider, uint256, type Call } from 'starknet';
import {
  beginConnect,
  beginExecute,
  finishConnect,
  finishExecute,
  isReferrerMissing,
  forgetConnection,
  isConnectionAlive,
  loadConnection,
  pendingRequestKind,
  sessionCall,
  sponsor,
  type Connection,
} from '../../sdk/src';

/** A u256 as calldata: low half, then high half. */
const amount = (value: bigint) => {
  const { low, high } = uint256.bnToUint256(value);
  return [low, high].map((part) => '0x' + BigInt(part).toString(16));
};

/** STRK on Sepolia. */
const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

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
  button('Send a one-off call (asks you in Kamui)', () => {
    // transfer() is outside the session, so the user approves this one transaction in the keychain.
    location.assign(
      beginExecute(
        {
          keychainUrl: config.keychainUrl,
          redirectUri: `${location.origin}/`,
          appName: 'Ping demo',
          calls: [{ contractAddress: config.target, entrypoint: 'transfer', calldata: ['0x1', '0x1', '0x0'] }],
        },
        sessionStorage,
      ),
    );
  });
  button('Approve 1.5 STRK to the test contract (asks you in Kamui)', () => {
    // A real token, so the keychain can name it and show the exact amount. An approval needs no
    // balance, and the test contract never spends it.
    location.assign(
      beginExecute(
        {
          keychainUrl: config.keychainUrl,
          redirectUri: `${location.origin}/`,
          appName: 'Ping demo',
          calls: [{ contractAddress: STRK, entrypoint: 'approve', calldata: [config.target, ...amount(1_500_000_000_000_000_000n)] }],
        },
        sessionStorage,
      ),
    );
  });
  button('Disconnect', () => {
    forgetConnection(sessionStorage);
    location.assign('/');
  });
}

try {
  // The keychain answers in the URL fragment. Which request it answers was noted before leaving.
  let fresh: Connection | null = null;
  if (pendingRequestKind(sessionStorage) === 'execute') {
    // A declined or failed one-off call says nothing about the session: keep the connection.
    try {
      const sent = finishExecute(location.hash, sessionStorage);
      if (sent) log(`you approved the one-off call in Kamui: ${sent.transactionHash}`);
    } catch (error) {
      log(`one-off call not sent: ${(error as Error).message}`);
    }
    history.replaceState(null, '', '/');
  } else {
    fresh = finishConnect(location.hash, sessionStorage);
    if (fresh) {
      history.replaceState(null, '', '/');
      log('the keychain approved the session');
    }
  }
  const connection = fresh ?? loadConnection(sessionStorage);
  if (connection) await ready(connection);
  else button('Connect with Kamui', connect);
} catch (error) {
  history.replaceState(null, '', '/');
  if (isReferrerMissing(error)) log('not connected: your browser or an extension hides which site you come from, so Kamui refused the request. Allow referrers for this site and try again.');
  else log(`not connected: ${(error as Error).message}`);
  button('Connect with Kamui', connect);
}
