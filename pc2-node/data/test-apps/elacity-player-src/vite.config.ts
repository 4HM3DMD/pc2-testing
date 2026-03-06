import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  base: './',
  build: {
    outDir: '../elacity-player',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      plugins: [
        {
          name: 'cjs-exports-shim',
          renderChunk(code) {
            if (code.includes('exports') && !code.includes('var exports')) {
              return {
                code: `var exports = typeof module !== 'undefined' ? module.exports : {};\n${code}`,
                map: null,
              };
            }
            return null;
          },
        },
      ],
    },
  },
  plugins: [
    react(),
    nodePolyfills({
      globals: {
        process: true,
        Buffer: true,
      }
    }),
  ],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'process.browser': 'true',
    'process.version': JSON.stringify('v20.0.0'),
    global: 'globalThis',
  },
  optimizeDeps: {
    include: ['buffer'],
  },
  server: {
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  }
});
