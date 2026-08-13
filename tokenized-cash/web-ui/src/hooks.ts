import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { chain } from './chain';

export const useTokenInfo = () =>
  useQuery({
    queryKey: ['tokenInfo'],
    queryFn: () => chain.getTokenInfo(),
    refetchInterval: 30000,
  });

export const useBalance = (account: string) =>
  useQuery({
    queryKey: ['balance', account],
    queryFn: () => chain.getBalance(account),
    enabled: !!account,
    refetchInterval: 5000,
    refetchIntervalInBackground: true,
  });

export const useIsExecuted = (instructionId: string) =>
  useQuery({
    queryKey: ['executed', instructionId],
    queryFn: () => chain.isExecuted(instructionId),
    enabled: !!instructionId && instructionId.startsWith('0x'),
    refetchInterval: 10000,
  });

export const useBlockNumber = () =>
  useQuery({
    queryKey: ['blockNumber'],
    queryFn: () => chain.getBlockNumber(),
    refetchInterval: 5000,
  });

export const useFxRate = () =>
  useQuery({
    queryKey: ['fxRate'],
    queryFn: () => api.getFxRate(),
    refetchInterval: 60000,
  });

export const useMint = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.mint,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tokenInfo'] });
      queryClient.invalidateQueries({ queryKey: ['balance'] });
    },
  });
};

export const useRedeem = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.redeem,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tokenInfo'] });
      queryClient.invalidateQueries({ queryKey: ['balance'] });
    },
  });
};

export const useInstructions = (status?: string) =>
  useQuery({
    queryKey: ['instructions', status],
    queryFn: () => api.getInstructions(status),
    refetchInterval: 10000,
  });

export const useInstruction = (id: string) =>
  useQuery({
    queryKey: ['instruction', id],
    queryFn: () => api.getInstruction(id),
    enabled: !!id,
    refetchInterval: 2000,
    refetchIntervalInBackground: true,
  });
