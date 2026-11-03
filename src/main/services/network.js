import { open, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { AppError } from '../../shared/errors.js'
import { apiUrl, ensure, record, text, trustedUrl } from '../../shared/validation.js'

const MAX_RESPONSE = 5 * 1024 * 1024

/**
 * 主进程 HTTP 与传输服务。认证头只由主进程生成；API 固定基址，下载使用独立来源白名单。
 * 默认不跟随重定向、不重试写操作、不猜测业务成功码。renderer 不可传 Host/Authorization 等任意头。
 */

/**
 * 逐块读取 UTF-8 响应，按实际字节累计，不能用可伪造的 Content-Length 代替上限。
 * @param {Response} response Fetch 响应，body 只允许消费一次。
 * @param {number} [max=5242880] 字节上限，包含边界。
 * @param {Function} [onProgress] 接收已读取字节数；不包含业务数据。
 * @returns {Promise<string>} 完整文本；无 body 时为空串。
 * @throws {AppError|Error} RESPONSE_TOO_LARGE、流读取失败或请求取消。
 */
export async function readBounded(response, max = MAX_RESPONSE, onProgress = () => {}) {
  const chunks = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.length
    ensure(size <= max, '响应超过大小限制', 'RESPONSE_TOO_LARGE')
    chunks.push(chunk)
    onProgress(size)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 提取 JSON 响应，不处理业务 code/success 等字段。
 * @param {Response} response 成功码范围由 response.ok 决定；204 明确返回 null。
 * @returns {Promise<*>} 合法 JSON 值。HTTP 错误会先取消未消费响应体，避免继续下载错误页面。
 * @throws {AppError} HTTP_ERROR 的 details 只有 status；非法 JSON 为 INVALID_RESPONSE。
 */
export async function jsonResponse(response) {
  if (!response.ok) {
    await response.body?.cancel()
    throw new AppError('HTTP_ERROR', `请求失败（HTTP ${response.status}）`, {
      status: response.status,
    })
  }
  if (response.status === 204) return null
  const body = await readBounded(response)
  try {
    return JSON.parse(body)
  } catch {
    throw new AppError('INVALID_RESPONSE', '服务端未返回合法 JSON')
  }
}

export class Network {
  /**
   * @param {Object} config 已通过构建配置校验的 apiBase、downloadOrigins、development。
   * @param {Credentials} credentials 只在发送 API 请求时取令牌，不把令牌复制进任务历史。
   * @param {FileGrants} grants 上传的窗口文件授权表。
   * @param {Tasks} tasks 负责本服务所有任务的并发、取消与超时。
   */
  constructor(config, credentials, grants, tasks) {
    this.config = config
    this.credentials = credentials
    this.grants = grants
    this.tasks = tasks
    if (config.apiBase) trustedUrl(config.apiBase, config.development)
    this.origins = config.downloadOrigins.map((item) => trustedUrl(item).origin)
  }

  #headers() {
    return this.credentials.token ? { Authorization: `Bearer ${this.credentials.token}` } : {}
  }

  /**
   * @param {number} owner 调用窗口 ID。
   * @param {Object} args 包含 id/path，可选 method（默认 GET）和 JSON body。
   * body 最大 1 MiB；GET 不接受 body；支持 GET/POST/PUT/PATCH/DELETE。
   * @returns {Promise<*>} 原始 JSON 或 204 的 null，超时为 60 秒。
   * @throws {AppError|Error} 未配置、目录越界、非法参数、HTTP/解析错误、取消或超时。
   */
  request(owner, args) {
    record(args)
    const url = apiUrl(this.config.apiBase, args.path)
    const method = args.method ?? 'GET'
    ensure(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method), 'HTTP 方法不支持')
    let body
    if (args.body !== undefined) {
      ensure(method !== 'GET', 'GET 请求不支持请求体')
      body = JSON.stringify(args.body)
      ensure(Buffer.byteLength(body) <= 1024 * 1024, '请求体超过 1 MiB 限制')
    }
    return this.tasks.run(owner, args.id, 'request', async (signal) => {
      const response = await fetch(url, {
        method,
        body,
        headers: { ...this.#headers(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        signal,
        redirect: 'error',
      })
      return jsonResponse(response)
    })
  }

  /**
   * @param {number} owner 上传窗口 ID，必须拥有 fileId 的授权。
   * @param {Object} args 包含 id/path/fileId，可选 field（默认 file，最长 80 字符）。
   * @returns {Promise<*>} multipart POST 的 JSON 响应，超时 120 秒，单文件上限 20 MiB。
   * Fetch 无可靠上传字节回调，sending 阶段不编造百分比；成功才将 completed 置为文件大小。
   * @throws {AppError|Error} 授权、文件变化或请求错误；调用方仍负责释放已选择文件的授权。
   */
  upload(owner, args) {
    record(args)
    const url = apiUrl(this.config.apiBase, args.path)
    const field = text(args.field ?? 'file', 80)
    return this.tasks.run(
      owner,
      args.id,
      'upload',
      async (signal, update) => {
        const file = await this.grants.read(owner, args.fileId)
        signal.throwIfAborted()
        const form = new FormData()
        form.append(field, new Blob([file.data]), file.name)
        update({ total: file.data.length, phase: 'sending' })
        const response = await fetch(url, {
          method: 'POST',
          body: form,
          headers: this.#headers(),
          signal,
          redirect: 'error',
        })
        const result = await jsonResponse(response)
        update({ completed: file.data.length, phase: 'complete' })
        return result
      },
      120_000,
    )
  }

  /**
   * 下载不携带 API 令牌，只接受独立白名单中的 HTTPS origin，禁止跳转到其他地址。
   * @param {number} owner 下载窗口 ID。
   * @param {Object} args 包含 id/url；url 可包含下载服务所需查询参数，但不能内嵌用户名或密码。
   * @param {Function} chooseDestination 原生保存对话框封装，返回绝对路径或 null；窗口负责对话框互斥。
   * @returns {Promise<{saved:boolean}>} 取消选择为 false；只有临时文件成功替换目标后才为 true。
   * 下载上限 512 MiB、超时 300 秒；进度按流实际字节计数，未知总长用 total=0。
   * @throws {AppError|Error} 不可信来源、超限、磁盘、网络、取消或超时；失败尝试清理 .part 文件。
   */
  async download(owner, args, chooseDestination) {
    record(args)
    const url = trustedUrl(text(args.url, 2000))
    ensure(this.origins.includes(url.origin), '该下载来源未配置为可信地址', 'ORIGIN_NOT_ALLOWED')
    return this.tasks.run(
      owner,
      args.id,
      'download',
      async (signal, update) => {
        const destination = await chooseDestination()
        signal.throwIfAborted()
        if (!destination) return { saved: false }
        const temp = `${destination}.${randomUUID()}.part`
        let handle
        try {
          const response = await fetch(url, { signal, redirect: 'error' })
          ensure(response.ok, `下载失败（HTTP ${response.status}）`, 'HTTP_ERROR')
          handle = await open(temp, 'wx', 0o600)
          const total = Number(response.headers.get('content-length')) || 0
          let completed = 0
          let lastUpdate = 0
          for await (const chunk of response.body ?? []) {
            completed += chunk.length
            ensure(completed <= 512 * 1024 * 1024, '下载超过 512 MiB 限制')
            await handle.writeFile(chunk)
            if (Date.now() - lastUpdate > 100) {
              update({ completed, total })
              lastUpdate = Date.now()
            }
          }
          signal.throwIfAborted()
          await handle.close()
          handle = null
          await rename(temp, destination)
          update({ completed, total: completed })
          return { saved: true }
        } finally {
          await handle?.close()
          await rm(temp, { force: true })
        }
      },
      300_000,
    )
  }
}
