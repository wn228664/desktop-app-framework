import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, mkdir, writeFile, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 启动真实 Electron 验证用户交互与沙盒；共享一个应用进程，文件/偏好/日志均使用隔离临时目录。
 * 原生选择器和启动项接口只在指定测试中替换并恢复，不允许测试修改宿主的登录项或用户文件。
 * 测试使用生产构建，因此也检查生产 CSP；Windows 安装与证书验证仍不能由 macOS 执行代替。
 */
// app：本组隔离启动的 Playwright Electron 应用句柄，测试结束关闭。
let app
// page：当前真实 renderer 窗口，窗口重建后更新引用。
let page
// userData：本组独占 userData 临时目录，包含日志和 fixture。
let userData
// failures：真实 renderer pageerror 消息集合，交互结束必须为空。
const failures = []
test.beforeAll(
  /**
   * 启动真实 Electron 并隔离 userData/logs，等待概览初始化就绪。
   */
  async () => {
    userData = await mkdtemp(join(tmpdir(), 'desktop-e2e-'))
    app = await electron.launch({
      args: ['.'],
      env: { ...process.env, DESKTOP_TEST_USER_DATA: userData },
    })
    page = await app.firstWindow()
    page.on(
      'pageerror',
      /**
       * 收集真实 renderer 未捕获异常。
       * error：真实 Electron renderer 抛出的错误，收集后统一断言为空。
       */
      (error) => failures.push(error.message),
    )
    await expect(page.getByRole('heading', { name: '框架概览', exact: true })).toBeVisible()
  },
)
test.afterAll(
  /**
   * 关闭本组测试应用并清理隔离目录。
   */
  async () => {
    await app?.close()
    if (userData) await rm(userData, { recursive: true, force: true })
  },
)

/**
 * 验证：真实 Electron 运行与沙盒边界。
 */
test('真实 Electron 运行与沙盒边界', async () => {
  expect(
    await page.evaluate(
      /**
       * 在真实 renderer 查询 Node 和固定桥可见性。
       */
      () => ({
        node: typeof window.require,
        process: typeof window.process,
        bridge: typeof window.desktop.request,
      }),
    ),
  ).toEqual({ node: 'undefined', process: 'undefined', bridge: 'function' })
  // settings：从真实 webContents 读取的安全偏好。
  const settings = await app.evaluate(
    /**
     * 从主进程读取真实 webContents 安全配置。
     * BrowserWindow：Electron 提供的窗口类，在主进程读取真实窗口状态。
     */
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
  )
  expect(settings.sandbox).toBe(true)
  expect(settings.contextIsolation).toBe(true)
  expect(settings.nodeIntegration).toBe(false)
  expect(
    await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'),
  ).not.toContain('ws://')
  // result：固定桌面桥返回的信封，断言其公开状态而非猜测成功。
  const result = await page.evaluate(
    /**
     * 请求未配置的 API，预期明确 NOT_CONFIGURED。
     */
    () => window.desktop.request({ id: 'not-configured', path: '/items' }),
  )
  expect(result.error.code).toBe('NOT_CONFIGURED')
})

/**
 * 验证：搜索、重置、分页、排序和行选择。
 */
