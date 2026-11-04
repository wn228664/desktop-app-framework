import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonStore } from '../src/main/services/storage.js'
import { FileGrants } from '../src/main/services/file-grants.js'
import { Credentials } from '../src/main/services/credentials.js'

/**
 * 存储测试使用独立临时目录，检查实际文件内容与失败行为。
 * 系统加密实现被注入替身，用于验证“何时持久化”，不把替身结果当 Keychain/DPAPI 实机证据。
 *
 * 创建独立临时目录并在测试结束时登记强制清理。
 * t：Node 测试上下文，注册 finally 等价的清理与全局替身恢复。
 */
async function fixture(t) {
  // 清理注册在测试上下文上，即使断言失败也不能把样例文件留进用户目录。
  // path：本用例使用的临时文件路径，不读取或覆盖用户原文件。
  const path = await mkdtemp(join(tmpdir(), 'desktop-unit-'))
  t.after(
    /**
     * 递归清理当前用例临时目录，即使断言失败也执行。
     */
    () => rm(path, { recursive: true, force: true }),
  )
  return path
}

/**
 * 验证：设置并发提交不丢字段，快照不可反向污染持久化。
 * t：Node 测试上下文，注册 finally 等价的清理与全局替身恢复。
 */
test('设置并发提交不丢字段，快照不可反向污染持久化', async (t) => {
  // path：本用例使用的临时文件路径，不读取或覆盖用户原文件。
  const path = join(await fixture(t), 'settings.json')
  // store：本用例独占的 JSON 或凭据存储，路径位于临时目录。
  const store = new JsonStore(path, { theme: 'light', compact: false })
  await store.load()
  await Promise.all([store.patch({ theme: 'dark' }), store.patch({ compact: true })])
  // value：get 返回的独立偏好副本，修改它不应改变持久化。
  const value = store.get()
  value.theme = 'wrong'
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { theme: 'dark', compact: true })
  assert.equal(store.get().theme, 'dark')
})

/**
 * 验证：损坏配置明确报告，不覆盖原文件。
 * t：Node 测试上下文，注册 finally 等价的清理与全局替身恢复。
 */
test('损坏配置明确报告，不覆盖原文件', async (t) => {
  // path：本用例使用的临时文件路径，不读取或覆盖用户原文件。
  const path = join(await fixture(t), 'settings.json')
  await writeFile(path, '{bad')
  // store：本用例独占的 JSON 或凭据存储，路径位于临时目录。
  const store = new JsonStore(path, {})
  await assert.rejects(store.load(), { code: 'STORAGE_CORRUPT' })
  assert.equal(await readFile(path, 'utf8'), '{bad')
})

/**
 * 验证：文件授权拒绝跨窗口、撤销和文件变化，返回值不含路径。
 * t：Node 测试上下文，注册 finally 等价的清理与全局替身恢复。
 */
test('文件授权拒绝跨窗口、撤销和文件变化，返回值不含路径', async (t) => {
  // path：本用例使用的临时文件路径，不读取或覆盖用户原文件。
  const path = join(await fixture(t), 'text.txt')
  await writeFile(path, 'hello')
  // grants：仅授予本用例临时文件的授权表。
  const grants = new FileGrants()
  // file：本用例窗口持有的不透明文件授权。
  const file = await grants.add(1, path)
  assert.equal(file.path, undefined)
  assert.equal((await grants.read(1, file.id)).data.toString(), 'hello')
  await assert.rejects(grants.read(2, file.id), { code: 'FILE_GRANT_EXPIRED' })
  await assert.rejects(grants.read(1, file.id, 1), /限制/)
  await writeFile(path, 'changed')
  await assert.rejects(grants.read(1, file.id), { code: 'FILE_CHANGED' })
  grants.clear(1)
  await assert.rejects(grants.read(1, file.id), { code: 'FILE_GRANT_EXPIRED' })
})

/**
 * 验证：凭据默认仅内存，显式记住才加密，拒绝明文降级。
 * t：Node 测试上下文，注册 finally 等价的清理与全局替身恢复。
 */
test('凭据默认仅内存，显式记住才加密，拒绝明文降级', async (t) => {
  // path：本用例使用的临时文件路径，不读取或覆盖用户原文件。
  const path = join(await fixture(t), 'credential.bin')
  // crypto：可重复的本地加解密替身，不代表系统 Keychain/DPAPI 验收。
  const crypto = {
    /**
     * 模拟系统异步加密能力可用。
     */
    isAsyncEncryptionAvailable: async () => true,
    /**
     * 生成可识别前缀的测试密文，不访问真实系统钥匙串。
     * value：替身加密函数收到的测试令牌，编码为带前缀 Buffer。
     */
    encryptStringAsync: async (value) => Buffer.from(`encrypted:${value}`),
    /**
     * 从测试密文还原令牌并声明无需重新加密。
     * value：替身解密函数收到的测试密文 Buffer。
     */
    decryptStringAsync: async (value) => ({
      result: value.toString().slice(10),
      shouldReEncrypt: false,
    }),
  }
  // store：本用例独占的 JSON 或凭据存储，路径位于临时目录。
  const store = new Credentials(path, crypto)
  await store.set('temporary')
  assert.equal(store.token, 'temporary')
  await assert.rejects(readFile(path), { code: 'ENOENT' })
  await store.set('remembered', true)
  // restored：从同一临时密文文件恢复的新凭据实例。
  const restored = new Credentials(path, crypto)
  await restored.load()
  assert.equal(restored.token, 'remembered')
  crypto.isAsyncEncryptionAvailable =
    /**
     * 模拟系统加密不可用，验证拒绝明文降级。
     */
    async () => false
  await assert.rejects(store.set('must-not-save', true), { code: 'ENCRYPTION_UNAVAILABLE' })
  assert.equal(store.token, 'remembered')
  await store.set('')
  await assert.rejects(readFile(path), { code: 'ENOENT' })
})
