import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Network, jsonResponse } from '../src/main/services/network.js'
import { FileGrants } from '../src/main/services/file-grants.js'
import { Tasks } from '../src/main/services/tasks.js'

/**
 * API/上传使用本机临时 HTTP 服务验证真实协议；下载来源与失败清理用受控响应流验证。
 * 所有令牌/文件内容都是测试样本，既不访问项目真实后端，也不读取用户选中文件。
 */
test('真实 HTTP 请求附加主进程凭据，取消任务与 HTTP 错误可识别', async (t) => {
  const server = createServer((request, response) => {
    if (request.url === '/api/slow') return
    if (request.url === '/api/error') {
      response.writeHead(401)
      response.end('private response')
      return
    }
    if (request.url === '/api/redirect') {
      response.writeHead(302, { Location: '/api/data' })
      response.end()
      return
    }
    response.setHeader('Content-Type', 'application/json')
    response.end(
      JSON.stringify({ authorization: request.headers.authorization, method: request.method }),
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const events = []
  const tasks = new Tasks((owner, event) => events.push({ owner, ...event }))
  const network = new Network(
    {
      apiBase: `http://127.0.0.1:${server.address().port}/api/`,
      development: true,
      downloadOrigins: [],
    },
    { token: 'unit-test-only' },
    new FileGrants(),
    tasks,
  )
  assert.deepEqual(await network.request(1, { id: 'request-001', path: 'data' }), {
    authorization: 'Bearer unit-test-only',
    method: 'GET',
  })
  await assert.rejects(network.request(1, { id: 'request-002', path: 'error' }), {
    code: 'HTTP_ERROR',
  })
  await assert.rejects(network.request(1, { id: 'request-003', path: 'redirect' }))
  const slow = network.request(1, { id: 'request-004', path: 'slow' })
  tasks.cancel(2, 'request-004')
  assert.equal(tasks.list(1).at(-1).status, 'running')
  tasks.cancel(1, 'request-004')
  await assert.rejects(slow, { code: 'CANCELLED' })
  assert.equal(events.at(-1).status, 'cancelled')
})

test('任务超时、重复 ID 和历史数量有界', async () => {
  const tasks = new Tasks(() => {})
  const pending = tasks.run(
    1,
    'timeout-001',
    'test',
    (signal) =>
      new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      ),
    10,
  )
  await assert.rejects(
    tasks.run(1, 'timeout-001', 'test', async () => {}),
    /重复/,
  )
  await assert.rejects(pending, { code: 'TIMEOUT' })
  for (let i = 0; i < 55; i++) await tasks.run(1, `history-${i}`, 'test', async () => {})
  assert.equal(tasks.list(1).length, 50)
  assert.equal(tasks.list(2).length, 0)
})

test('真实 multipart 上传使用授权文件、字段名和主进程凭据，拒绝跨窗口文件', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-upload-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'example.txt')
  await writeFile(path, 'upload fixture content')
  const grants = new FileGrants()
  const file = await grants.add(1, path)
  let received = null
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    received = {
      method: request.method,
      type: request.headers['content-type'],
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString(),
    }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ received: true }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const network = new Network(
    {
      apiBase: `http://127.0.0.1:${server.address().port}/`,
      development: true,
      downloadOrigins: [],
    },
    { token: 'upload-test-only' },
    grants,
    new Tasks(() => {}),
  )
  await assert.rejects(
    network.upload(2, { id: 'upload-wrong-owner', path: 'upload', fileId: file.id }),
    { code: 'FILE_GRANT_EXPIRED' },
  )
  assert.equal(received, null)
  assert.deepEqual(
    await network.upload(1, {
      id: 'upload-valid-owner',
      path: 'upload',
      fileId: file.id,
      field: 'attachment',
    }),
    { received: true },
  )
  assert.equal(received.method, 'POST')
  assert.match(received.type, /^multipart\/form-data; boundary=/)
  assert.equal(received.authorization, 'Bearer upload-test-only')
  assert.match(received.body, /name="attachment"; filename="example.txt"/)
  assert.match(received.body, /upload fixture content/)
})

test('下载限制可信 origin、字节数并清理失败临时文件；取消文件选择不发请求', async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'desktop-download-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  const tasks = new Tasks(() => {})
  const network = new Network(
    { apiBase: '', development: true, downloadOrigins: ['https://example.com'] },
    { token: 'must-not-be-sent' },
    new FileGrants(),
    tasks,
  )
  let called = 0
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    called++
    assert.equal(options.headers, undefined)
    assert.equal(options.redirect, 'error')
    return new Response('download content')
  })
  await assert.rejects(
    network.download(1, { id: 'download-001', url: 'https://evil.test/file' }, () =>
      assert.fail('不应弹出保存框'),
    ),
    { code: 'ORIGIN_NOT_ALLOWED' },
  )
  assert.deepEqual(
    await network.download(
      1,
      { id: 'download-002', url: 'https://example.com/file' },
      async () => null,
    ),
    { saved: false },
  )
  assert.equal(called, 0)
  const destination = join(path, 'file.txt')
  await network.download(
    1,
    { id: 'download-003', url: 'https://example.com/file' },
    async () => destination,
  )
  assert.equal(await readFile(destination, 'utf8'), 'download content')
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('connection lost'))
          },
        }),
      ),
  )
  await assert.rejects(
    network.download(
      1,
      { id: 'download-004', url: 'https://example.com/file' },
      async () => destination,
    ),
  )
  assert.deepEqual(await readdir(path), ['file.txt'])
  assert.equal(await readFile(destination, 'utf8'), 'download content')
})

test('JSON 响应拒绝 HTML、超大体积并支持 204', async () => {
  await assert.rejects(jsonResponse(new Response('<html>')), { code: 'INVALID_RESPONSE' })
  await assert.rejects(jsonResponse(new Response('x'.repeat(6 * 1024 * 1024))), {
    code: 'RESPONSE_TOO_LARGE',
  })
  assert.equal(await jsonResponse(new Response(null, { status: 204 })), null)
})
