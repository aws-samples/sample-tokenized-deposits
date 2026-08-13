import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// Ensure settings are populated with env defaults before any component reads them.
// Env vars always win over stored values (handles redeployment with new addresses).
const STORAGE_KEY = 'tokenized-cash-settings';
const envDefaults: Record<string, string> = {
  apiKey: import.meta.env.VITE_API_KEY || '',
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL || '',
  tokenAddress: import.meta.env.VITE_TOKEN_ADDRESS || '',
  settlementConsumerAddress: import.meta.env.VITE_SETTLEMENT_CONTRACT || '',
  caWallet: import.meta.env.VITE_CA_WALLET || '',
  mxWallet: import.meta.env.VITE_MX_WALLET || '',
};
const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
// Env vars override stored values (except empty env vars keep stored value)
const merged = { ...stored, rpcUrl: stored.rpcUrl || '' };
for (const [key, val] of Object.entries(envDefaults)) {
  if (val) merged[key] = val;
  else if (!(key in merged)) merged[key] = '';
}
localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
