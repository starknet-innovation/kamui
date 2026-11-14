// The page of the test app in popup.spec.ts, bundled for the browser by that file. In the popup
// it relays the keychain's answer and stops; in the app's own tab it offers the SDK's popup
// calls to the test.
import { connectWithPopup, executeWithPopup, relayPopupResult } from '../../sdk/src';

if (!relayPopupResult()) Object.assign(window, { kamui: { connectWithPopup, executeWithPopup } });
