import test from 'node:test'
import assert from 'node:assert/strict'
import { createAsyncAction, delay } from '../src/renderer/src/core/async-action.js'
import {
  compactQuery,
  formatBytes,
  formatDate,
  isHttpsUrl,
} from '../src/renderer/src/core/format.js'
import { apiUrl, preferencesPatch, trustedUrl } from '../src/shared/validation.js'
import { publicError, AppError } from '../src/shared/errors.js'
import { assertSender } from '../src/main/security.js'

/** 纯契约测试：取消/旧结果、校验、格式化与 IPC 来源，不依赖真实系统窗口或业务服务。 */
test('动作重复调用共用任务，取消后的旧结果不能覆盖新任务', async () => {
  let release
  const states = []
  const action = createAsyncAction((state) => states.push(state))
  const first = action.run(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  assert.equal(
    first,
    action.run(() => assert.fail('不能重复执行')),
  )
  await Promise.resolve()
  action.cancel()
  const second = action.run(async () => 'new')
  release('old')
  await assert.rejects(first, { name: 'AbortError' })
  assert.equal(await second, 'new')
  assert.equal(states.at(-1).pending, false)
  action.dispose()
  await assert.rejects(
    action.run(async () => {}),
    /销毁/,
  )
})

test('动作失败可以重试，可取消延时及时结束', async () => {
  const action = createAsyncAction()
  await assert.rejects(
    action.run(async () => {
      throw new Error('expected')
    }),
    /expected/,
  )
  assert.equal(await action.run(async () => 1), 1)
  const controller = new AbortController()
  const promise = delay(10_000, controller.signal)
  controller.abort()
  await assert.rejects(promise, { name: 'AbortError' })
})

test('偏好白名单拒绝未知键和无效缩放', () => {
  assert.deepEqual(preferencesPatch({ theme: 'dark', zoom: 1.25 }), { theme: 'dark', zoom: 1.25 })
  for (const value of [{ theme: 'unknown' }, { zoom: 9 }, { token: 'secret' }, { compact: 'true' }])
    assert.throws(() => preferencesPatch(value))
})

test('API 路径限制在固定基址下，禁止越权与协议注入', () => {
  assert.equal(
    apiUrl('https://example.com/api/', '/items?page=1').href,
    'https://example.com/api/items?page=1',
  )
  for (const path of [
    'https://evil.test/',
    '//evil.test/',
    '../secret',
    '%2e%2e/secret',
    '\\evil.test',
    'items#hash',
  ])
    assert.throws(() => apiUrl('https://example.com/api/', path))
  assert.throws(() => apiUrl('', '/items'), { code: 'NOT_CONFIGURED' })
  assert.throws(() => trustedUrl('http://example.com'))
  assert.equal(trustedUrl('http://127.0.0.1:1234', true).hostname, '127.0.0.1')
})

test('IPC 只允许可信主框架，拒绝 iframe、外部文档与其他窗口', () => {
  const frame = { url: 'file:///app/index.html#/settings' }
  const sender = { mainFrame: frame }
  const window = { webContents: sender, isDestroyed: () => false }
  assert.doesNotThrow(() =>
    assertSender({ sender, senderFrame: frame }, window, 'file:///app/index.html'),
  )
  assert.throws(
    () => assertSender({ sender, senderFrame: { ...frame } }, window, 'file:///app/index.html'),
    { code: 'FORBIDDEN' },
  )
  frame.url = 'https://evil.test'
  assert.throws(() =>
    assertSender({ sender, senderFrame: frame }, window, 'file:///app/index.html'),
  )
})

test('格式化处理零值、空值、无效日期；公开错误不泄漏底层信息', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1024), '1 KiB')
  assert.equal(formatBytes(-1), '—')
  assert.equal(formatDate('bad date'), '—')
  assert.deepEqual(compactQuery({ a: '', b: false, c: 0, d: null }), { b: false, c: 0 })
  assert.equal(isHttpsUrl('https://user:password@example.com'), false)
  assert.equal(publicError(new Error('secret file path')).code, 'INTERNAL')
  assert.equal(publicError(new AppError('EXAMPLE', '可公开错误')).message, '可公开错误')
})
