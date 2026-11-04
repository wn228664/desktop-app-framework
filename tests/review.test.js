import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, stat, rename, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reactive } from 'vue'
import { Tasks } from '../src/main/services/tasks.js'
import { FileGrants } from '../src/main/services/file-grants.js'
import { record, trustedUrl } from '../src/shared/validation.js'
import { resolveRuntimeConfig, windowBounds } from '../src/shared/config.js'
import { compareValues } from '../src/renderer/src/core/table.js'
import { request } from '../src/renderer/src/core/desktop.js'
import builderConfig from '../electron-builder.cjs'
import updaterPackage from 'electron-updater'
import { createPinia, setActivePinia } from 'pinia'
import { useTasks } from '../src/renderer/src/stores/tasks.js'

/**
 * 关键边界回归：观察者失败、上下文清理、并发授权、替换文件、配置白名单和 UI 快照。
 * NSIS 测试调用真实 updater 的元数据解析链，但签名回调为替身，不声称已验证 Windows 证书。
 * 对 global window、环境变量和 Pinia 的替换必须在各测试结束时恢复，避免相互污染。
 *
 * 验证：关闭任务上下文后不再推送进度，也不会恢复已清理的历史。
 */
test('关闭任务上下文后不再推送进度，也不会恢复已清理的历史', async () => {
  // complete：旧上下文任务的迟到成功入口。
  let complete
  // progress：保存的任务进度发布函数，clear 之后不应再产生观察事件。
  let progress
  // events：按调用顺序收集的公开任务事件。
  const events = []
  // tasks：当前用例独占的任务表，不连接真实窗口。
  const tasks = new Tasks(
    /**
     * 收集任务事件，不让取消后进度悄悄恢复旧历史。
     * _owner：当前用例不使用的观察归属窗口。
     * event：当前公开任务事件，记录事件数量而不读私有载荷。
     */
    (_owner, event) => events.push(event),
  )
  // operation：已启动但尚未结算的旧上下文任务 Promise。
  const operation = tasks.run(
    1,
    'review-clear-001',
    'test',
    /**
     * 保存旧任务进度并等待人工完成，故意不响应 signal。
     * _signal：此迟到任务故意忽略的 signal，用于验证版本和上下文隔离。
     * update：任务表提供的进度发布器，clear 后必须无效。
     */
    (_signal, update) => {
      progress = update
      return new Promise(
        /**
         * 保存迟到完成入口。
         * resolve：受控等待的成功入口，由本用例主动结算。
         */
        (resolve) => {
          complete = resolve
        },
      )
    },
  )
  tasks.clear(1)
  assert.deepEqual(tasks.list(1), [])
  // count：clear 完成后的事件数，迟到进度不能使其增加。
  const count = events.length
  progress({ completed: 10 })
  complete('late')
  await assert.rejects(operation, { code: 'CANCELLED' })
  assert.equal(events.length, count)
  assert.deepEqual(tasks.list(1), [])
  assert.equal(
    await tasks.run(
      1,
      'review-clear-002',
      'test',
      /**
       * 新上下文返回明确成功结果，验证 clear 不会永久禁用窗口。
       */
      async () => 'new',
    ),
    'new',
  )
})

/**
 * 验证：进度观察者抛异常不污染任务结果或泄漏并发槽位。
 */
test('进度观察者抛异常不污染任务结果或泄漏并发槽位', async () => {
  // tasks：当前用例独占的任务表，不连接真实窗口。
  const tasks = new Tasks(
    /**
     * 模拟窗口已关闭时观察器投递抛错。
     */
    () => {
      throw new Error('renderer closed')
    },
  )
  // index：回归循环零基序号，生成独立任务 ID。
  for (let index = 0; index < 10; index++) {
    assert.equal(
      await tasks.run(
        1,
        `review-notify-${index}`,
        'test',
        /**
         * 返回当前循环结果，检查观察错误没有污染任务结算。
         */
        async () => index,
      ),
      index,
    )
  }
  assert.equal(
    tasks.list(1).some(
      /**
       * 查找泄漏的 running 状态，预期不存在。
       * task：当前公开任务快照，按 running 状态或 id 验证历史保留。
       */
      (task) => task.status === 'running',
    ),
    false,
  )
})

