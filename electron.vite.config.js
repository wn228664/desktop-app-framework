import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { loadEnv } from 'vite'
import { readFileSync } from 'node:fs'
import { resolveRuntimeConfig } from './src/shared/config.js'

/**
 * 三进程构建边界：main 外置运行依赖，preload 生成独立 CommonJS，renderer 只构建浏览器代码。
 * 公开配置在构建时固定，修改 .env 后需重启开发服务或重建安装包；原始环境对象不能直接注入代码。
 * Vue 页面按路由懒加载，生产 renderer 压缩；主进程保留可诊断代码，但不输出敏感运行数据。
 */
const identity = JSON.parse(readFileSync(new URL('./app.config.json', import.meta.url), 'utf8'))

export default defineConfig(({ mode }) => ({
  main: {
    define: {
      __DESKTOP_CONFIG__: JSON.stringify({
        ...resolveRuntimeConfig(loadEnv(mode, process.cwd(), 'DESKTOP_'), mode === 'development'),
        ...identity,
      }),
    },
    build: { externalizeDeps: true },
  },
  preload: {
    // sandbox 不支持按普通 Node 模块方式加载 preload 的额外依赖，因此打成单个 cjs，不拆分外置包。
    build: {
      externalizeDeps: false,
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } },
    },
  },
  renderer: {
    plugins: [
      vue(),
      {
        name: 'desktop-production-csp',
        transformIndexHtml(html, context) {
          // HMR 只在本机开发时需要 WebSocket；正式 file:// 文档不应继续带这个网络例外。
          return context.server ? html : html.replace(' ws://127.0.0.1:*', '')
        },
      },
    ],
    build: { cssCodeSplit: true, minify: true },
    server: { host: '127.0.0.1' },
  },
}))
