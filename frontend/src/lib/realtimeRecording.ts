import { errorMessage } from './errors';

/**
 * The non-React half of the realtime recorder.
 *
 * These are the decisions a recording is made of — which container the browser
 * is asked to write, what the downloaded file is called, what a failed
 * microphone permission means in Chinese, how a blob becomes the base64 the
 * WebSocket frame wants. None of them need a component, and every one of them
 * is the kind of thing that silently regresses when a browser changes what it
 * reports, so they live here where they can be tested without mounting a panel.
 */

/** RealtimeManager.list() returns every session it still holds, including the
 *  terminal ones; only non-terminal ones occupy a slot in the cap. */
export const CAPACITY_TERMINAL_STATUSES: string[] = ['done', 'failed', 'closed'];

/** Preferred order: Opus-in-WebM is what the server's ffmpeg step handles best,
 *  so it is asked for first and the rest are fallbacks for browsers without it. */
export const RECORDER_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

/** Empty string means "let the browser pick", which is still a usable recording
 *  — it is only `MediaRecorder` itself being absent that leaves nothing to do. */
export const pickRecorderMimeType = () => {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const mime of RECORDER_MIME_CANDIDATES) {
    if (!MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return '';
};

export const formatFromMime = (mimeType: string) => {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('ogg')) return 'ogg';
  if (normalized.includes('wav')) return 'wav';
  return 'webm';
};

/** "realtime-2026-10-20-1530.txt" — a constant filename meant every recording
 *  downloaded over the last one, and the browser's "keep both" fallback leaves
 *  files nobody can tell apart. */
export const transcriptFileName = (ext = 'txt', now = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const time = `${p(now.getHours())}${p(now.getMinutes())}`;
  return `realtime-${day}-${time}.${ext}`;
};

/**
 * getUserMedia rejections are the most likely failure a first-time user hits,
 * and the DOMException messages are short English strings ("Permission denied")
 * that do not say what to do. Each branch below names the one action that fixes
 * it on the machine the console is actually running on.
 */
export const microphoneErrorMessage = (error: unknown): string => {
  const name = (error as { name?: string })?.name || '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '麦克风权限被拒绝。请点地址栏左侧的锁形图标，把「麦克风」改成允许，然后重新开始录音。';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return '没有找到可用的麦克风。请插好麦克风，或在系统声音设置里确认输入设备已启用。';
    case 'NotReadableError':
      return '麦克风被其他程序占用（会议软件、录音工具），或系统未授予浏览器麦克风权限。关掉占用它的程序后再试。';
    case 'AbortError':
      return '麦克风初始化被中断，请重新开始录音。';
    case 'NotSupportedError':
      // Chrome's own wording is the two-word string "Not supported", which says
      // nothing about what is missing. This one fires when the page cannot reach
      // an audio device at all: no capture device in the OS, a remote desktop /
      // VM session with no sound hardware, or a browser build without recording.
      return '当前环境无法开启录音：系统里没有可用的音频输入设备，或这个浏览器不支持录音。请在系统声音设置里确认输入设备，远程桌面/无麦克风的环境无法使用实时录音。';
    default:
      return errorMessage(error);
  }
};

export const blobToBase64 = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};
