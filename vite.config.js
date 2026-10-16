import { defineConfig } from 'vite';
import { surveyMiddleware } from './server/survey.mjs';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [{
    name: 'local-survey',
    configureServer(server) { server.middlewares.use(surveyMiddleware); },
    configurePreviewServer(server) { server.middlewares.use(surveyMiddleware); },
  }],
  build: { chunkSizeWarningLimit: 1800, rolldownOptions: { input: { index: resolve(import.meta.dirname, 'index.html'), replica: resolve(import.meta.dirname, 'replica.html') } } },
});
