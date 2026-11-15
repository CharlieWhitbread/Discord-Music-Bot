import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(viteConfig, defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
    restoreMocks: true,
    // Tests never talk to a real Pi.
    env: { VITE_API_BASE_URL: 'http://api.test', VITE_ADMIN_USER: 'admin' },
  },
}));
