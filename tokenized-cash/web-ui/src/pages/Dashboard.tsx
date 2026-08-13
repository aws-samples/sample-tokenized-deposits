import { useTokenInfo, useFxRate, useInstructions, useBalance } from '../hooks';
import { Card } from '../components';
import { Link } from 'react-router-dom';

export const Dashboard = () => {
  const { data: token, isLoading: tokenLoading } = useTokenInfo();
  const { data: fxRate } = useFxRate();
  const { data: instructions } = useInstructions();
  const settings = JSON.parse(localStorage.getItem('tokenized-cash-settings') || '{}');
  const { data: caBalance } = useBalance(settings.caWallet);
  const { data: mxBalance } = useBalance(settings.mxWallet);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-800">Tokenized Deposits Pilot - Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <div className="text-3xl font-bold text-blue-600">
            {tokenLoading ? '...' : token ? parseFloat(token.totalSupply).toLocaleString() : '0'}
          </div>
          <div className="text-gray-500">{token?.symbol || 'tCAD'} Total Supply</div>
        </Card>
        <Card>
          <div className="text-3xl font-bold text-green-600">
            {fxRate ? fxRate.display : '---'}
          </div>
          <div className="text-gray-500">FX Rate (CAD to MXN)</div>
        </Card>
        <Card>
          <div className="text-3xl font-bold text-purple-600">70924</div>
          <div className="text-gray-500">Chain ID (Besu IBFT)</div>
        </Card>
        <Card>
          <div className="text-3xl font-bold text-amber-600">2</div>
          <div className="text-gray-500">Entities (CA / MX)</div>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card title="CA Wallet (Bank ABC Canada)">
          <div className="text-2xl font-bold text-emerald-600">
            {caBalance ? parseFloat(caBalance.balance).toLocaleString() : '0'} <span className="text-sm font-normal text-gray-500">tCAD</span>
          </div>
          <div className="text-xs text-gray-400 font-mono mt-1">{settings.caWallet ? `${settings.caWallet.slice(0, 10)}...${settings.caWallet.slice(-6)}` : '---'}</div>
        </Card>
        <Card title="MX Wallet (Bank ABC Mexico)">
          <div className="text-2xl font-bold text-orange-600">
            {mxBalance ? parseFloat(mxBalance.balance).toLocaleString() : '0'} <span className="text-sm font-normal text-gray-500">tCAD</span>
          </div>
          <div className="text-xs text-gray-400 font-mono mt-1">{settings.mxWallet ? `${settings.mxWallet.slice(0, 10)}...${settings.mxWallet.slice(-6)}` : '---'}</div>
        </Card>
      </div>

      <Card title="Settlement Lifecycle">
        <div className="flex items-center gap-2 text-sm flex-wrap">
          {['FUNDED', 'SUBMITTED', 'MINTED', 'TRANSFERRED', 'BURNED'].map((s, i, arr) => (
            <span key={s} className="flex items-center gap-1">
              <span className="px-2 py-1 bg-gray-100 rounded font-mono text-xs">{s}</span>
              {i < arr.length - 1 && <span className="text-gray-400">→</span>}
            </span>
          ))}
        </div>
        <p className="mt-3 text-gray-500 text-sm">
          Each instruction progresses through this lifecycle. The relayer submits to Besu,
          the watcher confirms on-chain execution, and stage handlers chain the next step.
        </p>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card title="Quick Actions">
          <div className="space-y-2">
            <Link to="/mint" className="block p-3 bg-emerald-50 rounded hover:bg-emerald-100 transition">
              <span className="font-medium text-emerald-800">Issue tCAD</span>
              <span className="text-emerald-600 text-sm block">Issue tokenized CAD (auto-transfers to MX)</span>
            </Link>
            <Link to="/redeem" className="block p-3 bg-orange-50 rounded hover:bg-orange-100 transition">
              <span className="font-medium text-orange-800">Redeem (Burn)</span>
              <span className="text-orange-600 text-sm block">Burn tokens from MX wallet with FX</span>
            </Link>
            <Link to="/fx" className="block p-3 bg-purple-50 rounded hover:bg-purple-100 transition">
              <span className="font-medium text-purple-800">Manage FX Rate</span>
              <span className="text-purple-600 text-sm block">Set CAD→MXN conversion rate</span>
            </Link>
            <Link to="/history" className="block p-3 bg-blue-50 rounded hover:bg-blue-100 transition">
              <span className="font-medium text-blue-800">Transaction History</span>
              <span className="text-blue-600 text-sm block">
                {instructions ? `${instructions.count} instructions` : 'View all settlements'}
              </span>
            </Link>
          </div>
        </Card>

        <Card title="Architecture">
          <ul className="text-sm text-gray-600 space-y-1">
            <li><strong>Network:</strong> Hyperledger Besu IBFT (4 validators)</li>
            <li><strong>Access:</strong> AWS PrivateLink only (no public)</li>
            <li><strong>Canonical Settlement Instruction (CSI) Signing:</strong> AWS KMS (secp256k1, EIP-712)</li>
            <li><strong>Relayer:</strong> VPC-attached Lambda (DDB Streams)</li>
            <li><strong>Watcher:</strong> VPC-attached Lambda (DDB Streams, polls executed())</li>
            <li><strong>FX:</strong> Live from Bank of Canada (CAD→MXN)</li>
            <li><strong>Audit:</strong> DynamoDB single-table (immutable trail)</li>
          </ul>
        </Card>
      </div>
    </div>
  );
};
