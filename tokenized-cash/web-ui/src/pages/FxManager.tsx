import { useState } from 'react';
import { useFxRate } from '../hooks';
import { Card, Button, Input } from '../components';
import { formatTimestamp } from '../format';
import { api } from '../api';

export const FxManager = () => {
  const { data: fxRate, isLoading, refetch } = useFxRate();
  const [testAmount, setTestAmount] = useState('1000');
  const [converted, setConverted] = useState<{ mxnAmount: string; rate: number } | null>(null);
  const [converting, setConverting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  };

  const handleConvert = async () => {
    setConverting(true);
    try {
      const res = await api.convertFx(testAmount);
      setConverted(res);
    } catch { setConverted(null); }
    setConverting(false);
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-800">FX Rate</h1>

      <Card>
        <div className="text-sm text-gray-600 space-y-1">
          <p>
            The CAD to MXN rate is fetched automatically from the <strong>Bank of Canada Valet API</strong> (series FXCADMXN).
            The rate is cached for 1 hour and refreshed on the next request after expiry.
          </p>
          <p className="text-xs text-gray-400">
            Source: bankofcanada.ca/valet/observations/FXCADMXN
          </p>
        </div>
      </Card>

      <Card title="Current Rate">
        {isLoading ? (
          <div className="text-gray-500">Loading...</div>
        ) : fxRate ? (
          <div className="space-y-3">
            <div className="text-3xl font-bold text-purple-600">{fxRate.display}</div>
            <div className="text-sm text-gray-500">
              Source: {fxRate.setBy} | Updated: {formatTimestamp(fxRate.effectiveAt)}
            </div>
            <Button onClick={handleRefresh} disabled={refreshing}>
              {refreshing ? 'Refreshing...' : 'Refresh Rate'}
            </Button>
          </div>
        ) : (
          <div className="text-yellow-600">No FX rate available. Click refresh to fetch from Bank of Canada.</div>
        )}
      </Card>

      <Card title="Conversion Calculator">
        <div className="space-y-4">
          <Input label="CAD Amount" type="number" value={testAmount} onChange={e => setTestAmount(e.target.value)} />
          <Button onClick={handleConvert} disabled={converting || !testAmount}>
            {converting ? 'Converting...' : 'Convert'}
          </Button>
          {converted && (
            <div className="p-3 bg-gray-50 rounded">
              <span className="text-lg font-bold">{testAmount} CAD = {converted.mxnAmount} MXN</span>
              <span className="text-sm text-gray-500 ml-2">(rate: {converted.rate / 1000})</span>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
};
