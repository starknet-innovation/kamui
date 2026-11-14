import type { ReactNode } from 'react';
import { sepolia } from '@starknet-react/chains';
import { StarknetConfig, jsonRpcProvider } from '@starknet-react/core';
import { useKamuiReconnect } from '@kamui/sdk/starknet-react';
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
    <StarknetConfig chains={[sepolia]} provider={jsonRpcProvider({ rpc: () => ({ nodeUrl: RPC_URL }) })} connectors={[kamui]}>
      <KamuiReconnect>{children}</KamuiReconnect>
    </StarknetConfig>
  );
}