/**
 * 验证：文件授权不能被同路径、同尺寸、同时间的替换文件复用。
 * t：Node 测试上下文，注册 finally 等价的清理与全局替身恢复。
 */
test('文件授权不能被同路径、同尺寸、同时间的替换文件复用', async (t) => {
  // directory：本用例独占的系统临时目录，结束时递归清理。
  const directory = await mkdtemp(join(tmpdir(), 'desktop-grant-review-'))
  t.after(
    /**
     * 清理文件替换回归的临时目录。
     */
    () => rm(directory, { recursive: true, force: true }),
  )
  // path：本用例使用的临时文件路径，不读取或覆盖用户原文件。
  const path = join(directory, 'original.txt')
  // replacement：用于替换已授权原路径的新文件，大小和 mtime 故意相同。
  const replacement = join(directory, 'replacement.txt')
  await writeFile(path, 'original')
  await utimes(path, 2000, 2000)
  // grants：仅授予本用例临时文件的授权表。
  const grants = new FileGrants()
  // file：本用例窗口持有的不透明文件授权。
  const file = await grants.add(1, path)
  // before：替换前原文件的身份快照。
  const before = await stat(path)
  await writeFile(replacement, 'replaced')
  await utimes(replacement, 2000, 2000)
  await rename(replacement, path)
  // after：同路径新文件的身份快照，inode 差异必须被检测。
  const after = await stat(path)
  assert.equal(after.size, before.size)
  assert.equal(after.mtimeMs, before.mtimeMs)
  await assert.rejects(grants.read(1, file.id), { code: 'FILE_CHANGED' })
})

/**
 * 验证：文件并发授权有总量限制，清理中的授权不会迟到恢复。
 * t：Node 测试上下文，注册 finally 等价的清理与全局替身恢复。
 */
test('文件并发授权有总量限制，清理中的授权不会迟到恢复', async (t) => {
  // directory：本用例独占的系统临时目录，结束时递归清理。
  const directory = await mkdtemp(join(tmpdir(), 'desktop-grant-limit-'))
  t.after(
    /**
     * 清理并发授权回归的临时目录。
     */
    () => rm(directory, { recursive: true, force: true }),
  )
  // path：本用例使用的临时文件路径，不读取或覆盖用户原文件。
  const path = join(directory, 'file.txt')
  await writeFile(path, 'x')
  // grants：仅授予本用例临时文件的授权表。
  const grants = new FileGrants()
  // results：110 次并发文件授权的全部结算结果。
  const results = await Promise.allSettled(
    Array.from(
      { length: 110 },
      /**
       * 并发申请同一测试文件授权，验证预占也计入总额。
       */
      () => grants.add(1, path),
    ),
  )
  assert.equal(
    results.filter(
      /**
       * 统计成功授权数，必须严格等于上限 100。
       * result：被测请求返回的 Promise 或授权结算项，按所在断言核验。
       */
      (result) => result.status === 'fulfilled',
    ).length,
    100,
  )
  grants.clear(1)
  // pending：创建后立刻被 clear 撤销的等待授权。
  const pending = grants.add(1, path)
  grants.clear(1)
  await assert.rejects(pending, { code: 'FILE_GRANT_EXPIRED' })
})

/**
 * 验证：普通对象与窗口尺寸验证拒绝错误类型、负尺寸和异常坐标。
 */
