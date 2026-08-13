import { useState } from 'react';
import { useIsExecuted, useTokenInfo, useBalance, useBlockNumber } from '../hooks';
import { Card, Button, Input } from '../components';

export const OnChain = () => {
  const { data: token } = useTokenInfo();
  const { data: blockNumber } = useBlockNumber();
  const [instructionId, setInstructionId] = useState('');
  const [walletAddress, setWalletAddress] = useState('');

  const { data: executed, isLoading: execLoading } = useIsExecuted(instructionId);
  const { data: balance } = useBalance(walletAddress);

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-800">On-Chain State</h1>

      <div className="grid grid-cols-2 gap-4">
        <Card>
          <div className="text-2xl font-bold text-blue-600">{blockNumber?.toLocaleString() ?? '---'}</div>
          <div className="text-gray-500 text-sm">Current Block</div>
        </Card>
        <Card>
          <div className="text-2xl font-bold text-green-600">70924</div>
          <div className="text-gray-500 text-sm">Chain ID</div>
        </Card>
      </div>

      {token && (
        <Card title="Token Info (from Besu via API proxy)">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div><strong>Name:</strong> {token.name}</div>
            <div><strong>Symbol:</strong> {token.symbol}</div>
            <div><strong>Total Supply:</strong> {parseFloat(token.totalSupply).toLocaleString()}</div>
            <div><strong>Decimals:</strong> {token.decimals}</div>
          </div>
        </Card>
      )}

      <Card title="Check Execution Status">
        <div className="space-y-3">
          <Input
            label="Instruction ID (bytes32)"
            value={instructionId}
            onChange={e => setInstructionId(e.target.value)}
            placeholder="0x..."
          />
          {instructionId && instructionId.startsWith('0x') && (
            <div className="p-3 bg-gray-50 rounded">
              {execLoading ? (
                <span className="text-gray-500">Querying Besu...</span>
              ) : executed === true ? (
                <span className="text-green-700 font-medium">Executed on-chain</span>
              ) : executed === false ? (
                <span className="text-yellow-700 font-medium">Not yet executed</span>
              ) : null}
            </div>
          )}
        </div>
      </Card>

      <Card title="Check Wallet Balance">
        <div className="space-y-3">
          <Input
            label="Wallet Address"
            value={walletAddress}
            onChange={e => setWalletAddress(e.target.value)}
            placeholder="0x..."
          />
          {walletAddress && balance && (
            <div className="p-3 bg-gray-50 rounded">
              <span className="text-lg font-bold">{balance.balance}</span>
              <span className="text-gray-500 ml-2">{token?.symbol || 'tCAD'}</span>
            </div>
          )}
        </div>
      </Card>

      <Card title="How it works">
        <p className="text-sm text-gray-600">
          All on-chain reads go through the API Gateway → a VPC-attached Lambda → Besu PrivateLink.
          Your browser never connects to Besu directly.
        </p>
      </Card>
    </div>
  );
};