test('搜索、重置、分页、排序和行选择', async () => {
  await page.getByRole('link', { name: '表格与搜索', exact: true }).click()
  await expect(page.locator('.el-table__body-wrapper').getByText('AsyncButton')).toBeVisible()
  // 首行分类由父级 category 插槽渲染；只看到能力名称不足以证明插槽载荷正确。
  await expect(
    page.locator('.el-table__body-wrapper tbody tr').first().locator('.el-tag'),
  ).toHaveText('交互组件')
  await page.getByRole('textbox', { name: '名称或说明' }).fill('FileGrants')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(page.locator('.table-toolbar')).toContainText('共 1 项')
  await expect(page.locator('.el-table__body-wrapper').getByText('FileGrants')).toBeVisible()
  await page.getByRole('button', { name: '重置', exact: true }).click()
  await expect(page.locator('.table-toolbar')).toContainText('共 24 项')
  // sort：能力名称列可访问排序按钮 locator。
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

/**
 * 验证：弹窗取消与抽屉内滚动，表单失败保留输入。
 */
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
  // drawer：当前真实 Element Plus 抽屉 locator。
  const drawer = page.getByRole('dialog')
  await expect(drawer).toBeVisible()
  expect(
    await drawer.locator('.el-drawer__body').evaluate(
      /**
       * 测量抽屉正文是否拥有实际独立滚动空间。
       * element：locator 指向的真实 DOM 元素，在 renderer 内测量或触发同帧点击。
       */
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true)
  await drawer.getByRole('button', { name: '取消', exact: true }).click()
})

/**
 * 验证：文件授权、真实读取与原子另存，取消选择无副作用。
 */
test('文件授权、真实读取与原子另存，取消选择无副作用', async () => {
  // input：隔离目录内的输入文本 fixture 路径。
  const input = join(userData, 'test-input.txt')
  // output：隔离目录内的另存目标路径。
  const output = join(userData, 'test-output.txt')
  await writeFile(input, 'isolated UTF-8 测试')
  await app.evaluate(
    /**
     * 保存原生选择器函数并安装仅返回临时路径的替身。
     * dialog：Electron 主进程原生对话框模块，仅在测试期间替换并恢复。
     * paths：传入主进程替身的临时 input/output 路径。
     */
    ({ dialog }, paths) => {
      globalThis.testDialogs = { open: dialog.showOpenDialog, save: dialog.showSaveDialog }
      dialog.showOpenDialog =
        /**
         * 模拟选择测试输入文件，未访问用户真实选择。
         */
        async () => ({ canceled: false, filePaths: [paths.input] })
      dialog.showSaveDialog =
        /**
         * 模拟批准隔离目录的另存目标。
         */
        async () => ({ canceled: false, filePath: paths.output })
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
    await app.evaluate(
      /**
       * 将下一次原生选择模拟为用户取消。
       * dialog：Electron 主进程原生对话框模块，仅在测试期间替换并恢复。
       */
      ({ dialog }) => {
        dialog.showOpenDialog =
          /**
           * 返回明确取消结果与空文件数组。
           */
          async () => ({ canceled: true, filePaths: [] })
      },
    )
    await page.getByRole('button', { name: '打开文本', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '文本文件内容' })).toHaveValue('saved 文本')
  } finally {
    await app.evaluate(
      /**
       * 恢复原生对话框接口并删除测试临时状态。
       * dialog：Electron 主进程原生对话框模块，仅在测试期间替换并恢复。
       */
      ({ dialog }) => {
        dialog.showOpenDialog = globalThis.testDialogs.open
        dialog.showSaveDialog = globalThis.testDialogs.save
        delete globalThis.testDialogs
      },
    )
  }
})

/**
 * 验证：主题持久化、缩放与所有页面无 body 滚动。
 */
test('主题持久化、缩放与所有页面无 body 滚动', async () => {
  await page.getByRole('link', { name: '应用设置', exact: true }).click()
  await page.getByText('暗色', { exact: true }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.reload()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.getByText('明亮', { exact: true }).click()
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  // width：当前窗口尺寸用例的逻辑宽度。
  // height：当前窗口尺寸用例的逻辑高度。
  // zoom：当前尺寸用例的缩放系数。
  for (const [width, height, zoom] of [
    [1240, 820, 1],
    [760, 540, 1],
    [1000, 700, 1.25],
    [760, 540, 1.5],
  ]) {
    await app.evaluate(
      /**
       * 把本次测试窗口宽高和缩放应用到真实窗口。
       * BrowserWindow：Electron 提供的窗口类，在主进程读取真实窗口状态。
       * size：传给主进程的宽、高和缩放测试配置。
       */
      ({ BrowserWindow }, size) => {
        // window：测试隔离应用中的真实主窗口，不是宿主其他应用。
        const window = BrowserWindow.getAllWindows()[0]
        window.setSize(size.width, size.height)
        window.webContents.setZoomFactor(size.zoom)
      },
      { width, height, zoom },
    )
    // name：当前待检查的中性页面可访问名称。
    for (const name of ['框架概览', '通用组件', '表格与搜索', '桌面能力', '应用设置']) {
      await page.getByRole('link', { name, exact: true }).click()
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
      // dimensions：renderer 实际视口与文档滚动尺寸快照。
      const dimensions = await page.evaluate(
        /**
         * 测量实际视口与文档尺寸，检查 body 不产生全局溢出。
         */
        () => ({
          width: innerWidth,
          height: innerHeight,
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
        }),
      )
      expect(dimensions.scrollWidth, `${name} horizontal at ${width}/${zoom}`).toBeLessThanOrEqual(
        dimensions.width,
      )
      expect(dimensions.scrollHeight, `${name} vertical at ${height}/${zoom}`).toBeLessThanOrEqual(
        dimensions.height,
      )
      if (name === '表格与搜索') {
        await expect(page.locator('.el-pagination__sizes')).toBeVisible()
        expect(
          await page.locator('.table-content').evaluate(
            /**
             * 读取表格内容容器实际高度，避免用空白或隐藏内容通过。
             * element：locator 指向的真实 DOM 元素，在 renderer 内测量或触发同帧点击。
             */
            (element) => element.clientHeight,
          ),
        ).toBeGreaterThan(50)
        // pagination：分页工具栏的实际边界框，用于检查下沿可达。
        const pagination = await page.locator('.table-pagination').boundingBox()
        expect(pagination.y + pagination.height).toBeLessThanOrEqual(dimensions.height - 20)
      }
    }
  }
  await app.evaluate(
    /**
     * 恢复标准窗口尺寸与缩放。
     * BrowserWindow：Electron 提供的窗口类，在主进程读取真实窗口状态。
     */
    ({ BrowserWindow }) => {
      // window：测试隔离应用中的真实主窗口，不是宿主其他应用。
      const window = BrowserWindow.getAllWindows()[0]
      window.setSize(1240, 820)
      window.webContents.setZoomFactor(1)
    },
  )
  await page.getByRole('link', { name: '框架概览', exact: true }).click()
  await mkdir('artifacts', { recursive: true })
  await page.screenshot({ path: 'artifacts/overview-macos.png' })
  expect(failures).toEqual([])
})

/**
 * 验证：短内容视口保留完整表格行、搜索、分页和导航入口。
 */
test('短内容视口保留完整表格行、搜索、分页和导航入口', async () => {
  // previous：短视口用例前的窗口尺寸、最小尺寸与缩放快照。
  const previous = await app.evaluate(
    /**
     * 保存原窗口状态，再建立小内容视口与高缩放复现场景。
     * BrowserWindow：Electron 提供的窗口类，在主进程读取真实窗口状态。
     */
    ({ BrowserWindow }) => {
      // window：测试隔离应用中的真实主窗口，不是宿主其他应用。
      const window = BrowserWindow.getAllWindows()[0]
      // state：窗口尺寸和缩放快照，恢复时原样应用。
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
    },
  )
  try {
    await page.waitForFunction(
      /**
       * 等待 renderer 确认实际 496×317 视口，而非仅相信原生外框尺寸。
       */
      () => innerWidth === 496 && innerHeight === 317,
    )
    await page.getByRole('link', { name: '表格与搜索', exact: true }).click()
    await expect(page.locator('.table-toolbar')).toContainText('共 24 项')
    // content：当前表格正文 locator，作为完整首行可见性的边界。
    const content = page.locator('.el-table__body-wrapper')
    // row：当前表格第一行 locator。
    const row = content.locator('tbody tr').first()
    await expect(row).toBeVisible()
    // bodyBox：表格滚动正文实际边界框。
    const bodyBox = await content.boundingBox()
    // rowBox：首行实际边界框，必须完整位于正文内。
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
    // navigation：侧栏最后入口与滚动容器的实际边界数值。
    const navigation = await page.locator('.sidebar > nav').evaluate(
      /**
       * 测量最后导航入口与导航容器边界，确认滚动后完整可达。
       * element：locator 指向的真实 DOM 元素，在 renderer 内测量或触发同帧点击。
       */
      (element) => {
        // last：导航最后入口的 DOMRect。
        const last = element.lastElementChild.getBoundingClientRect()
        // bounds：侧栏导航滚动容器的 DOMRect。
        const bounds = element.getBoundingClientRect()
        return { top: last.top, bottom: last.bottom, start: bounds.top, end: bounds.bottom }
      },
    )
    expect(navigation.top).toBeGreaterThanOrEqual(navigation.start)
    expect(navigation.bottom).toBeLessThanOrEqual(navigation.end)
    expect(
      await page.evaluate(
        /**
         * 读取短视口实际尺寸与文档尺寸，排除隐藏溢出伪通过。
         */
        () => ({
          width: innerWidth,
          height: innerHeight,
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
        }),
      ),
    ).toEqual({ width: 496, height: 317, scrollWidth: 496, scrollHeight: 317 })
  } finally {
    await app.evaluate(
      /**
       * 恢复短视口用例前的窗口最小值、尺寸与缩放。
       * BrowserWindow：Electron 提供的窗口类，在主进程读取真实窗口状态。
       * state：窗口尺寸和缩放快照，恢复时原样应用。
       */
      ({ BrowserWindow }, state) => {
        // window：测试隔离应用中的真实主窗口，不是宿主其他应用。
        const window = BrowserWindow.getAllWindows()[0]
        window.setMinimumSize(...state.minimum)
        window.setSize(...state.size)
        window.webContents.setZoomFactor(state.zoom)
      },
      previous,
    )
  }
})

/**
 * 验证：同一帧连续点击只产生一次按钮或弹窗成功回调。
 */
test('同一帧连续点击只产生一次按钮或弹窗成功回调', async () => {
  await page.reload()
  await page.getByRole('link', { name: '通用组件', exact: true }).click()
  await page.getByRole('textbox', { name: '示例名称' }).fill('同步防重复测试')
  // submit：本地表单提交按钮 locator，用于同一帧双击回归。
  const submit = page.getByRole('button', { name: '校验并本地提交', exact: true })
  await submit.evaluate(
    /**
     * 在一个同步回调里连续点击表单提交两次。
     * element：locator 指向的真实 DOM 元素，在 renderer 内测量或触发同帧点击。
     */
    (element) => {
      element.click()
      element.click()
    },
  )
  await expect(submit).toBeEnabled()
  await expect(page.getByText('本地示例提交完成', { exact: true })).toHaveCount(1)
  await page.reload()
  await page.getByRole('button', { name: '打开弹窗', exact: true }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '保存', exact: true })
    .evaluate(
      /**
       * 在一个同步回调里连续点击弹窗保存两次。
       * element：locator 指向的真实 DOM 元素，在 renderer 内测量或触发同帧点击。
       */
      (element) => {
        element.click()
        element.click()
      },
    )
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText('本地示例提交完成', { exact: true })).toHaveCount(1)
})

