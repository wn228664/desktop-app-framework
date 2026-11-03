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
 */
async function fixture(t) {
  // 清理注册在测试上下文上，即使断言失败也不能把样例文件留进用户目录。
  const path = await mkdtemp(join(tmpdir(), 'desktop-unit-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

test('设置并发提交不丢字段，快照不可反向污染持久化', async (t) => {
  const path = join(await fixture(t), 'settings.json')
  const store = new JsonStore(path, { theme: 'light', compact: false })
  await store.load()
  await Promise.all([store.patch({ theme: 'dark' }), store.patch({ compact: true })])
  const value = store.get()
  value.theme = 'wrong'
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { theme: 'dark', compact: true })
  assert.equal(store.get().theme, 'dark')
})

test('损坏配置明确报告，不覆盖原文件', async (t) => {
  const path = join(await fixture(t), 'settings.json')
  await writeFile(path, '{bad')
  const store = new JsonStore(path, {})
  await assert.rejects(store.load(), { code: 'STORAGE_CORRUPT' })
  assert.equal(await readFile(path, 'utf8'), '{bad')
})

test('文件授权拒绝跨窗口、撤销和文件变化，返回值不含路径', async (t) => {
  const path = join(await fixture(t), 'text.txt')
  await writeFile(path, 'hello')
  const grants = new FileGrants()
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

test('凭据默认仅内存，显式记住才加密，拒绝明文降级', async (t) => {
  const path = join(await fixture(t), 'credential.bin')
  const crypto = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value) => Buffer.from(`encrypted:${value}`),
    decryptStringAsync: async (value) => ({
      result: value.toString().slice(10),
      shouldReEncrypt: false,
    }),
  }
  const store = new Credentials(path, crypto)
  await store.set('temporary')
  assert.equal(store.token, 'temporary')
  await assert.rejects(readFile(path), { code: 'ENOENT' })
  await store.set('remembered', true)
  const restored = new Credentials(path, crypto)
  await restored.load()
  assert.equal(restored.token, 'remembered')
  crypto.isAsyncEncryptionAvailable = async () => false
  await assert.rejects(store.set('must-not-save', true), { code: 'ENCRYPTION_UNAVAILABLE' })
  assert.equal(store.token, 'remembered')
  await store.set('')
  await assert.rejects(readFile(path), { code: 'ENOENT' })
})
