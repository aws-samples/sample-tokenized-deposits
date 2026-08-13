import { useState } from 'react';
import { useInstructions, useInstruction } from '../hooks';
import { Card } from '../components';
import type { Status, InstructionSummary } from '../types';
import { INTENT_NAMES } from '../types';

const STATUS_COLORS: Record<Status, string> = {
  FUNDED: 'bg-blue-100 text-blue-800',
  SUBMITTED: 'bg-yellow-100 text-yellow-800',
  MINTED: 'bg-green-100 text-green-800',
  TRANSFERRED: 'bg-purple-100 text-purple-800',
  BURNED: 'bg-orange-100 text-orange-800',
  FAILED: 'bg-red-100 text-red-800',
};

const STATUS_OPTIONS: (Status | '')[] = ['', 'FUNDED', 'SUBMITTED', 'MINTED', 'TRANSFERRED', 'BURNED', 'FAILED'];

function shortenAddr(addr: string) {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatAmount(raw: string) {
  try {
    const s = BigInt(raw).toString();
    if (s.length <= 18) {
      const frac = s.padStart(18, '0').replace(/0+$/, '');
      return frac ? `0.${frac}` : '0';
    }
    const whole = s.slice(0, s.length - 18);
    const frac = s.slice(s.length - 18).replace(/0+$/, '');
    return frac ? `${Number(whole).toLocaleString()}.${frac}` : Number(whole).toLocaleString();
  } catch {
    return raw;
  }
}

function formatTime(ts: number) {
  if (!ts) return '---';
  return new Date(ts).toLocaleString();
}

export const History = () => {
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string>('');
  const { data, isLoading } = useInstructions(statusFilter || undefined);
  const { data: detail } = useInstruction(selectedId);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-800">Transaction History</h1>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="border rounded px-3 py-1.5 text-sm"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>{s || 'All Statuses'}</option>
          ))}
        </select>
      </div>

      {selectedId && detail && (
        <Card title="Instruction Detail">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div><strong>ID:</strong> <span className="font-mono text-xs break-all">{detail.instructionId}</span></div>
            <div><strong>Status:</strong> <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[detail.status]}`}>{detail.status}</span></div>
            <div><strong>Entity:</strong> {detail.entity}</div>
            <div><strong>Intent:</strong> {INTENT_NAMES[detail.intent]}</div>
            <div><strong>Amount:</strong> {formatAmount(detail.amount)} tCAD</div>
            <div><strong>Chain ID:</strong> {detail.chainId}</div>
            <div><strong>From:</strong> <span className="font-mono text-xs">{detail.fromParty}</span></div>
            <div><strong>To:</strong> <span className="font-mono text-xs">{detail.toParty}</span></div>
            <div><strong>Signer:</strong> <span className="font-mono text-xs">{detail.signer || '---'}</span></div>
            <div><strong>Tx Hash:</strong> <span className="font-mono text-xs">{detail.txHash || '---'}</span></div>
            <div><strong>Reference:</strong> {detail.reference || '---'}</div>
            <div><strong>Created:</strong> {formatTime(detail.createdTimestamp)}</div>
          </div>

          {detail.collateral && (
            <div className="mt-4">
              <h4 className="font-medium text-gray-700 mb-2">CAD Collateral (Off-Chain)</h4>
              <div className={`p-3 rounded border ${
                detail.collateral.status === 'LOCKED'
                  ? 'bg-blue-50 border-blue-200'
                  : detail.collateral.status === 'RELEASED'
                  ? 'bg-green-50 border-green-200'
                  : 'bg-red-50 border-red-200'
              }`}>
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">
                    {detail.collateral.status === 'LOCKED' ? '🔒 Locked' : '🔓 Released'}
                  </span>
                  <span className="font-mono text-xs">{detail.collateral.accountRef}</span>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-gray-600">
                  <div><strong>Amount:</strong> {formatAmount(detail.collateral.cadAmount)} CAD</div>
                  <div><strong>Locked at:</strong> {formatTime(detail.collateral.lockedAt)}</div>
                  {detail.collateral.releasedAt && (
                    <div><strong>Released at:</strong> {formatTime(detail.collateral.releasedAt)}</div>
                  )}
                </div>
                <div className="text-xs text-gray-500 mt-2">
                  {detail.collateral.status === 'LOCKED'
                    ? 'Real CAD held in segregated account. Released only after tCAD is burned on-chain.'
                    : 'Collateral released — the corresponding tCAD has been destroyed.'}
                </div>
              </div>
            </div>
          )}

          {detail.redemption && (
            <div className="mt-4">
              <h4 className="font-medium text-gray-700 mb-2">MXN Disbursement (Off-Chain)</h4>
              <div className={`p-3 rounded border ${
                detail.redemption.status === 'PENDING'
                  ? 'bg-yellow-50 border-yellow-200'
                  : detail.redemption.status === 'POSTED'
                  ? 'bg-green-50 border-green-200'
                  : 'bg-red-50 border-red-200'
              }`}>
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">
                    {detail.redemption.status === 'PENDING' ? '⏳ Pending' : detail.redemption.status === 'POSTED' ? '✅ Posted' : '❌ Failed'}
                  </span>
                  <span className="text-xs">{detail.redemption.fxSource}</span>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-gray-600">
                  <div><strong>CAD burned:</strong> {formatAmount(detail.redemption.cadAmount)} tCAD</div>
                  <div><strong>MXN payout:</strong> {formatAmount(detail.redemption.mxnAmount)} MXN</div>
                  <div><strong>FX rate:</strong> {(detail.redemption.fxRate / 1000).toFixed(3)} CAD→MXN</div>
                  <div><strong>Beneficiary:</strong> {detail.redemption.beneficiary}</div>
                  {detail.redemption.postedAt && (
                    <div><strong>Posted at:</strong> {formatTime(detail.redemption.postedAt)}</div>
                  )}
                </div>
                <div className="text-xs text-gray-500 mt-2">
                  {detail.redemption.status === 'PENDING'
                    ? 'MXN disbursement will post once the tCAD burn is confirmed on-chain.'
                    : 'Off-chain MXN payment sent to beneficiary.'}
                </div>
              </div>
            </div>
          )}

          {detail.reconciliation && (
            <div className="mt-4">
              <h4 className="font-medium text-gray-700 mb-2">Reconciliation</h4>
              <div className={`p-3 rounded border ${
                detail.reconciliation.status === 'MATCHED'
                  ? 'bg-emerald-50 border-emerald-200'
                  : 'bg-red-50 border-red-200'
              }`}>
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">
                    {detail.reconciliation.status === 'MATCHED' ? '✅ MATCHED' : '❌ MISMATCH'}
                  </span>
                  <span className="text-xs text-gray-500">{formatTime(detail.reconciliation.reconciledAt)}</span>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-gray-600">
                  <div>
                    <div className="text-gray-400 uppercase tracking-wide">On-chain burn</div>
                    <div className="font-medium">{formatAmount(detail.reconciliation.burnAmount)} tCAD</div>
                  </div>
                  <div>
                    <div className="text-gray-400 uppercase tracking-wide">CAD released</div>
                    <div className="font-medium">{formatAmount(detail.reconciliation.collateralReleased)} CAD</div>
                  </div>
                  <div>
                    <div className="text-gray-400 uppercase tracking-wide">MXN posted</div>
                    <div className="font-medium">{formatAmount(detail.reconciliation.mxnPosted)} MXN</div>
                  </div>
                </div>
                {detail.reconciliation.collateralAccountRef && (
                  <div className="text-xs text-gray-500 mt-2">
                    Collateral account: {detail.reconciliation.collateralAccountRef}
                    {detail.reconciliation.mintInstructionId && (
                      <span> (mint: {detail.reconciliation.mintInstructionId.slice(0, 10)}...)</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {detail.audit.length > 0 && (
            <div className="mt-4">
              <h4 className="font-medium text-gray-700 mb-2">Audit Trail</h4>
              <div className="space-y-2">
                {detail.audit.map((entry, i) => (
                  <div key={i} className="flex items-start gap-3 text-xs">
                    <span className="text-gray-400 whitespace-nowrap">{formatTime(entry.timestamp)}</span>
                    <span className={`px-1.5 py-0.5 rounded font-medium ${STATUS_COLORS[entry.status as Status] || 'bg-gray-100'}`}>
                      {entry.status}
                    </span>
                    <span className="text-gray-600">{entry.detail}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      {isLoading ? (
        <p className="text-gray-500">Loading...</p>
      ) : !data?.instructions.length ? (
        <Card><p className="text-gray-500">No instructions found.</p></Card>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">ID</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Type</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Entity</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Amount</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">From</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">To</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.instructions.map((instr: InstructionSummary) => (
                <tr
                  key={instr.instructionId}
                  onClick={() => setSelectedId(instr.instructionId)}
                  className={`hover:bg-blue-50 cursor-pointer transition ${
                    selectedId === instr.instructionId ? 'bg-blue-50' : ''
                  }`}
                >
                  <td className="px-4 py-3 font-mono text-xs">{instr.instructionId.slice(0, 10)}...</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[instr.status]}`}>
                      {instr.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs">{INTENT_NAMES[instr.intent] || `intent=${instr.intent}`}</td>
                  <td className="px-4 py-3">{instr.entity}</td>
                  <td className="px-4 py-3 text-right font-mono">{formatAmount(instr.amount)}</td>
                  <td className="px-4 py-3 font-mono text-xs">{shortenAddr(instr.fromParty)}</td>
                  <td className="px-4 py-3 font-mono text-xs">{shortenAddr(instr.toParty)}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{formatTime(instr.createdTimestamp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-4 py-2 bg-gray-50 text-xs text-gray-500 border-t">
            {data.count} instruction{data.count !== 1 ? 's' : ''}
          </div>
        </div>
      )}

    </div>
  );
};
