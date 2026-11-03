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
 */
test('关闭任务上下文后不再推送进度，也不会恢复已清理的历史', async () => {
  let complete
  let progress
  const events = []
  const tasks = new Tasks((_owner, event) => events.push(event))
  const operation = tasks.run(1, 'review-clear-001', 'test', (_signal, update) => {
    progress = update
    return new Promise((resolve) => {
      complete = resolve
    })
  })
  tasks.clear(1)
  assert.deepEqual(tasks.list(1), [])
  const count = events.length
  progress({ completed: 10 })
  complete('late')
  await assert.rejects(operation, { code: 'CANCELLED' })
  assert.equal(events.length, count)
  assert.deepEqual(tasks.list(1), [])
  assert.equal(await tasks.run(1, 'review-clear-002', 'test', async () => 'new'), 'new')
})

test('进度观察者抛异常不污染任务结果或泄漏并发槽位', async () => {
  const tasks = new Tasks(() => {
    throw new Error('renderer closed')
  })
  for (let index = 0; index < 10; index++) {
    assert.equal(await tasks.run(1, `review-notify-${index}`, 'test', async () => index), index)
  }
  assert.equal(
    tasks.list(1).some((task) => task.status === 'running'),
    false,
  )
})

test('文件授权不能被同路径、同尺寸、同时间的替换文件复用', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-grant-review-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'original.txt')
  const replacement = join(directory, 'replacement.txt')
  await writeFile(path, 'original')
  await utimes(path, 2000, 2000)
  const grants = new FileGrants()
  const file = await grants.add(1, path)
  const before = await stat(path)
  await writeFile(replacement, 'replaced')
  await utimes(replacement, 2000, 2000)
  await rename(replacement, path)
  const after = await stat(path)
  assert.equal(after.size, before.size)
  assert.equal(after.mtimeMs, before.mtimeMs)
  await assert.rejects(grants.read(1, file.id), { code: 'FILE_CHANGED' })
})

test('文件并发授权有总量限制，清理中的授权不会迟到恢复', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-grant-limit-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'file.txt')
  await writeFile(path, 'x')
  const grants = new FileGrants()
  const results = await Promise.allSettled(Array.from({ length: 110 }, () => grants.add(1, path)))
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 100)
  grants.clear(1)
  const pending = grants.add(1, path)
  grants.clear(1)
  await assert.rejects(pending, { code: 'FILE_GRANT_EXPIRED' })
})

test('普通对象与窗口尺寸验证拒绝错误类型、负尺寸和异常坐标', () => {
  for (const value of [new Date(), new Map(), new Set(), [], null])
    assert.throws(() => record(value))
  for (const value of [
    { x: 0, y: 0, width: -1, height: 500 },
    { x: 0.5, y: 0, width: 800, height: 600 },
    { x: 1e20, y: 0, width: 800, height: 600 },
  ])
    assert.throws(() => windowBounds(value))
  assert.deepEqual(windowBounds({ x: -800, y: 0, width: 800, height: 600 }), {
    x: -800,
    y: 0,
    width: 800,
    height: 600,
  })
  assert.throws(() => trustedUrl('not a URL'), { code: 'INVALID_ARGUMENT' })
})

test('只编译公开配置，拒绝错误来源白名单、基址和未声明的更新身份', () => {
  const config = resolveRuntimeConfig({
    DESKTOP_API_BASE_URL: 'https://example.com/api/',
    DESKTOP_SECRET: 'must-not-be-compiled',
  })
  assert.equal(config.DESKTOP_SECRET, undefined)
  assert.equal(config.DESKTOP_API_BASE_URL, 'https://example.com/api/')
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
    assert.throws(() => resolveRuntimeConfig(environment))
  assert.equal(
    resolveRuntimeConfig({ DESKTOP_API_BASE_URL: 'http://127.0.0.1:1234' }, true)
      .DESKTOP_API_BASE_URL,
    'http://127.0.0.1:1234',
  )
})

