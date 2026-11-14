import { useState } from 'react';
import { uint256 } from 'starknet';
import { useKamui } from './KamuiProvider';
import { GAME, STRK, provider } from './kamui';

/** A u256 amount as two felts: low, then high. */
const u256 = (value: bigint) => {
  const { low, high } = uint256.bnToUint256(value);
  return [low.toString(), high.toString()];
};

export function PlayButtons() {
  const { status, connection, send, execute, lastExecuted } = useKamui();
  const [log, setLog] = useState<string[]>([]);
  const note = (line: string) => setLog((lines) => [...lines, line]);
  if (status !== 'connected' || !connection) return null;

  // Inside the session: no prompt, no fee for the user.
  async function ping() {
    try {
      const hash = await send([{ contractAddress: GAME, entrypoint: 'ping', calldata: [] }]);
      note(`sent ${hash}`);
      await provider.waitForTransaction(hash);
      note('confirmed');
    } catch (error) {
      note(`failed: ${(error as Error).message}`);
    }
  }

  // Inside the session and its spending limit: 0.1 STRK to yourself.
  async function tip() {
    try {
      const hash = await send([{ contractAddress: STRK, entrypoint: 'transfer', calldata: [connection!.account, ...u256(10n ** 17n)] }]);
      note(`tip sent ${hash}`);
    } catch (error) {
      note(`failed: ${(error as Error).message}`);
    }
  }

  // Outside the session: the user approves this one transaction in the keychain.
  function approveSpender() {
    execute([{ contractAddress: STRK, entrypoint: 'approve', calldata: [GAME, ...u256(15n * 10n ** 17n)] }]);
  }

  return (
    <div>
      <button onClick={ping}>Ping</button>
      <button onClick={tip}>Tip 0.1 STRK</button>
      <button onClick={approveSpender}>Approve 1.5 STRK (asks in Kamui)</button>
      {lastExecuted && <p>Approved in Kamui: {lastExecuted}</p>}
      <pre>{log.join('\n')}</pre>
    </div>
  );
}
