<script lang="ts">
  import { uint256 } from 'starknet';
  import { GAME, STRK, kamui, provider } from './kamui.svelte';

  let log = $state<string[]>([]);
  const note = (line: string) => (log = [...log, line]);
  const u256 = (value: bigint) => {
    const { low, high } = uint256.bnToUint256(value);
    return [low.toString(), high.toString()];
  };

  // Inside the session: no prompt, no fee for the user.
  async function ping() {
    try {
      const hash = await kamui.send([{ contractAddress: GAME, entrypoint: 'ping', calldata: [] }]);
      note(`sent ${hash}`);
      await provider.waitForTransaction(hash);
      note('confirmed');
    } catch (error) {
      note(`failed: ${(error as Error).message}`);
    }
  }

  // Outside the session: the user approves it in the keychain.
  function approveSpender() {
    kamui.execute([{ contractAddress: STRK, entrypoint: 'approve', calldata: [GAME, ...u256(15n * 10n ** 17n)] }]);
  }
</script>

{#if kamui.connection}
  <button onclick={ping}>Ping</button>
  <button onclick={approveSpender}>Approve 1.5 STRK (asks in Kamui)</button>
  {#if kamui.lastExecuted}<p>Approved in Kamui: {kamui.lastExecuted}</p>{/if}
  <pre>{log.join('\n')}</pre>
{/if}
