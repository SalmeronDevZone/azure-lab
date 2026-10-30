import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, open: true },
  // Toda la nube simulada (motor, shell y portal) va en un único paquete: es una app local.
  build: { chunkSizeWarningLimit: 3000 },
  test: { environment: 'node' },
} as any);