test('普通对象与窗口尺寸验证拒绝错误类型、负尺寸和异常坐标', () => {
  // value：故意非法的记录类型或窗口几何，用于验证输入契约。
  for (const value of [new Date(), new Map(), new Set(), [], null])
    assert.throws(
      /**
       * 以非法记录输入触发校验失败。
       */
      () => record(value),
    )
  // value：故意非法的记录类型或窗口几何，用于验证输入契约。
  for (const value of [
    { x: 0, y: 0, width: -1, height: 500 },
    { x: 0.5, y: 0, width: 800, height: 600 },
    { x: 1e20, y: 0, width: 800, height: 600 },
  ])
    assert.throws(
      /**
       * 以非法几何输入触发校验失败。
       */
      () => windowBounds(value),
    )
  assert.deepEqual(windowBounds({ x: -800, y: 0, width: 800, height: 600 }), {
    x: -800,
    y: 0,
    width: 800,
    height: 600,
  })
  assert.throws(
    /**
     * 以畸形 URL 触发公开参数错误。
     */
    () => trustedUrl('not a URL'),
    { code: 'INVALID_ARGUMENT' },
  )
})

/**
 * 验证：只编译公开配置，拒绝错误来源白名单、基址和未声明的更新身份。
 */
test('只编译公开配置，拒绝错误来源白名单、基址和未声明的更新身份', () => {
  // config：过滤后只含公开键的构建配置。
  const config = resolveRuntimeConfig({
    DESKTOP_API_BASE_URL: 'https://example.com/api/',
    DESKTOP_SECRET: 'must-not-be-compiled',
  })
  assert.equal(config.DESKTOP_SECRET, undefined)
  assert.equal(config.DESKTOP_API_BASE_URL, 'https://example.com/api/')
  // environment：应被拒绝的来源/发布身份配置样本。
  for (const environment of [
    { DESKTOP_DOWNLOAD_ORIGINS: 'https://example.com/private' },
    { DESKTOP_API_BASE_URL: 'https://example.com/api/?key=value' },
    { DESKTOP_UPDATE_URL: 'https://example.com/releases/' },
    {
      DESKTOP_UPDATE_URL: 'https://example.com/releases/?token=value',
      DESKTOP_UPDATE_PUBLISHER: 'Test Publisher',
    },
    { DESKTOP_API_BASE_URL: 'http://127.0.0.1:1234' },
  ])
    assert.throws(
      /**
       * 尝试不符合来源或发布身份合同的构建配置。
       */
      () => resolveRuntimeConfig(environment),
    )
  assert.equal(
    resolveRuntimeConfig({ DESKTOP_API_BASE_URL: 'http://127.0.0.1:1234' }, true)
      .DESKTOP_API_BASE_URL,
    'http://127.0.0.1:1234',
  )
})

/**
 * 验证：更新构建必须签名，发布者会进入 Windows 配置；本地构建不自动发布。
 * t：Node 测试上下文，注册 finally 等价的清理与全局替身恢复。
 */
test('更新构建必须签名，发布者会进入 Windows 配置；本地构建不自动发布', async (t) => {
  // keys：用例会临时替换的三个公开发布环境变量名。
  const keys = ['DESKTOP_UPDATE_URL', 'DESKTOP_UPDATE_PUBLISHER', 'DESKTOP_MAC_SIGN_IDENTITY']
  // previous：替换前的环境变量或 global window 状态，结束时精确恢复。
  const previous = Object.fromEntries(
    keys.map(
      /**
       * 保存当前环境变量值，不把进程其他环境写入报告。
       * key：当前待保存、删除或恢复的环境变量名。
       */
      (key) => [key, process.env[key]],
    ),
  )
  t.after(
    /**
     * 精确恢复被测试替换的发布环境键。
     */
    () => {
      // key：当前待保存、删除或恢复的环境变量名。
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key]
        else process.env[key] = previous[key]
      }
    },
  )
  // key：当前待保存、删除或恢复的环境变量名。
  for (const key of keys) delete process.env[key]
  // local：缺少更新地址时的本地 builder 配置。
  const local = await builderConfig()
  assert.equal(local.publish, null)
  assert.equal(local.mac.identity, null)
  process.env.DESKTOP_UPDATE_URL = 'https://example.com/releases/'
  process.env.DESKTOP_UPDATE_PUBLISHER = 'Framework Test Publisher'
  // release：显式声明更新来源和发布者后的正式 builder 配置。
  const release = await builderConfig()
  assert.equal(release.forceCodeSigning, true)
  assert.deepEqual(release.publish, { provider: 'generic', url: 'https://example.com/releases/' })
  assert.deepEqual(release.win.publisherName, ['Framework Test Publisher'])
})