test('更新构建必须签名，发布者会进入 Windows 配置；本地构建不自动发布', async (t) => {
  const keys = ['DESKTOP_UPDATE_URL', 'DESKTOP_UPDATE_PUBLISHER', 'DESKTOP_MAC_SIGN_IDENTITY']
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  })
  for (const key of keys) delete process.env[key]
  const local = await builderConfig()
  assert.equal(local.publish, null)
  assert.equal(local.mac.identity, null)
  process.env.DESKTOP_UPDATE_URL = 'https://example.com/releases/'
  process.env.DESKTOP_UPDATE_PUBLISHER = 'Framework Test Publisher'
  const release = await builderConfig()
  assert.equal(release.forceCodeSigning, true)
  assert.deepEqual(release.publish, { provider: 'generic', url: 'https://example.com/releases/' })
  assert.deepEqual(release.win.publisherName, ['Framework Test Publisher'])
})

test('真实 NSIS updater 从元数据读取 publisherName 并调用签名验证', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-update-policy-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'app-update.yml')
  await writeFile(
    path,
    JSON.stringify({
      provider: 'generic',
      url: 'https://example.com/releases/',
      publisherName: ['Framework Test Publisher'],
    }),
  )
  const updater = new updaterPackage.NsisUpdater(null, {
    version: '1.0.0',
    appUpdateConfigPath: path,
  })
  let invoked = false
  updater.verifyUpdateCodeSignature = async (publishers, executable) => {
    invoked = true
    assert.deepEqual(publishers, ['Framework Test Publisher'])
    assert.equal(executable, 'test-only.exe')
    return null
  }
  await updater.verifySignature('test-only.exe')
  assert.equal(invoked, true)
})

test('数字、日期与自然文字排序不丢失数据类型', () => {
  assert.deepEqual([2.5, 2.12, -1, -10].sort(compareValues), [-10, -1, 2.12, 2.5])
  assert.deepEqual(['item10', 'item2'].sort(compareValues), ['item2', 'item10'])
  assert.equal(compareValues(new Date('2020-01-01'), new Date('2021-01-01')), -1)
  assert.equal(compareValues(null, 0), 1)
})

test('Vue 响应式请求体先取快照，避免 IPC 克隆失败与发送后被输入覆盖', async (t) => {
  const previous = globalThis.window
  t.after(() => {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  })
  let captured
  globalThis.window = {
    desktop: {
      request: async (payload) => {
        captured = payload
        structuredClone(payload)
        return { ok: true, data: { success: true } }
      },
    },
  }
  const body = reactive({ label: 'before', nested: { enabled: true } })
  const result = request({ path: 'items', method: 'POST', body })
  body.label = 'after'
  assert.deepEqual(await result, { success: true })
  assert.equal(captured.body.label, 'before')
  const circular = {}
  circular.self = circular
  assert.throws(() => request({ path: 'items', method: 'POST', body: circular }), {
    code: 'INVALID_ARGUMENT',
  })
})

test('任务 UI 不恢复重置前快照，历史达到上限时仍保留进行中任务', async (t) => {
  const previous = globalThis.window
  t.after(() => {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  })
  let listener
  let resolveSnapshot
  globalThis.window = {
    desktop: {
      tasks: {
        subscribe: (callback) => {
          listener = callback
          return () => {}
        },
        list: () =>
          new Promise((resolve) => {
            resolveSnapshot = resolve
          }),
      },
    },
  }
  setActivePinia(createPinia())
  const store = useTasks()
  t.after(() => store.$dispose())
  const connected = store.connect()
  listener({ type: 'reset' })
  resolveSnapshot({ ok: true, data: [{ id: 'old-task', status: 'running' }] })
  const unsubscribe = await connected
  t.after(unsubscribe)
  assert.deepEqual(store.items, [])
  listener({ id: 'active-task', status: 'running' })
  for (let index = 0; index < 55; index++) listener({ id: `completed-${index}`, status: 'success' })
  assert.equal(
    store.items.some((task) => task.id === 'active-task'),
    true,
  )
  assert.equal(store.items.filter((task) => task.status !== 'running').length, 50)
  listener({ type: 'reset' })
  assert.deepEqual(store.items, [])
})
