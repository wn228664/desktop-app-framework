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
 *
 * 验证：真实 HTTP 请求附加主进程凭据，取消任务与 HTTP 错误可识别。
 * t：Node 测试上下文，注册 finally 等价的清理与全局替身恢复。
 */
test('真实 HTTP 请求附加主进程凭据，取消任务与 HTTP 错误可识别', async (t) => {
  // server：只监听随机回环端口的本地 HTTP 测试服务。
  const server = createServer(
    /**
     * 按本地路由返回 JSON、401、重定向或持续挂起，不访问外部服务。
     * request：本地 HTTP 服务收到的原生请求对象。
     * response：本地 HTTP 服务写出的原生响应对象。
     */
    (request, response) => {
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
    },
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(
    /**
     * 关闭本机服务所有连接并结束监听。
     */
    () => {
      server.closeAllConnections()
      server.close()
    },
  )
  // events：按调用顺序收集的公开任务事件。
  const events = []
  // tasks：当前用例独占的任务表，不连接真实窗口。
  const tasks = new Tasks(
    /**
     * 收集任务事件和 owner，核对取消终态。
     * owner：测试任务声明的窗口 ID，仅用于检查观察事件归属。
     * event：任务表发出的公开任务事件。
     */
    (owner, event) => events.push({ owner, ...event }),
  )
  // network：绑定本地测试来源或 Fetch 替身的主进程传输服务。
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
  // slow：故意不响应的请求 Promise，验证仅所属窗口可取消。
  const slow = network.request(1, { id: 'request-004', path: 'slow' })
  tasks.cancel(2, 'request-004')
  assert.equal(tasks.list(1).at(-1).status, 'running')
  tasks.cancel(1, 'request-004')
  await assert.rejects(slow, { code: 'CANCELLED' })
  assert.equal(events.at(-1).status, 'cancelled')
})

/**
 * 验证：任务超时、重复 ID 和历史数量有界。
 */
test('任务超时、重复 ID 和历史数量有界', async () => {
  // tasks：当前用例独占的任务表，不连接真实窗口。
  const tasks = new Tasks(
    /**
     * 本用例无需观察任务通知。
     */
    () => {},
  )
  // pending：等待任务级超时的 Promise。
  const pending = tasks.run(
    1,
    'timeout-001',
    'test',
    /**
     * 创建只在收到取消时拒绝的任务。
     * signal：任务表传入的当前任务取消信号。
     */
    (signal) =>
      new Promise(
        /**
         * 把任务 signal 的取消连接到受控 Promise 拒绝。
         * resolve：受控等待的成功入口，由本用例主动结算。
         * reject：受控等待的失败入口，用于模拟平台拒绝或取消。
         */
        (resolve, reject) =>
          signal.addEventListener(
            'abort',
            /**
             * 以任务实际取消原因拒绝等待。
             */
            () => reject(signal.reason),
            { once: true },
          ),
      ),
    10,
  )
  await assert.rejects(
    tasks.run(
      1,
      'timeout-001',
      'test',
      /**
       * 重复 ID 检查应在此空操作启动前拒绝。
       */
      async () => {},
    ),
    /重复/,
  )
  await assert.rejects(pending, { code: 'TIMEOUT' })
  // i：历史任务零基序号，生成唯一 ID 以超过保留上限。
  for (let i = 0; i < 55; i++)
    await tasks.run(
      1,
      `history-${i}`,
      'test',
      /**
       * 已完成的空任务，用于填满有限历史。
       */
      async () => {},
    )
  assert.equal(tasks.list(1).length, 50)
  assert.equal(tasks.list(2).length, 0)
})

/**
 * 验证：真实 multipart 上传使用授权文件、字段名和主进程凭据，拒绝跨窗口文件。
 * t：Node 测试上下文，注册 finally 等价的清理与全局替身恢复。
 */
test('真实 multipart 上传使用授权文件、字段名和主进程凭据，拒绝跨窗口文件', async (t) => {
  // directory：本用例独占的系统临时目录，结束时递归清理。
  const directory = await mkdtemp(join(tmpdir(), 'desktop-upload-'))
  t.after(
    /**
     * 测试结束清理临时上传文件目录。
     */
    () => rm(directory, { recursive: true, force: true }),
  )
  // path：本用例使用的临时文件路径，不读取或覆盖用户原文件。
  const path = join(directory, 'example.txt')
  await writeFile(path, 'upload fixture content')
  // grants：仅授予本用例临时文件的授权表。
  const grants = new FileGrants()
  // file：本用例窗口持有的不透明文件授权。
  const file = await grants.add(1, path)
  // received：本地 HTTP 服务捕获的 multipart 方法、头和正文。
  let received = null
  // server：只监听随机回环端口的本地 HTTP 测试服务。
  const server = createServer(
    /**
     * 读取真实 multipart 请求并返回本地 JSON 确认。
     * request：本地 HTTP 服务收到的原生请求对象。
     * response：本地 HTTP 服务写出的原生响应对象。
     */
    async (request, response) => {
      // chunks：上传服务器实际收到的二进制请求块。
      const chunks = []
      // chunk：当前上传请求流块，拼接后验证 multipart 内容。
      for await (const chunk of request) chunks.push(chunk)
      received = {
        method: request.method,
        type: request.headers['content-type'],
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString(),
      }
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ received: true }))
    },
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(
    /**
     * 关闭上传服务连接和回环监听。
     */
    () => {
      server.closeAllConnections()
      server.close()
    },
  )
  // network：绑定本地测试来源或 Fetch 替身的主进程传输服务。
  const network = new Network(
    {
      apiBase: `http://127.0.0.1:${server.address().port}/`,
      development: true,
      downloadOrigins: [],
    },
    { token: 'upload-test-only' },
    grants,
    new Tasks(
      /**
       * 上传用例不需要观察公开进度通知。
       */
      () => {},
    ),
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

/**
 * 验证：下载限制可信 origin、字节数并清理失败临时文件；取消文件选择不发请求。
 * t：Node 测试上下文，注册 finally 等价的清理与全局替身恢复。
 */
test('下载限制可信 origin、字节数并清理失败临时文件；取消文件选择不发请求', async (t) => {
  // path：本用例使用的临时文件路径，不读取或覆盖用户原文件。
  const path = await mkdtemp(join(tmpdir(), 'desktop-download-'))
  t.after(
    /**
     * 结束后清理临时下载产物。
     */
    () => rm(path, { recursive: true, force: true }),
  )
  // tasks：当前用例独占的任务表，不连接真实窗口。
  const tasks = new Tasks(
    /**
     * 下载用例不额外观察任务通知。
     */
    () => {},
  )
  // network：绑定本地测试来源或 Fetch 替身的主进程传输服务。
  const network = new Network(
    { apiBase: '', development: true, downloadOrigins: ['https://example.com'] },
    { token: 'must-not-be-sent' },
    new FileGrants(),
    tasks,
  )
  // called：下载 Fetch 实际启动次数，取消目标选择时必须为零。
  let called = 0
  t.mock.method(
    globalThis,
    'fetch',
    /**
     * 检查下载不发送令牌且禁止重定向，返回受控文本流。
     * _url：由 Network 验证后的下载地址，此替身仅检查请求选项。
     * options：下载 Fetch 参数，断言无认证头且禁止重定向。
     */
    async (_url, options) => {
      called++
      assert.equal(options.headers, undefined)
      assert.equal(options.redirect, 'error')
      return new Response('download content')
    },
  )
  await assert.rejects(
    network.download(
      1,
      { id: 'download-001', url: 'https://evil.test/file' },
      /**
       * 不可信来源若打开保存框则立即使测试失败。
       */
      () => assert.fail('不应弹出保存框'),
    ),
    { code: 'ORIGIN_NOT_ALLOWED' },
  )
  assert.deepEqual(
    await network.download(
      1,
      { id: 'download-002', url: 'https://example.com/file' },
      /**
       * 模拟用户取消保存目标选择。
       */
      async () => null,
    ),
    { saved: false },
  )
  assert.equal(called, 0)
  // destination：本用例临时目录内的下载目标文件。
  const destination = join(path, 'file.txt')
  await network.download(
    1,
    { id: 'download-003', url: 'https://example.com/file' },
    /**
     * 返回测试批准的临时下载目标。
     */
    async () => destination,
  )
  assert.equal(await readFile(destination, 'utf8'), 'download content')
  t.mock.method(
    globalThis,
    'fetch',
    /**
     * 返回读取中失败的响应流，验证临时文件清理和原文件保护。
     */
    async () =>
      new Response(
        new ReadableStream({
          /**
           * 主动让流报错，模拟下载连接中断。
           * controller：本次等待或流的控制器，用于验证取消或注入流错误。
           */
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
      /**
       * 失败下载仍选同一临时目标，验证旧内容未覆盖。
       */
      async () => destination,
    ),
  )
  assert.deepEqual(await readdir(path), ['file.txt'])
  assert.equal(await readFile(destination, 'utf8'), 'download content')
})

/**
 * 验证：JSON 响应拒绝 HTML、超大体积并支持 204。
 */
test('JSON 响应拒绝 HTML、超大体积并支持 204', async () => {
  await assert.rejects(jsonResponse(new Response('<html>')), { code: 'INVALID_RESPONSE' })
  await assert.rejects(jsonResponse(new Response('x'.repeat(6 * 1024 * 1024))), {
    code: 'RESPONSE_TOO_LARGE',
  })
  assert.equal(await jsonResponse(new Response(null, { status: 204 })), null)
})
