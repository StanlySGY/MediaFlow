// Trigger a client-side file download from in-memory content.
export const downloadFile = (name: string, content: string, type: string): void => {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// Compact human-readable duration: "1h2m" or "2m3s".
export const formatDur = (s: number): string => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}h${m}m` : `${m}m${sec}s`;
};