/**
 * 验证：最小化恢复与 macOS 无窗口时的重新打开。
 */
test('最小化恢复与 macOS 无窗口时的重新打开', async () => {
  await app.evaluate(
    /**
     * 最小化当前窗口并模拟第二实例激活。
     * BrowserWindow：Electron 提供的窗口类，在主进程读取真实窗口状态。
     * app：测试进程 Electron app，用于模拟第二实例激活。
     */
    ({ BrowserWindow, app }) => {
      BrowserWindow.getAllWindows()[0].minimize()
      app.emit('second-instance')
    },
  )
  await expect
    .poll(
      /**
       * 轮询真实原生窗口是否已恢复最小化状态。
       */
      () =>
        app.evaluate(
          /**
           * 轮询真实原生窗口是否已恢复最小化状态。
           * BrowserWindow：Electron 提供的窗口类，在主进程读取真实窗口状态。
           */
          ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized(),
        ),
    )
    .toBe(false)
  if (process.platform === 'darwin') {
    // reopened：等待 macOS 关闭所有窗口后新建窗口的事件 Promise。
    const reopened = app.waitForEvent('window')
    await app.evaluate(
      /**
       * 关闭 macOS 当前最后窗口，验证应用仍能重建窗口。
       * BrowserWindow：Electron 提供的窗口类，在主进程读取真实窗口状态。
       */
      ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close(),
    )
    await app.evaluate(
      /**
       * 在无窗口状态触发应用激活。
       * app：测试进程 Electron app，用于无窗口时发出激活。
       */
      ({ app }) => app.emit('second-instance'),
    )
    page = await reopened
    await expect(page.getByRole('heading', { name: '框架概览', exact: true })).toBeVisible()
  }
})

