import { useKamui } from './KamuiProvider';

export function ConnectButton() {
  const { status, connection, error, connect, disconnect } = useKamui();

  if (status === 'loading') return <p>Checking your session…</p>;
  if (status === 'connected' && connection) {
    return (
      <div>
        <p>Connected as {connection.account}</p>
        <p>Session ends {new Date(connection.session.validUntil * 1000).toLocaleString()}</p>
        <button onClick={disconnect}>Disconnect</button>
      </div>
    );
  }
  return (
    <div>
      <button onClick={connect}>Connect with Kamui</button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
