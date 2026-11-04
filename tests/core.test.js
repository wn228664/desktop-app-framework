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

/**
 * 验证：动作重复调用共用任务，取消后的旧结果不能覆盖新任务。
 */
test('动作重复调用共用任务，取消后的旧结果不能覆盖新任务', async () => {
  // release：旧动作等待任务的完成入口，取消后注入迟到成功。
  let release
  // states：动作观察器收到的状态序列。
  const states = []
  // action：当前用例独占的异步动作控制器。
  const action = createAsyncAction(
    /**
     * 收集动作状态，断言最终 pending 已归还。
     * state：本用例收到的公开状态快照。
     */
    (state) => states.push(state),
  )
  // first：先启动后取消的旧动作 Promise。
  const first = action.run(
    /**
     * 保持旧动作等待，交由用例决定迟到完成。
     */
    () =>
      new Promise(
        /**
         * 保存旧动作的完成入口。
         * resolve：受控等待的成功入口，由本用例主动结算。
         */
        (resolve) => {
          release = resolve
        },
      ),
  )
  assert.equal(
    first,
    action.run(
      /**
       * 若互斥失败而启动重复副作用则立即失败。
       */
      () => assert.fail('不能重复执行'),
    ),
  )
  await Promise.resolve()
  action.cancel()
  // second：取消后启动的新动作 Promise。
  const second = action.run(
    /**
     * 返回新周期的明确结果。
     */
    async () => 'new',
  )
  release('old')
  await assert.rejects(first, { name: 'AbortError' })
  assert.equal(await second, 'new')
  assert.equal(states.at(-1).pending, false)
  action.dispose()
  await assert.rejects(
    action.run(
      /**
       * 销毁后不应启动的动作替身。
       */
      async () => {},
    ),
    /销毁/,
  )
})

/**
 * 验证：动作失败可以重试，可取消延时及时结束。
 */
test('动作失败可以重试，可取消延时及时结束', async () => {
  // action：当前用例独占的异步动作控制器。
  const action = createAsyncAction()
  await assert.rejects(
    action.run(
      /**
       * 模拟动作失败以验证重试。
       */
      async () => {
        throw new Error('expected')
      },
    ),
    /expected/,
  )
  assert.equal(
    await action.run(
      /**
       * 提供失败之后的重试成功结果。
       */
      async () => 1,
    ),
    1,
  )
  // controller：本次等待或流的控制器，用于验证取消或注入流错误。
  const controller = new AbortController()
  // promise：已启动的可取消延迟 Promise。
  const promise = delay(10_000, controller.signal)
  controller.abort()
  await assert.rejects(promise, { name: 'AbortError' })
})

/**
 * 验证：偏好白名单拒绝未知键和无效缩放。
 */
test('偏好白名单拒绝未知键和无效缩放', () => {
  assert.deepEqual(preferencesPatch({ theme: 'dark', zoom: 1.25 }), { theme: 'dark', zoom: 1.25 })
  // value：应被偏好校验拒绝的未知键或非法值。
  for (const value of [{ theme: 'unknown' }, { zoom: 9 }, { token: 'secret' }, { compact: 'true' }])
    assert.throws(
      /**
       * 校验当前非法偏好对象，预期抛出。
       */
      () => preferencesPatch(value),
    )
})

/**
 * 验证：API 路径限制在固定基址下，禁止越权与协议注入。
 */
test('API 路径限制在固定基址下，禁止越权与协议注入', () => {
  assert.equal(
    apiUrl('https://example.com/api/', '/items?page=1').href,
    'https://example.com/api/items?page=1',
  )
  // path：本用例使用的临时文件路径，不读取或覆盖用户原文件。
  for (const path of [
    'https://evil.test/',
    '//evil.test/',
    '../secret',
    '%2e%2e/secret',
    '\\evil.test',
    'items#hash',
  ])
    assert.throws(
      /**
       * 尝试当前危险 API 路径，预期拒绝。
       */
      () => apiUrl('https://example.com/api/', path),
    )
  assert.throws(
    /**
     * 未配置 API 基址时预期明确失败。
     */
    () => apiUrl('', '/items'),
    { code: 'NOT_CONFIGURED' },
  )
  assert.throws(
    /**
     * 拒绝普通站外 HTTP 来源。
     */
    () => trustedUrl('http://example.com'),
  )
  assert.equal(trustedUrl('http://127.0.0.1:1234', true).hostname, '127.0.0.1')
})

/**
 * 验证：IPC 只允许可信主框架，拒绝 iframe、外部文档与其他窗口。
 */
test('IPC 只允许可信主框架，拒绝 iframe、外部文档与其他窗口', () => {
  // frame：被测 IPC 的主框架替身，URL hash 允许变化。
  const frame = { url: 'file:///app/index.html#/settings' }
  // sender：受信 webContents 替身，mainFrame 持有 frame。
  const sender = { mainFrame: frame }
  // window：受信且存活的窗口替身。
  const window = {
    webContents: sender,

    /**
     * 提供存活窗口状态，隔离文档与框架校验。
     */
    isDestroyed: () => false,
  }
  assert.doesNotThrow(
    /**
     * 以真实主框架和可信文档通过 IPC 校验。
     */
    () => assertSender({ sender, senderFrame: frame }, window, 'file:///app/index.html'),
  )
  assert.throws(
    /**
     * 用内容相同但引用不同的框架模拟 iframe，预期拒绝。
     */
    () => assertSender({ sender, senderFrame: { ...frame } }, window, 'file:///app/index.html'),
    { code: 'FORBIDDEN' },
  )
  frame.url = 'https://evil.test'
  assert.throws(
    /**
     * 主框架已导航到站外时预期拒绝 IPC。
     */
    () => assertSender({ sender, senderFrame: frame }, window, 'file:///app/index.html'),
  )
})

/**
 * 验证：格式化处理零值、空值、无效日期；公开错误不泄漏底层信息。
 */
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
