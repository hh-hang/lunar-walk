import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ mode }) => ({
  base: loadEnv(mode, rootDir, 'VITE_').VITE_BASE_URL || '/',
}));
