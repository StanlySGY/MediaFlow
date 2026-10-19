/**
 * The upload gate, evaluated before any bytes go on the wire.
 *
 * Without this the browser sends a file it was never going to accept: the
 * backend checks the extension at the start and the size mid-stream, so a
 * rejected file costs a full upload attempt (progress bar, cancelled task,
 * then a 413 that arrives after minutes of transfer).
 *
 * Limits come from GET /asr/config. The defaults below are only used before
 * that request answers, and mirror ALLOWED_EXTS in app/api/routes.py — if the
 * server's list changes, the live value wins.
 */

export interface UploadLimits {
  maxBytes?: number;
  allowedExts?: string[];
}

/** Fallback only: used until /asr/config reports the real list. */
export const FALLBACK_ALLOWED_EXTS = [
  '.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg', '.pcm', '.mp4', '.mov', '.mkv',
];

export const extOf = (name: string): string => {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
};

export const formatSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value >= 100 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
};

/** Byte length a base64 string decodes to, ignoring padding. */
export const base64Bytes = (b64: string): number => {
  const len = b64.length;
  if (!len) return 0;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
};

/** Human-readable extension list for the upload hint: "mp3 / wav / pcm". */
export const extLabel = (exts: string[]): string =>
  exts.map((e) => (e.startsWith('.') ? e.slice(1) : e)).join(' / ');

/**
 * Returns the sentence to show the user, or null when the file is acceptable.
 * An empty extension is deliberately allowed, matching the backend's
 * `if suffix and suffix not in ALLOWED_EXTS` — a nameless file is not rejected
 * for its name, only for its size.
 */
export const rejectUploadFile = (file: { name: string; size: number }, limits: UploadLimits): string | null => {
  const ext = extOf(file.name);
  if (ext && limits.allowedExts && limits.allowedExts.length > 0 && !limits.allowedExts.includes(ext)) {
    return `不支持的文件格式「${ext}」。服务端接受：${extLabel(limits.allowedExts)}。`;
  }
  if (limits.maxBytes && file.size > limits.maxBytes) {
    return `文件 ${formatSize(file.size)} 超过服务端上传上限 ${formatSize(limits.maxBytes)}，上传会在中途被拒绝。请先切分文件或降低码率。`;
  }
  return null;
};
