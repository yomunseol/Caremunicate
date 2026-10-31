import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // The geocoder key is supplied as NEXT_PUBLIC_GEOCODER_API_KEY, so expose
  // that prefix to import.meta.env alongside Vite's default VITE_.
  envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
  plugins: [react()],
});
