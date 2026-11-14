import { useAccount, useConnect, useDisconnect, useSendTransaction } from '@starknet-react/core';
import { uint256 } from 'starknet';
import { KamuiWalletError } from '@kamui/sdk/starknet-react';
import { GAME, STRK, kamui } from './kamui';

/** A u256 amount as two felts: low, then high. */
const u256 = (value: bigint) => {
  const { low, high } = uint256.bnToUint256(value);
  return [low.toString(), high.toString()];
};

const approveSpender = [{ contractAddress: STRK, entrypoint: 'approve', calldata: [GAME, ...u256(15n * 10n ** 17n)] }];

/** What to tell the user when a call was refused before it was sent. */
function explain(error: Error): string {
  if (!(error instanceof KamuiWalletError)) return error.message;
  switch (error.code) {
    case 'OUT_OF_SCOPE':
      return 'This action needs your approval in Kamui.';
    case 'SESSION_EXHAUSTED':
    case 'SESSION_EXPIRED':
      return 'Your session has ended. Connect again.';
    default:
      return error.message;
  }
}

export function Game() {
  const { address, status } = useAccount();
  const { connect } = useConnect();
  const { disconnect } = useDisconnect();

  // Inside the session: no prompt, no fee for the user.
  const ping = useSendTransaction({ calls: [{ contractAddress: GAME, entrypoint: 'ping', calldata: [] }] });
  // Outside the session: refused with OUT_OF_SCOPE before anything is sent.
  const approve = useSendTransaction({ calls: approveSpender });

  if (status !== 'connected') {
    // Leaves the page. The session is picked up by useKamuiReconnect when the user is back.
    return <button onClick={() => connect({ connector: kamui })}>Connect with Kamui</button>;
  }

  return (
    <div>
      <p>Connected as {address}</p>
      <button onClick={() => disconnect()}>Disconnect</button>

      <button onClick={() => ping.send()} disabled={ping.isPending}>
        Ping
      </button>
      {ping.data && <p>Sent {ping.data.transaction_hash}</p>}
      {ping.error && <p role="alert">{explain(ping.error)}</p>}

      <button onClick={() => approve.send()}>Approve 1.5 STRK</button>
      {approve.error instanceof KamuiWalletError && approve.error.code === 'OUT_OF_SCOPE' && (
        // The user approves this one transaction in the keychain. Leaves the page.
        <button onClick={() => kamui.wallet.approveInKeychain(approveSpender, 'My game')}>Approve it in Kamui</button>
      )}
    </div>
  );
}
