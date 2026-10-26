/**
 * Entry of the plugin's wp-admin screen: the BoostLoop site's own React app (`components/app.tsx`), built with the
 * WordPress host (`host.ts`). PHP prints `#boostloop-app` and `window.BoostLoopWP`.
 */
import { createRoot } from 'react-dom/client';
import BoostLoop from '../../../components/app';
import '../../../app/globals.css';

const mount = document.getElementById('boostloop-app');
if (mount) createRoot(mount).render(<BoostLoop />);