/**
 * 验证：真实 NSIS updater 从元数据读取 publisherName 并调用签名验证。
 * t：Node 测试上下文，注册 finally 等价的清理与全局替身恢复。
 */
test('真实 NSIS updater 从元数据读取 publisherName 并调用签名验证', async (t) => {
  // directory：本用例独占的系统临时目录，结束时递归清理。
  const directory = await mkdtemp(join(tmpdir(), 'desktop-update-policy-'))
  t.after(
    /**
     * 清理测试更新元数据目录。
     */
    () => rm(directory, { recursive: true, force: true }),
  )
  // path：本用例使用的临时文件路径，不读取或覆盖用户原文件。
  const path = join(directory, 'app-update.yml')
  await writeFile(
    path,
    JSON.stringify({
      provider: 'generic',
      url: 'https://example.com/releases/',
      publisherName: ['Framework Test Publisher'],
    }),
  )
  // updater：仅供当前用例使用的更新器事件/行为替身。
  const updater = new updaterPackage.NsisUpdater(null, {
    version: '1.0.0',
    appUpdateConfigPath: path,
  })
  // invoked：签名校验替身是否被 NSIS 元数据链调用。
  let invoked = false
  updater.verifyUpdateCodeSignature =
    /**
     * 核对真实 NSIS 解析的发布者与假文件名，替代实际证书校验。
     * publishers：真实 updater 从测试元数据解析到的发布者名称数组。
     * executable：签名校验接收的假安装文件名，不执行真实可执行文件。
     */
    async (publishers, executable) => {
      invoked = true
      assert.deepEqual(publishers, ['Framework Test Publisher'])
      assert.equal(executable, 'test-only.exe')
      return null
    }
  await updater.verifySignature('test-only.exe')
  assert.equal(invoked, true)
})

/**
 * 验证：数字、日期与自然文字排序不丢失数据类型。
 */
test('数字、日期与自然文字排序不丢失数据类型', () => {
  assert.deepEqual([2.5, 2.12, -1, -10].sort(compareValues), [-10, -1, 2.12, 2.5])
  assert.deepEqual(['item10', 'item2'].sort(compareValues), ['item2', 'item10'])
  assert.equal(compareValues(new Date('2020-01-01'), new Date('2021-01-01')), -1)
  assert.equal(compareValues(null, 0), 1)
})

/**
 * 验证：Vue 响应式请求体先取快照，避免 IPC 克隆失败与发送后被输入覆盖。
 * t：Node 测试上下文，注册 finally 等价的清理与全局替身恢复。
 */
