import { Terminal } from '../components/Terminal';

/**
 * Rendered entirely on the client. The agent box and this deployment are independent —
 * Vercel must be able to serve the terminal while the Ubuntu machine is rebooting, so
 * nothing here blocks on the API.
 */
export default function Page() {
  return <Terminal />;
}
