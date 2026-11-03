import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, mkdir, writeFile, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 启动真实 Electron 验证用户交互与沙盒；共享一个应用进程，文件/偏好/日志均使用隔离临时目录。
 * 原生选择器和启动项接口只在指定测试中替换并恢复，不允许测试修改宿主的登录项或用户文件。
 * 测试使用生产构建，因此也检查生产 CSP；Windows 安装与证书验证仍不能由 macOS 执行代替。
 */
let app
let page
let userData
const failures = []
test.beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), 'desktop-e2e-'))
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, DESKTOP_TEST_USER_DATA: userData },
  })
  page = await app.firstWindow()
  page.on('pageerror', (error) => failures.push(error.message))
  await expect(page.getByRole('heading', { name: '框架概览', exact: true })).toBeVisible()
})
test.afterAll(async () => {
  await app?.close()
  if (userData) await rm(userData, { recursive: true, force: true })
})

test('真实 Electron 运行与沙盒边界', async () => {
  expect(
    await page.evaluate(() => ({
      node: typeof window.require,
      process: typeof window.process,
      bridge: typeof window.desktop.request,
    })),
  ).toEqual({ node: 'undefined', process: 'undefined', bridge: 'function' })
  const settings = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
  )
  expect(settings.sandbox).toBe(true)
  expect(settings.contextIsolation).toBe(true)
  expect(settings.nodeIntegration).toBe(false)
  expect(
    await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'),
  ).not.toContain('ws://')
  const result = await page.evaluate(() =>
    window.desktop.request({ id: 'not-configured', path: '/items' }),
  )
  expect(result.error.code).toBe('NOT_CONFIGURED')
})

test('搜索、重置、分页、排序和行选择', async () => {
  await page.getByRole('link', { name: '表格与搜索', exact: true }).click()
  await expect(page.locator('.el-table__body-wrapper').getByText('AsyncButton')).toBeVisible()
  await page.getByRole('textbox', { name: '名称或说明' }).fill('FileGrants')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(page.locator('.table-toolbar')).toContainText('共 1 项')
  await expect(page.locator('.el-table__body-wrapper').getByText('FileGrants')).toBeVisible()
  await page.getByRole('button', { name: '重置', exact: true }).click()
  await expect(page.locator('.table-toolbar')).toContainText('共 24 项')
  const sort = page.getByRole('button', { name: '按 能力名称 排序', exact: true })
  await sort.press('Enter')
  await expect(page.locator('.el-table__body-wrapper tbody tr').first()).toContainText(
    'ActionDialog',
  )
  await sort.press('Enter')
  await expect(page.locator('.el-table__body-wrapper tbody tr').first()).toContainText('Window')
  await sort.press('Enter')
  await expect(page.locator('.el-table__body-wrapper tbody tr').first()).toContainText(
    'AsyncButton',
  )
  await page.locator('.el-table__header-wrapper .el-checkbox').click()
  await expect(page.locator('.selection-note')).toContainText('10')
  await page.locator('.el-pager li').filter({ hasText: /^2$/ }).click()
  await expect(
    page.locator('.el-table__body-wrapper').getByText('Request', { exact: true }),
  ).toBeVisible()
  await expect(page.locator('.selection-note')).toHaveCount(0)
})

test('弹窗取消与抽屉内滚动，表单失败保留输入', async () => {
  await page.getByRole('link', { name: '通用组件', exact: true }).click()
  await page.getByRole('button', { name: '校验并本地提交' }).click()
  await expect(page.getByText('请填写名称', { exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '示例名称' }).fill('本地测试')
  await page.getByRole('button', { name: '校验并本地提交' }).click()
  await expect(page.getByText('本地示例提交完成', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '打开弹窗' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '取消操作' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: '打开抽屉' }).click()
  const drawer = page.getByRole('dialog')
  await expect(drawer).toBeVisible()
  expect(
    await drawer
      .locator('.el-drawer__body')
      .evaluate((element) => element.scrollHeight > element.clientHeight),
  ).toBe(true)
  await drawer.getByRole('button', { name: '取消', exact: true }).click()
})

test('文件授权、真实读取与原子另存，取消选择无副作用', async () => {
  const input = join(userData, 'test-input.txt')
  const output = join(userData, 'test-output.txt')
  await writeFile(input, 'isolated UTF-8 测试')
  await app.evaluate(
    ({ dialog }, paths) => {
      globalThis.testDialogs = { open: dialog.showOpenDialog, save: dialog.showSaveDialog }
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.input] })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.output })
    },
    { input, output },
  )
  try {
    await page.getByRole('link', { name: '桌面能力', exact: true }).click()
    await page.getByRole('button', { name: '打开文本', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '文本文件内容' })).toHaveValue(
      'isolated UTF-8 测试',
    )
    await page.getByRole('textbox', { name: '文本文件内容' }).fill('saved 文本')
    await page.getByRole('button', { name: '另存为', exact: true }).click()
    await expect(page.getByText('文件已保存', { exact: true })).toBeVisible()
    expect(await readFile(output, 'utf8')).toBe('saved 文本')
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
    })
    await page.getByRole('button', { name: '打开文本', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '文本文件内容' })).toHaveValue('saved 文本')
  } finally {
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = globalThis.testDialogs.open
      dialog.showSaveDialog = globalThis.testDialogs.save
      delete globalThis.testDialogs
    })
  }
})

