import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import viteCompression from 'vite-plugin-compression'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default defineConfig({
  plugins: [
    react(),
    viteCompression({
      algorithm: 'gzip',
      ext: '.gz',
      threshold: 10240, // Only compress files > 10KB
    }),
    VitePWA({
      devOptions: {
        enabled: false,
      },
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'brand-logo-final.png'],
      workbox: {
        importScripts: ['/firebase-messaging-sw.js'],
        navigateFallbackDenylist: [/^\/api\//, /^\/auth\//],
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: 'NetworkOnly',
          },
        ],
      },
      manifest: {
        name: 'Datum',
        short_name: 'Datum',
        description: 'Datum Dashboard',
        theme_color: '#ffffff',
        icons: [
          {
            src: 'favicon.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'favicon.png',
            sizes: '512x512',
            type: 'image/png',
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  /*
   |--------------------------------------------------------------------------
   | DEV SERVER (vite)
   | Routes to STAGING API
   |--------------------------------------------------------------------------
   */
  server: {
    proxy: {
      // 1️⃣ External service (most specific)
      '/api/external-pagespeed': {
        target: 'https://speed-audit-service.onrender.com',
        changeOrigin: true,
        rewrite: (path) =>
          path.replace(/^\/api\/external-pagespeed/, '/api'),
      },

      // 2️⃣ Auth
      '/api/auth/': {
        target: 'http://localhost:8081',
        // target: 'https://api.trytechit.co/main',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },

      // 3️⃣ Alerts
      '/api/alerts': {
        target: 'http://localhost:8081',
        // target: 'https://api.trytechit.co/main',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },

      // Push Notifications
      '/api/push': {
        target: 'http://localhost:8081',
        // target: 'https://api.trytechit.co/main',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },

      // 4️⃣ Author (analytics sub-route)
      '/api/author': {
        target: 'http://localhost:8081',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api/, '/analytics'),
      },

      // Tenant router direct mapping
      '/api/tenant': {
        target: 'http://localhost:8081',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },

      // Merchant requests Socket.IO (must stay above the REST route and catch-all)
      '/api/merchant-requests/socket.io': {
        target: 'http://localhost:8081',
        changeOrigin: true,
        secure: false,
        ws: true,
      },

      // Merchant requests service
      '/api/merchant-requests': {
        target: 'http://localhost:8081',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },

      // Sessions service
      '/api/sessions': {

        target: 'http://localhost:8081',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },

      // Daily insights service
      '/api/daily-insights': {
        target: 'http://localhost:8081',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },

      // Health monitor service
      '/api/health-monitor': {
        target: 'http://localhost:8081',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },

      // 5️⃣ Catch-all analytics (MUST BE LAST)

      '/api': {
        target: 'http://localhost:8081',
        // target: 'https://api.trytechit.co/main',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api/, '/analytics'),
      },
    },
  },

  /*
   |--------------------------------------------------------------------------
   | PREVIEW MODE (vite preview)
   | Routes to LOCAL DOCKER API GATEWAY (port 18080)
   |--------------------------------------------------------------------------
   */
  preview: {
    proxy: {
      '/api/external-pagespeed': {
        target: 'https://speed-audit-service.onrender.com',
        changeOrigin: true,
        rewrite: (path) =>
          path.replace(/^\/api\/external-pagespeed/, '/api'),
      },

      // Auth via gateway
      '/api/auth/': {
        target: 'http://localhost:8081',
        // target: 'https://api.trytechit.co/main',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },

      // Alerts via gateway
      '/api/alerts': {
        target: 'http://localhost:8081',
        // target: 'https://api.trytechit.co/main',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },

      // Push via gateway
      '/api/push': {
        target: 'http://localhost:8081',
        // target: 'https://api.trytechit.co/main',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },

      // Author via analytics prefix
      '/api/author': {
        target: 'http://localhost:8081',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '/analytics'),
      },

      // Tenant router direct mapping
      '/api/tenant': {
        target: 'http://localhost:8081',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },

      // Merchant requests Socket.IO (must stay above the REST route and catch-all)
      '/api/merchant-requests/socket.io': {
        target: 'http://localhost:8081',
        changeOrigin: true,
        secure: false,
        ws: true,
      },

      // Merchant requests service
      '/api/merchant-requests': {
        target: 'http://localhost:8081',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },

      // Sessions service
      '/api/sessions': {
        target: 'http://localhost:8081',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },

      // Daily insights service
      '/api/daily-insights': {
        target: 'http://localhost:8081',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },

      // Health monitor service
      '/api/health-monitor': {
        target: 'http://localhost:8081',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },

      // Catch-all analytics
      '/api': {
        target: 'http://localhost:8081',
        // target: 'https://api.trytechit.co/main',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '/analytics'),
      },
    },
  },

  /*
   |--------------------------------------------------------------------------
   | BUILD OPTIMIZATIONS
   | Manual chunk splitting for better caching & smaller initial bundle
   |--------------------------------------------------------------------------
   */
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-redux', '@reduxjs/toolkit'],
          'vendor-mui': ['@mui/material', '@mui/icons-material', '@emotion/react', '@emotion/styled'],
          'vendor-recharts': ['recharts'],
          'vendor-chartjs': ['chart.js', 'react-chartjs-2', 'chartjs-plugin-datalabels'],
          'vendor-polaris': ['@shopify/polaris', '@shopify/polaris-icons'],
          'vendor-radix': [
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-select',
            '@radix-ui/react-separator',
            '@radix-ui/react-slot',
            '@radix-ui/react-switch',
            '@radix-ui/react-tabs',
            '@radix-ui/react-tooltip',
          ],
          'vendor-motion': ['framer-motion'],
          'vendor-misc': ['dayjs', 'axios', 'lucide-react', 'clsx', 'tailwind-merge', 'class-variance-authority'],
        },
      },
    },
  },
})
