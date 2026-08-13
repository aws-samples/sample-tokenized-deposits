import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useRedeem, useInstruction, useBalance } from '../hooks';
import { Card, Button, Input } from '../components';
import { parseUnits } from 'viem';
import { api } from '../api';

export const Redeem = () => {
  const redeemMutation = useRedeem();

  const settings = JSON.parse(localStorage.getItem('tokenized-cash-settings') || '{}');

  const [amount, setAmount] = useState('100');
  const [fromParty, setFromParty] = useState(settings.mxWallet || '');
  const [reference, setReference] = useState('');
  const [result, setResult] = useState<{ instructionId: string; signer: string } | null>(null);
  const [converted, setConverted] = useState<{ mxnAmount: string; rate: number } | null>(null);

  useEffect(() => {
    if (!amount || parseFloat(amount) <= 0) { setConverted(null); return; }
    let stale = false;
    api.convertFx(amount).then(res => { if (!stale) setConverted(res); }).catch(() => { if (!stale) setConverted(null); });
    return () => { stale = true; };
  }, [amount]);

  const handleRedeem = async () => {
    const weiAmount = parseUnits(amount, 18).toString();
    const res = await redeemMutation.mutateAsync({
      asset: settings.tokenAddress,
      amount: weiAmount,
      fromParty,
      toParty: fromParty,
      reference: reference || undefined,
    });
    setResult(res);
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-800">Redeem (Burn → MXN Payout)</h1>

      <Card>
        <div className="flex items-center gap-4 text-sm text-gray-600">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-orange-400"></span>
            <span>tCAD burned on-chain (cryptographic proof)</span>
          </div>
          <span className="text-gray-300">→</span>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-green-400"></span>
            <span>MXN disbursed off-chain (banking rails)</span>
          </div>
        </div>
      </Card>

      <Card title="Redeem Parameters">
        <div className="space-y-4">
          <Input label="Amount (tCAD to burn)" type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="100" />
          <Input label="Burn From (MX wallet holding tCAD)" value={fromParty} onChange={e => setFromParty(e.target.value)} placeholder="0x..." disabled />

          <MxBalanceDisplay wallet={fromParty} />
          <Input label="Reference (optional)" value={reference} onChange={e => setReference(e.target.value)} placeholder="REDEEM-REF-001" />

          {converted && (
            <div className="p-4 bg-green-50 border border-green-200 rounded">
              <div className="text-sm text-green-800">
                <strong>MX will receive:</strong>
              </div>
              <div className="text-2xl font-bold text-green-700 mt-1">
                {(parseFloat(amount) * converted.rate / 1000).toFixed(3)} MXN
              </div>
              <div className="text-xs text-green-600 mt-1">
                {amount} tCAD × {(converted.rate / 1000).toFixed(3)} (Bank of Canada rate)
              </div>
            </div>
          )}

          <Button onClick={handleRedeem} disabled={!amount || !fromParty || redeemMutation.isPending}>
            {redeemMutation.isPending ? 'Signing...' : 'Redeem & Burn'}
          </Button>

          {redeemMutation.isError && (
            <div className="p-3 bg-red-50 text-red-700 rounded text-sm">{(redeemMutation.error as Error).message}</div>
          )}
        </div>
      </Card>

      {result && <RedeemProgress instructionId={result.instructionId} signer={result.signer} mxnAmount={converted ? (parseFloat(amount) * converted.rate / 1000).toFixed(3) : undefined} />}
    </div>
  );
};

const STATUS_COLORS: Record<string, string> = {
  FUNDED: 'bg-yellow-100 text-yellow-800',
  SUBMITTED: 'bg-blue-100 text-blue-800',
  BURNED: 'bg-orange-100 text-orange-800',
  FAILED: 'bg-red-100 text-red-800',
};

const STEPS = ['FUNDED', 'SUBMITTED', 'BURNED'];

const RedeemProgress = ({ instructionId, signer, mxnAmount }: { instructionId: string; signer: string; mxnAmount?: string }) => {
  const { data: detail } = useInstruction(instructionId);
  const currentStatus = detail?.status || 'FUNDED';
  const currentIdx = STEPS.indexOf(currentStatus);

  return (
    <Card title="Redemption Progress">
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

        {currentStatus === 'FUNDED' && (
          <div className="p-3 bg-yellow-50 border border-yellow-200 rounded text-yellow-800">
            Burn instruction signed. Waiting for relayer to submit to Besu...
          </div>
        )}
        {currentStatus === 'SUBMITTED' && (
          <div className="p-3 bg-blue-50 border border-blue-200 rounded text-blue-800">
            Burn transaction submitted. Waiting for on-chain confirmation (~2s)...
          </div>
        )}
        {currentStatus === 'BURNED' && (
          <div className="p-3 bg-green-50 border border-green-200 rounded text-green-800">
            <div className="font-medium">Burn confirmed on-chain</div>
            {mxnAmount && (
              <div className="mt-1">
                MXN payout of <strong>{mxnAmount} MXN</strong> posted (simulated — banking rail integration deferred).
              </div>
            )}
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

const MxBalanceDisplay = ({ wallet }: { wallet: string }) => {
  const { data: balance } = useBalance(wallet);
  if (!balance) return null;
  return (
    <div className="text-sm text-gray-600">
      <strong>MX wallet balance:</strong> {balance.balance} tCAD
    </div>
  );
};
