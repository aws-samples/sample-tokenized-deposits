import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMint, useTokenInfo, useBalance, useInstruction } from '../hooks';
import { Card, Button, Input } from '../components';
import { parseUnits } from 'viem';

export const Mint = () => {
  const { data: token } = useTokenInfo();
  const mintMutation = useMint();

  const settings = JSON.parse(localStorage.getItem('tokenized-cash-settings') || '{}');

  const [amount, setAmount] = useState('100');
  const [toParty, setToParty] = useState(settings.caWallet || '');
  const [reference, setReference] = useState('');
  const [result, setResult] = useState<{ instructionId: string; signer: string } | null>(null);
  const { data: balance } = useBalance(toParty);

  const handleMint = async () => {
    const weiAmount = parseUnits(amount, 18).toString();
    const res = await mintMutation.mutateAsync({
      asset: settings.tokenAddress,
      amount: weiAmount,
      toParty,
      reference: reference || undefined,
      entity: 'CA',
    });
    setResult(res);
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-800">Issue Tokenized CAD</h1>

      <Card>
        <div className="flex items-center gap-3 text-sm text-gray-600 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-blue-400"></span>
            <span>CAD locked (off-chain)</span>
          </div>
          <span className="text-gray-300">→</span>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-emerald-400"></span>
            <span>tCAD minted to CA</span>
          </div>
          <span className="text-gray-300">→</span>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-orange-400"></span>
            <span>Auto-transferred to MX</span>
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-2">
          Once mint confirms on-chain (~2s), the system automatically creates a transfer instruction
          that moves tCAD from CA wallet to MX wallet. No manual intervention required.
        </p>
      </Card>

      <Card title="Mint Parameters">
        <div className="space-y-4">
          <Input label="Amount (tCAD)" type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="100" />

          {amount && parseFloat(amount) > 0 && (
            <div className="p-4 bg-blue-50 border border-blue-200 rounded">
              <div className="text-sm text-blue-800">
                <strong>Collateral requirement:</strong>
              </div>
              <div className="text-2xl font-bold text-blue-700 mt-1">
                {parseFloat(amount).toLocaleString()} CAD
              </div>
              <div className="text-xs text-blue-600 mt-1">
                Locked in CA collateral account before mint authorization
              </div>
            </div>
          )}

          <Input label="Issuer Wallet (CA — receives minted tCAD)" value={toParty} onChange={e => setToParty(e.target.value)} placeholder="0x..." disabled />
          <p className="text-xs text-gray-400">
            Fixed to CA wallet for this corridor. In production, this would support multiple issuing entities and recipient corridors.
          </p>
          <Input label="Reference (optional)" value={reference} onChange={e => setReference(e.target.value)} placeholder="SWIFT-REF-001" />

          {balance && (
            <div className="text-sm text-gray-500">Current balance: {balance.balance} {token?.symbol || 'tCAD'}</div>
          )}

          <Button onClick={handleMint} disabled={!amount || !toParty || mintMutation.isPending}>
            {mintMutation.isPending ? 'Signing & Creating...' : 'Issue tCAD'}
          </Button>

          {mintMutation.isError && (
            <div className="p-3 bg-red-50 text-red-700 rounded text-sm">{(mintMutation.error as Error).message}</div>
          )}
        </div>
      </Card>

      {result && <InstructionProgress instructionId={result.instructionId} signer={result.signer} amount={amount} />}
    </div>
  );
};

const STATUS_COLORS: Record<string, string> = {
  FUNDED: 'bg-yellow-100 text-yellow-800',
  SUBMITTED: 'bg-blue-100 text-blue-800',
  MINTED: 'bg-green-100 text-green-800',
  FAILED: 'bg-red-100 text-red-800',
};

const STEPS = ['FUNDED', 'SUBMITTED', 'MINTED'];

const InstructionProgress = ({ instructionId, signer, amount }: { instructionId: string; signer: string; amount: string }) => {
  const { data: detail } = useInstruction(instructionId);
  const currentStatus = detail?.status || 'FUNDED';
  const currentIdx = STEPS.indexOf(currentStatus);

  return (
    <Card title="Settlement Progress">
      <div className="space-y-4 text-sm">
        <div className="flex items-center gap-1">
          {STEPS.map((step, i) => (
            <span key={step} className="flex items-center gap-1">
              <span className={`px-2 py-1 rounded text-xs font-medium ${
                i <= currentIdx ? STATUS_COLORS[step] : 'bg-gray-100 text-gray-400'
              }`}>
                {step}
              </span>
              {i < STEPS.length - 1 && (
                <span className={i < currentIdx ? 'text-green-500' : 'text-gray-300'}>→</span>
              )}
            </span>
          ))}
        </div>

        {detail?.collateral && (
          <div className={`p-3 rounded border ${
            detail.collateral.status === 'LOCKED'
              ? 'bg-blue-50 border-blue-200 text-blue-800'
              : detail.collateral.status === 'RELEASED'
              ? 'bg-green-50 border-green-200 text-green-800'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}>
            <div className="flex items-center justify-between">
              <span className="font-medium">
                {detail.collateral.status === 'LOCKED' ? '🔒 CAD Collateral Locked' : '🔓 CAD Collateral Released'}
              </span>
              <span className="font-mono text-xs">{detail.collateral.accountRef}</span>
            </div>
            <div className="text-xs mt-1">
              {detail.collateral.status === 'LOCKED'
                ? 'Real CAD held in segregated account until token is burned'
                : 'Collateral released — token has been destroyed on-chain'}
            </div>
          </div>
        )}

        {currentStatus === 'FUNDED' && (
          <div className="p-3 bg-yellow-50 border border-yellow-200 rounded text-yellow-800">
            CAD collateral locked. Waiting for relayer to submit to Besu...
          </div>
        )}
        {currentStatus === 'SUBMITTED' && (
          <div className="p-3 bg-blue-50 border border-blue-200 rounded text-blue-800">
            Transaction submitted to Besu. Waiting for on-chain confirmation (~2s)...
          </div>
        )}
        {currentStatus === 'MINTED' && (
          <div className="p-3 bg-green-50 border border-green-200 rounded text-green-800">
            <div className="font-medium">Complete — {amount} tCAD minted on-chain</div>
            <div className="mt-1 text-sm">Auto-transfer to MX wallet will follow automatically. Check History for full trail.</div>
          </div>
        )}
        {currentStatus === 'FAILED' && (
          <div className="p-3 bg-red-50 border border-red-200 rounded text-red-800">
            Transaction failed. Check History for details.
          </div>
        )}

        <div className="text-xs text-gray-500 space-y-1">
          <div><strong>Instruction ID:</strong> <code className="break-all">{instructionId}</code></div>
          <div><strong>Signer:</strong> <code>{signer}</code></div>
          {detail?.txHash && <div><strong>Tx Hash:</strong> <code className="break-all">{detail.txHash}</code></div>}
        </div>

        <Link to="/history" className="inline-block text-blue-600 hover:text-blue-800 text-sm font-medium">
          View full audit trail →
        </Link>
      </div>
    </Card>
  );
};
