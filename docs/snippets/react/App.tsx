import { ConnectButton } from './ConnectButton';
import { KamuiProvider } from './KamuiProvider';
import { PlayButtons } from './PlayButtons';

export default function App() {
  return (
    <KamuiProvider>
      <h1>My game</h1>
      <ConnectButton />
      <PlayButtons />
    </KamuiProvider>
  );
}
