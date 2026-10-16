import { mergeConfig } from 'vite';
import baseConfig from './vite.config';

export default mergeConfig(baseConfig, {
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    proxy: {
      '/asr': 'http://127.0.0.1:8081',
      '/auth': 'http://127.0.0.1:8081',
      '/health': 'http://127.0.0.1:8081',
    },
  },
});
