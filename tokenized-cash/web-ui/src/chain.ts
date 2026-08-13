import type { Settings } from './types';

const getSettings = (): Settings => {
  const stored = localStorage.getItem('tokenized-cash-settings');
  return stored ? JSON.parse(stored) : { apiKey: '', apiBaseUrl: '', rpcUrl: '', tokenAddress: '', settlementConsumerAddress: '', caWallet: '', mxWallet: '' };
};

const chainFetch = async <T>(path: string, params?: Record<string, string>): Promise<T> => {
  const { apiKey, apiBaseUrl } = getSettings();
  if (!apiBaseUrl || !apiKey) throw new Error('API settings not configured');

  const url = new URL(`${apiBaseUrl}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  const res = await fetch(url.toString(), {
    headers: { 'x-api-key': apiKey },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
};

export interface TokenInfo {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  totalSupplyRaw: string;
}

export interface BalanceInfo {
  address: string;
  balance: string;
  balanceRaw: string;
}

export const chain = {
  async getTokenInfo(): Promise<TokenInfo> {
    return chainFetch<TokenInfo>('/chain/token');
  },

  async getBalance(address: string): Promise<BalanceInfo> {
    return chainFetch<BalanceInfo>('/chain/balance', { address });
  },

  async isExecuted(instructionId: string): Promise<boolean> {
    const res = await chainFetch<{ executed: boolean }>('/chain/executed', { instructionId });
    return res.executed;
  },

  async getBlockNumber(): Promise<number> {
    const res = await chainFetch<{ blockNumber: number }>('/chain/block');
    return res.blockNumber;
  },
};