/**
 * 验证：损坏的窗口尺寸回退默认值并给出可见告警。
 */
test('损坏的窗口尺寸回退默认值并给出可见告警', async () => {
  // directory：本用例独占的系统临时目录，结束时递归清理。
  const directory = await mkdtemp(join(tmpdir(), 'desktop-corrupt-bounds-'))
  await writeFile(
    join(directory, 'window.json'),
    JSON.stringify({ x: 0, y: 0, width: -1, height: 500 }),
  )
  // isolated：损坏配置用例单独启动的 Electron 应用句柄。
  let isolated
  try {
    isolated = await electron.launch({
      args: ['.'],
      env: { ...process.env, DESKTOP_TEST_USER_DATA: directory },
    })
    // isolatedPage：损坏配置用例的真实 renderer 窗口。
    const isolatedPage = await isolated.firstWindow()
    await expect(isolatedPage.getByRole('heading', { name: '框架概览', exact: true })).toBeVisible()
    // result：固定桌面桥返回的信封，断言其公开状态而非猜测成功。
    const result = await isolatedPage.evaluate(
      /**
       * 读取损坏配置启动时的公开存储警告。
       */
      () => window.desktop.info(),
    )
    expect(result.data.storageWarning).toContain('本地设置无法读取')
    expect(
      await realpath(
        await isolated.evaluate(
          /**
           * 查询隔离应用实际日志目录，检查环境目录隔离生效。
           * app：隔离应用的 Electron app，仅查询其日志目录。
           */
          ({ app }) => app.getPath('logs'),
        ),
      ),
    ).toBe(await realpath(join(directory, 'logs')))
  } finally {
    await isolated?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

/**
 * 验证：普通外观设置不修改系统启动项，仅显式开关触发系统接口。
 */
test('普通外观设置不修改系统启动项，仅显式开关触发系统接口', async () => {
  await app.evaluate(
    /**
     * 保存原启动项接口，安装仅写测试内存的替身。
     * app：隔离测试进程的 Electron app，临时替换启动项方法。
     */
    ({ app }) => {
      // original：启动项接口和 isPackaged 属性的原始引用/描述符，finally 恢复。
      const original = {
        descriptor: Object.getOwnPropertyDescriptor(app, 'isPackaged'),
        get: app.getLoginItemSettings,
        set: app.setLoginItemSettings,
      }
      globalThis.loginTest = { original, calls: [], enabled: true }
      Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })
      app.getLoginItemSettings =
        /**
         * 返回测试控制的系统实际启动项状态。
         */
        () => ({ openAtLogin: globalThis.loginTest.enabled })
      app.setLoginItemSettings =
        /**
         * 记录显式启动项写入，更新仅测试内存的状态。
         * value：系统启动项写入替身收到的 {openAtLogin} 参数。
         */
        (value) => {
          globalThis.loginTest.calls.push(value)
          globalThis.loginTest.enabled = value.openAtLogin
        }
    },
  )
  try {
    // snapshot：系统启动项替身状态映射到偏好的公开快照。
    const snapshot = await page.evaluate(
      /**
       * 读取会反映系统实际启动项的偏好快照。
       */
      () => window.desktop.preferences.get(),
    )
    expect(snapshot.data.launchAtLogin).toBe(true)
    expect(
      (
        await page.evaluate(
          /**
           * 只变更外观主题，不能触发启动项写入。
           */
          () => window.desktop.preferences.set({ theme: 'light' }),
        )
      ).ok,
    ).toBe(true)
    expect(
      await app.evaluate(
        /**
         * 读取启动项写入次数，普通外观修改后必须为零。
         */
        () => globalThis.loginTest.calls.length,
      ),
    ).toBe(0)
    expect(
      (
        await page.evaluate(
          /**
           * 显式关闭启动项，应触发恰好一次系统接口。
           */
          () => window.desktop.preferences.set({ launchAtLogin: false }),
        )
      ).ok,
    ).toBe(true)
    expect(
      await app.evaluate(
        /**
         * 读取启动项替身记录的完整写入序列。
         */
        () => globalThis.loginTest.calls,
      ),
    ).toEqual([{ openAtLogin: false }])
  } finally {
    await app.evaluate(
      /**
       * 恢复原启动项接口和 isPackaged 属性，清理测试标记。
       * app：待恢复原启动项接口的隔离 Electron app。
       */
      ({ app }) => {
        // original：启动项接口和 isPackaged 属性的原始引用/描述符，finally 恢复。
        const original = globalThis.loginTest.original
        if (original.descriptor) Object.defineProperty(app, 'isPackaged', original.descriptor)
        else delete app.isPackaged
        app.getLoginItemSettings = original.get
        app.setLoginItemSettings = original.set
        delete globalThis.loginTest
      },
    )
  }
})
