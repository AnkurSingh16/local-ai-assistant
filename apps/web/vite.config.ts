import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';

// The end-to-end tests run their own API on another port and set API_TARGET.
const apiTarget = process.env.API_TARGET ?? 'http://127.0.0.1:8787';

/**
 * A strict Content Security Policy for the built app: scripts only from this
 * origin, no images from elsewhere, no plugins. (frame-ancestors is ignored in a
 * meta tag, so framing protection waits for a real server header.) The dev server
 * needs an inline preamble for fast refresh, so the policy is added at build
 * time only.
 */
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: csp },
        injectTo: 'head-prepend',
      },
    ],
  };
}

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  // Workspace packages resolve to their TypeScript sources in development.
  resolve: { conditions: ['@local-ai/source'] },
  server: {
    host: '127.0.0.1',
    // WEB_PORT moves the dev server when another project already uses 5173.
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    // Same-origin requests in development: the proxy rewrites Host to the API's
    // own address, which is on the API's Host allowlist.
    proxy: { '/v1': { target: apiTarget, changeOrigin: true } },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    proxy: { '/v1': { target: apiTarget, changeOrigin: true } },
  },
});
