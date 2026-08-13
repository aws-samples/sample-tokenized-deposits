import type { Settings, MintResponse, FxRate, InstructionSummary, InstructionDetail } from './types';

const getSettings = (): Settings => {
  const stored = localStorage.getItem('tokenized-cash-settings');
  return stored ? JSON.parse(stored) : { apiKey: '', apiBaseUrl: '', rpcUrl: '', tokenAddress: '', settlementConsumerAddress: '', caWallet: '', mxWallet: '' };
};

const apiFetch = async <T>(path: string, options: RequestInit = {}): Promise<T> => {
  const { apiKey, apiBaseUrl } = getSettings();
  if (!apiBaseUrl || !apiKey) throw new Error('API settings not configured. Go to Settings.');

  const res = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, ...options.headers },
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
};

export const api = {
  mint: (body: { asset: string; amount: string; toParty: string; reference?: string; entity?: string }) =>
    apiFetch<MintResponse>('/mint', { method: 'POST', body: JSON.stringify(body) }),

  redeem: (body: { asset: string; amount: string; fromParty: string; toParty: string; reference?: string }) =>
    apiFetch<MintResponse>('/redeem', { method: 'POST', body: JSON.stringify(body) }),

  getFxRate: () => apiFetch<FxRate>('/fx/rate'),

  setFxRate: (rate: number, setBy: string) =>
    apiFetch<FxRate>('/fx/rate', { method: 'POST', body: JSON.stringify({ rate, setBy }) }),

  convertFx: (cadAmount: string) =>
    apiFetch<{ cadAmount: string; mxnAmount: string; rate: number; display: string }>(
      '/fx/convert', { method: 'POST', body: JSON.stringify({ cadAmount }) }
    ),

  getInstructions: (status?: string) =>
    apiFetch<{ instructions: InstructionSummary[]; count: number }>(
      `/instructions${status ? `?status=${status}` : ''}`
    ),

  getInstruction: (id: string) =>
    apiFetch<InstructionDetail>(`/instructions/${id}`),
};
