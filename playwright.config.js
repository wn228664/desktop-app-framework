import { defineConfig } from '@playwright/test'

/**
 * 真实 Electron 交互测试使用一个 worker，避免多个原生窗口争用焦点和系统对话框。
 * 测试内部隔离 userData/logs，失败保留 trace/截图，不通过自动重试掩盖窗口时序问题。
 * npm run test:e2e 前需完成生产构建，安装包与 Windows 真机验收另行记录。
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 45_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
})