test('Vue 响应式请求体先取快照，避免 IPC 克隆失败与发送后被输入覆盖', async (t) => {
  // previous：替换前的环境变量或 global window 状态，结束时精确恢复。
  const previous = globalThis.window
  t.after(
    /**
     * 恢复被替换的 global window，原本缺失则删除。
     */
    () => {
      if (previous === undefined) delete globalThis.window
      else globalThis.window = previous
    },
  )
  // captured：固定请求桥实际收到的可克隆参数快照。
  let captured
  globalThis.window = {
    desktop: {
      /**
       * 保存并实际 structuredClone 请求载荷，排除 Vue 代理直接跨 IPC。
       * payload：renderer 已规范为 JSON 快照的请求参数。
       */
      request: async (payload) => {
        captured = payload
        structuredClone(payload)
        return { ok: true, data: { success: true } }
      },
    },
  }
  // body：Vue 响应式请求草稿，发出后修改不得污染已发快照。
  const body = reactive({ label: 'before', nested: { enabled: true } })
  // result：被测请求返回的 Promise 或授权结算项，按所在断言核验。
  const result = request({ path: 'items', method: 'POST', body })
  body.label = 'after'
  assert.deepEqual(await result, { success: true })
  assert.equal(captured.body.label, 'before')
  // circular：故意循环引用的请求体，必须在 IPC 前拒绝。
  const circular = {}
  circular.self = circular
  assert.throws(
    /**
     * 尝试发送循环体，预期在 IPC 前明确拒绝。
     */
    () => request({ path: 'items', method: 'POST', body: circular }),
    {
      code: 'INVALID_ARGUMENT',
    },
  )
})

/**
 * 验证：任务 UI 不恢复重置前快照，历史达到上限时仍保留进行中任务。
 * t：Node 测试上下文，注册 finally 等价的清理与全局替身恢复。
 */
test('任务 UI 不恢复重置前快照，历史达到上限时仍保留进行中任务', async (t) => {
  // previous：替换前的环境变量或 global window 状态，结束时精确恢复。
  const previous = globalThis.window
  t.after(
    /**
     * 恢复任务投影用例前的 global window。
     */
    () => {
      if (previous === undefined) delete globalThis.window
      else globalThis.window = previous
    },
  )
  // listener：任务 subscribe 替身保存的公开事件回调。
  let listener
  // resolveSnapshot：任务列表快照 Promise 的完成入口，reset 后注入旧快照。
  let resolveSnapshot
  globalThis.window = {
    desktop: {
      tasks: {
        /**
         * 保存任务订阅回调，并提供可调用的清理器。
         * callback：store 提供给平台 subscribe 的更新函数。
         */
        subscribe: (callback) => {
          listener = callback
          return (
            /**
             * 任务订阅替身清理器，不关联真实平台资源。
             */
            () => {}
          )
        },
        /**
         * 延迟返回任务列表快照以制造 reset 与初始化竞态。
         */
        list: () =>
          new Promise(
            /**
             * 保存旧快照的完成入口。
             * resolve：受控等待的成功入口，由本用例主动结算。
             */
            (resolve) => {
              resolveSnapshot = resolve
            },
          ),
      },
    },
  }
  setActivePinia(createPinia())
  // store：当前独立 Pinia 中的任务投影 store。
  const store = useTasks()
  t.after(
    /**
     * 用例结束销毁当前 Pinia store。
     */
    () => store.$dispose(),
  )
  // connected：尚未完成的任务连接 Promise。
  const connected = store.connect()
  listener({ type: 'reset' })
  resolveSnapshot({ ok: true, data: [{ id: 'old-task', status: 'running' }] })
  // unsubscribe：连接成功返回的清理器，由测试 after 统一调用。
  const unsubscribe = await connected
  t.after(unsubscribe)
  assert.deepEqual(store.items, [])
  listener({ id: 'active-task', status: 'running' })
  // index：回归循环零基序号，生成独立任务 ID。
  for (let index = 0; index < 55; index++) listener({ id: `completed-${index}`, status: 'success' })
  assert.equal(
    store.items.some(
      /**
       * 查找运行任务，历史达到上限时仍必须保留。
       * task：当前公开任务快照，按 running 状态或 id 验证历史保留。
       */
      (task) => task.id === 'active-task',
    ),
    true,
  )
  assert.equal(
    store.items.filter(
      /**
       * 统计非运行任务，确认只保留 50 条完成历史。
       * task：当前公开任务快照，按 running 状态或 id 验证历史保留。
       */
      (task) => task.status !== 'running',
    ).length,
    50,
  )
  listener({ type: 'reset' })
  assert.deepEqual(store.items, [])
})
