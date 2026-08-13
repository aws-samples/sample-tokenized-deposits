export const formatTimestamp = (ts: number) => {
  if (ts > 1e12) return new Date(ts).toLocaleString();
  return new Date(ts * 1000).toLocaleString();
};
