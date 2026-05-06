/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

const DEV_SERVER_PORT = 5173
const PHASER_CHUNK_WARNING_LIMIT_KB = 1300

// Vite 기본 설정은 공식 문서 형식을 그대로 따른다.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: true, // 모든 네트워크 인터페이스에서 접근 가능
    port: DEV_SERVER_PORT, // 기본 포트 (변경 가능)
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/setupTests.ts',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
    },
  },
  build: {
    // Phaser 엔진 청크는 특성상 큰 편이므로 경고 임계값을 엔진 크기에 맞춘다.
    chunkSizeWarningLimit: PHASER_CHUNK_WARNING_LIMIT_KB,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/phaser')) return 'vendor-phaser'
          if (id.includes('node_modules/firebase')) return 'vendor-firebase'
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'vendor-react'
          }
          // 게임 컴포넌트를 game-core로 강제 묶었을 때 vendor-react와 순환 초기화가 생겨
          // 프로덕션에서 React 네임스페이스가 깨진 적이 있어 앱 청크는 Rollup 기본 분할에 맡긴다.
          return undefined
        },
      },
    },
  },
})
