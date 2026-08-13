import { useState, useEffect } from 'react';
import { Card, Button, Input } from '../components';
import type { Settings as SettingsType } from '../types';

const STORAGE_KEY = 'tokenized-cash-settings';

const defaults: SettingsType = {
  apiKey: import.meta.env.VITE_API_KEY || '',
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL || '',
  rpcUrl: '',
  tokenAddress: import.meta.env.VITE_TOKEN_ADDRESS || '',
  settlementConsumerAddress: import.meta.env.VITE_SETTLEMENT_CONTRACT || '',
  caWallet: import.meta.env.VITE_CA_WALLET || '',
  mxWallet: import.meta.env.VITE_MX_WALLET || '',
};

export const Settings = () => {
  const [settings, setSettings] = useState<SettingsType>(defaults);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    // Merge env defaults with any stored settings (fills missing fields)
    const merged = stored ? { ...defaults, ...JSON.parse(stored) } : defaults;
    setSettings(merged);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  }, []);

  const handleSave = () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const update = (key: keyof SettingsType, value: string) => {
    setSettings(s => ({ ...s, [key]: value }));
    setSaved(false);
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-800">Settings</h1>

      <Card title="API Configuration">
        <div className="space-y-4">
          <Input label="API Base URL" value={settings.apiBaseUrl} onChange={e => update('apiBaseUrl', e.target.value)}
            placeholder="https://xxx.execute-api.us-east-1.amazonaws.com/v1" />
          <Input label="API Key" type="password" value={settings.apiKey} onChange={e => update('apiKey', e.target.value)}
            placeholder="Your API Gateway key" />
        </div>
        <p className="text-xs text-gray-400 mt-3">
          All on-chain reads are proxied through the API (VPC Lambda → Besu PrivateLink).
          No direct RPC connection from your browser is needed.
        </p>
      </Card>

      <div className="flex items-center gap-4">
        <Button onClick={handleSave}>Save Settings</Button>
        {saved && <span className="text-green-600 text-sm">Saved!</span>}
      </div>

      <Card title="Endpoints Available">
        <div className="text-sm text-gray-600 font-mono space-y-1">
          <div>POST /mint</div>
          <div>POST /redeem</div>
          <div>GET  /fx/rate</div>
          <div>POST /fx/rate</div>
          <div>POST /fx/convert</div>
          <div>GET  /chain/token</div>
          <div>GET  /chain/balance?address=0x...</div>
          <div>GET  /chain/executed?instructionId=0x...</div>
          <div>GET  /chain/block</div>
        </div>
      </Card>

      <Card title="Chain Info">
        <div className="text-sm text-gray-600 space-y-1">
          <div><strong>Chain ID:</strong> 70924</div>
          <div><strong>Consensus:</strong> IBFT 2.0 (2s block time)</div>
          <div><strong>Access:</strong> PrivateLink only (Lambda proxies reads)</div>
          <div><strong>Gas:</strong> Free (gasPrice: 0 on private chain)</div>
        </div>
      </Card>
    </div>
  );
};
