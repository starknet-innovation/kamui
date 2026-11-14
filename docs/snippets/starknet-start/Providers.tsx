import type { ReactNode } from 'react';
import { sepolia } from '@starknetfoundation/starknet-start-chains';
import { jsonRpcProvider } from '@starknetfoundation/starknet-start-providers';
import { StarknetConfig } from '@starknetfoundation/starknet-start-react';
import { useKamuiReconnect } from '@kamui/sdk/starknet-start';
import { RPC_URL, kamui } from './kamui';

/**
 * Connecting leaves the page, so every Kamui connection is completed here, on the page load
 * that follows: this reads the keychain's answer and reconnects without a click.
 */
function KamuiReconnect({ children }: { children: ReactNode }) {
  const { isResuming, error, lastApproved } = useKamuiReconnect(kamui);
  if (isResuming) return <p>Checking your session…</p>;
  return (
    <>
      {error && <p role="alert">{error}</p>}
      {lastApproved && <p>Approved in Kamui: {lastApproved}</p>}
      {children}
    </>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    // extraWallets lists Kamui next to the extension wallets Starknet Start discovers.
    <StarknetConfig chains={[sepolia]} provider={jsonRpcProvider({ rpc: () => ({ nodeUrl: RPC_URL }) })} extraWallets={[kamui]}>
      <KamuiReconnect>{children}</KamuiReconnect>
    </StarknetConfig>
  );
}