test('主题持久化、缩放与所有页面无 body 滚动', async () => {
  await page.getByRole('link', { name: '应用设置', exact: true }).click()
  await page.getByText('暗色', { exact: true }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.reload()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.getByText('明亮', { exact: true }).click()
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  for (const [width, height, zoom] of [
    [1240, 820, 1],
    [760, 540, 1],
    [1000, 700, 1.25],
    [760, 540, 1.5],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.setSize(size.width, size.height)
        window.webContents.setZoomFactor(size.zoom)
      },
      { width, height, zoom },
    )
    for (const name of ['框架概览', '通用组件', '表格与搜索', '桌面能力', '应用设置']) {
      await page.getByRole('link', { name, exact: true }).click()
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
      const dimensions = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      }))
      expect(dimensions.scrollWidth, `${name} horizontal at ${width}/${zoom}`).toBeLessThanOrEqual(
        dimensions.width,
      )
      expect(dimensions.scrollHeight, `${name} vertical at ${height}/${zoom}`).toBeLessThanOrEqual(
        dimensions.height,
      )
      if (name === '表格与搜索') {
        await expect(page.locator('.el-pagination__sizes')).toBeVisible()
        expect(
          await page.locator('.table-content').evaluate((element) => element.clientHeight),
        ).toBeGreaterThan(50)
        const pagination = await page.locator('.table-pagination').boundingBox()
        expect(pagination.y + pagination.height).toBeLessThanOrEqual(dimensions.height - 20)
      }
    }
  }
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setSize(1240, 820)
    window.webContents.setZoomFactor(1)
  })
  await page.getByRole('link', { name: '框架概览', exact: true }).click()
  await mkdir('artifacts', { recursive: true })
  await page.screenshot({ path: 'artifacts/overview-macos.png' })
  expect(failures).toEqual([])
})

test('短内容视口保留完整表格行、搜索、分页和导航入口', async () => {
  const previous = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    const state = {
      size: window.getSize(),
      minimum: window.getMinimumSize(),
      zoom: window.webContents.getZoomFactor(),
    }
    // 直接固定内容尺寸，复现 Windows 标题栏占位后的 496×317 逻辑视口，避免 macOS 误通过。
    window.setMinimumSize(0, 0)
    window.setContentSize(744, 476)
    window.webContents.setZoomFactor(1.5)
    return state
  })
  try {
    await page.waitForFunction(() => innerWidth === 496 && innerHeight === 317)
    await page.getByRole('link', { name: '表格与搜索', exact: true }).click()
    await expect(page.locator('.table-toolbar')).toContainText('共 24 项')
    const content = page.locator('.el-table__body-wrapper')
    const row = content.locator('tbody tr').first()
    await expect(row).toBeVisible()
    const bodyBox = await content.boundingBox()
    const rowBox = await row.boundingBox()
    expect(rowBox.y).toBeGreaterThanOrEqual(bodyBox.y)
    expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(bodyBox.y + bodyBox.height)
    // 搜索与完整分页操作均可触达，不能靠隐藏条数选择或放开 body 滚动来通过。
    await page.getByRole('textbox', { name: '名称或说明' }).fill('FileGrants')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await expect(page.locator('.table-toolbar')).toContainText('共 1 项')
    await page.getByRole('button', { name: '重置', exact: true }).click()
    await page.locator('.el-pager li').filter({ hasText: /^2$/ }).click()
    await expect(page.locator('.table-content').getByText('Request', { exact: true })).toBeVisible()
    await page.locator('.el-pagination__sizes').scrollIntoViewIfNeeded()
    await expect(page.locator('.el-pagination__sizes')).toBeInViewport({ ratio: 1 })
    await page.getByRole('link', { name: '应用设置', exact: true }).scrollIntoViewIfNeeded()
    await expect(page.getByRole('link', { name: '应用设置', exact: true })).toBeInViewport({
      ratio: 1,
    })
    const navigation = await page.locator('.sidebar > nav').evaluate((element) => {
      const last = element.lastElementChild.getBoundingClientRect()
      const bounds = element.getBoundingClientRect()
      return { top: last.top, bottom: last.bottom, start: bounds.top, end: bounds.bottom }
    })
    expect(navigation.top).toBeGreaterThanOrEqual(navigation.start)
    expect(navigation.bottom).toBeLessThanOrEqual(navigation.end)
    expect(
      await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      })),
    ).toEqual({ width: 496, height: 317, scrollWidth: 496, scrollHeight: 317 })
  } finally {
    await app.evaluate(({ BrowserWindow }, state) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setMinimumSize(...state.minimum)
      window.setSize(...state.size)
      window.webContents.setZoomFactor(state.zoom)
    }, previous)
  }
})

test('同一帧连续点击只产生一次按钮或弹窗成功回调', async () => {
  await page.reload()
  await page.getByRole('link', { name: '通用组件', exact: true }).click()
  await page.getByRole('textbox', { name: '示例名称' }).fill('同步防重复测试')
  const submit = page.getByRole('button', { name: '校验并本地提交', exact: true })
  await submit.evaluate((element) => {
    element.click()
    element.click()
  })
  await expect(submit).toBeEnabled()
  await expect(page.getByText('本地示例提交完成', { exact: true })).toHaveCount(1)
  await page.reload()
  await page.getByRole('button', { name: '打开弹窗', exact: true }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '保存', exact: true })
    .evaluate((element) => {
      element.click()
      element.click()
    })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText('本地示例提交完成', { exact: true })).toHaveCount(1)
})

test('最小化恢复与 macOS 无窗口时的重新打开', async () => {
  await app.evaluate(({ BrowserWindow, app }) => {
    BrowserWindow.getAllWindows()[0].minimize()
    app.emit('second-instance')
  })
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()))
    .toBe(false)
  if (process.platform === 'darwin') {
    const reopened = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await app.evaluate(({ app }) => app.emit('second-instance'))
    page = await reopened
    await expect(page.getByRole('heading', { name: '框架概览', exact: true })).toBeVisible()
  }
})

test('损坏的窗口尺寸回退默认值并给出可见告警', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-corrupt-bounds-'))
  await writeFile(
    join(directory, 'window.json'),
    JSON.stringify({ x: 0, y: 0, width: -1, height: 500 }),
  )
  let isolated
  try {
    isolated = await electron.launch({
      args: ['.'],
      env: { ...process.env, DESKTOP_TEST_USER_DATA: directory },
    })
    const isolatedPage = await isolated.firstWindow()
    await expect(isolatedPage.getByRole('heading', { name: '框架概览', exact: true })).toBeVisible()
    const result = await isolatedPage.evaluate(() => window.desktop.info())
    expect(result.data.storageWarning).toContain('本地设置无法读取')
    expect(await realpath(await isolated.evaluate(({ app }) => app.getPath('logs')))).toBe(
      await realpath(join(directory, 'logs')),
    )
  } finally {
    await isolated?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('普通外观设置不修改系统启动项，仅显式开关触发系统接口', async () => {
  await app.evaluate(({ app }) => {
    const original = {
      descriptor: Object.getOwnPropertyDescriptor(app, 'isPackaged'),
      get: app.getLoginItemSettings,
      set: app.setLoginItemSettings,
    }
    globalThis.loginTest = { original, calls: [], enabled: true }
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
    app.getLoginItemSettings = () => ({ openAtLogin: globalThis.loginTest.enabled })
    app.setLoginItemSettings = (value) => {
      globalThis.loginTest.calls.push(value)
      globalThis.loginTest.enabled = value.openAtLogin
    }
  })
  try {
    const snapshot = await page.evaluate(() => window.desktop.preferences.get())
    expect(snapshot.data.launchAtLogin).toBe(true)
    expect((await page.evaluate(() => window.desktop.preferences.set({ theme: 'light' }))).ok).toBe(
      true,
    )
    expect(await app.evaluate(() => globalThis.loginTest.calls.length)).toBe(0)
    expect(
      (await page.evaluate(() => window.desktop.preferences.set({ launchAtLogin: false }))).ok,
    ).toBe(true)
    expect(await app.evaluate(() => globalThis.loginTest.calls)).toEqual([{ openAtLogin: false }])
  } finally {
    await app.evaluate(({ app }) => {
      const original = globalThis.loginTest.original
      if (original.descriptor) Object.defineProperty(app, 'isPackaged', original.descriptor)
      else delete app.isPackaged
      app.getLoginItemSettings = original.get
      app.setLoginItemSettings = original.set
      delete globalThis.loginTest
    })
  }
})
