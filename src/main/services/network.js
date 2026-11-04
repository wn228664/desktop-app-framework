import { open, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { AppError } from '../../shared/errors.js'
import { apiUrl, ensure, record, text, trustedUrl } from '../../shared/validation.js'

// MAX_RESPONSE：JSON 响应实际字节上限，固定 5MiB。
const MAX_RESPONSE = 5 * 1024 * 1024

/**
 * 主进程 HTTP 与传输服务。认证头只由主进程生成；API 固定基址，下载使用独立来源白名单。
 * 默认不跟随重定向、不重试写操作、不猜测业务成功码。renderer 不可传 Host/Authorization 等任意头。
 *
 * 逐块读取 UTF-8 响应，按实际字节累计，不能用可伪造的 Content-Length 代替上限。
 * @param {Response} response Fetch 响应，body 只允许消费一次。
 * @param {number} [max=5242880] 字节上限，包含边界。
 * @param {Function} [onProgress] 接收已读取字节数；不包含业务数据。
 * @returns {Promise<string>} 完整文本；无 body 时为空串。
 * @throws {AppError|Error} RESPONSE_TOO_LARGE、流读取失败或请求取消。
 *
 * 逐块读取 UTF-8 响应，按实际字节检查上限并返回完整文本。
 */
export async function readBounded(
  response,
  max = MAX_RESPONSE,

  /**
   * 缺省不观察读取进度的空处理器。
   */
  onProgress = () => {},
) {
  // chunks：已通过累计字节限制的响应分块。
  const chunks = []
  // size：响应当前累计的实际字节数。
  let size = 0
  // chunk：本次流读取的二进制块，按字节计算上限。
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
 *
 * 检查 HTTP 状态并解析 JSON，204 返回 null，失败不猜业务码。
 */
export async function jsonResponse(response) {
  if (!response.ok) {
    await response.body?.cancel()
    throw new AppError('HTTP_ERROR', `请求失败（HTTP ${response.status}）`, {
      status: response.status,
    })
  }
  if (response.status === 204) return null
  // body：JSON 响应文本或序列化请求体，仅由所在传输函数消费。
  const body = await readBounded(response)
  try {
    return JSON.parse(body)
  } catch {
    throw new AppError('INVALID_RESPONSE', '服务端未返回合法 JSON')
  }
}

/** 固定 API 来源与独立下载白名单的主进程传输服务，所有请求交由 Tasks 管理，文件上传先验证窗口授权。 */
export class Network {
  /**
   * @param {Object} config 已通过构建配置校验的 apiBase、downloadOrigins、development。
   * @param {Credentials} credentials 只在发送 API 请求时取令牌，不把令牌复制进任务历史。
   * @param {FileGrants} grants 上传的窗口文件授权表。
   * @param {Tasks} tasks 负责本服务所有任务的并发、取消与超时。
   *
   * 保存服务依赖并解析独立下载来源白名单。
   */
  constructor(config, credentials, grants, tasks) {
    // this.config：已通过构建契约检查的公开来源配置。
    this.config = config
    // this.credentials：仅主进程可读的凭据服务。
    this.credentials = credentials
    // this.grants：当前窗口文件能力的授权表。
    this.grants = grants
    // this.tasks：负责并发、超时、取消与公开进度的任务注册表。
    this.tasks = tasks
    if (config.apiBase) trustedUrl(config.apiBase, config.development)
    // this.origins：通过可信 HTTPS URL 校验后的下载 origin 白名单。
    this.origins = config.downloadOrigins.map(
      /**
       * 将可信下载地址规范为 origin，不保存其路径和查询。
       * item：配置中的单个下载来源，解析后只保存 origin。
       */
      (item) => trustedUrl(item).origin,
    )
  }

  /**
   * 发送时读取当前令牌并构造认证头，匿名状态返回空头对象。
   */
  #headers() {
    return this.credentials.token ? { Authorization: `Bearer ${this.credentials.token}` } : {}
  }

  /**
   * @param {number} owner 调用窗口 ID。
   * @param {Object} args 包含 id/path，可选 method（默认 GET）和 JSON body。
   * body 最大 1 MiB；GET 不接受 body；支持 GET/POST/PUT/PATCH/DELETE。
   * @returns {Promise<*>} 原始 JSON 或 204 的 null，超时为 60 秒。
   * @throws {AppError|Error} 未配置、目录越界、非法参数、HTTP/解析错误、取消或超时。
   *
   * 校验相对路径、方法和有界 JSON 请求体后注册任务。
   */
  request(owner, args) {
    record(args)
    // url：由固定 API 基址或下载白名单校验后的目标 URL。
    const url = apiUrl(this.config.apiBase, args.path)
    // method：当前 API 请求的 HTTP 方法，默认 GET，只接受白名单。
    const method = args.method ?? 'GET'
    ensure(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method), 'HTTP 方法不支持')
    // body：JSON 响应文本或序列化请求体，仅由所在传输函数消费。
    let body
    if (args.body !== undefined) {
      ensure(method !== 'GET', 'GET 请求不支持请求体')
      body = JSON.stringify(args.body)
      ensure(Buffer.byteLength(body) <= 1024 * 1024, '请求体超过 1 MiB 限制')
    }
    return this.tasks.run(
      owner,
      args.id,
      'request',
      /**
       * 通过 Fetch 发出固定来源请求，禁止重定向并保持取消信号。
       * signal：当前任务 AbortSignal，等待后提交结果或副作用前需检查取消。
       */
      async (signal) => {
        // response：Fetch 原始响应，成功状态和 JSON 合法性由 jsonResponse 复验。
        const response = await fetch(url, {
          method,
          body,
          headers: { ...this.#headers(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
          signal,
          redirect: 'error',
        })
        return jsonResponse(response)
      },
    )
  }

  /**
   * @param {number} owner 上传窗口 ID，必须拥有 fileId 的授权。
   * @param {Object} args 包含 id/path/fileId，可选 field（默认 file，最长 80 字符）。
   * @returns {Promise<*>} multipart POST 的 JSON 响应，超时 120 秒，单文件上限 20 MiB。
   * Fetch 无可靠上传字节回调，sending 阶段不编造百分比；成功才将 completed 置为文件大小。
   * @throws {AppError|Error} 授权、文件变化或请求错误；调用方仍负责释放已选择文件的授权。
   *
   * 校验上传参数并注册可取消的单文件任务。
   */
  upload(owner, args) {
    record(args)
    // url：由固定 API 基址或下载白名单校验后的目标 URL。
    const url = apiUrl(this.config.apiBase, args.path)
    // field：multipart 文件字段名，默认 file，最长 80 字符。
    const field = text(args.field ?? 'file', 80)
    return this.tasks.run(
      owner,
      args.id,
      'upload',
      /**
       * 读取授权文件后复验取消，发送 multipart 并报告真实完成字节。
       * signal：当前任务 AbortSignal，等待后提交结果或副作用前需检查取消。
       * update：当前任务公开进度发布器，不携带响应内容或凭据。
       */
      async (signal, update) => {
        // file：按 owner 读取的授权文件名称和有界 Buffer。
        const file = await this.grants.read(owner, args.fileId)
        signal.throwIfAborted()
        // form：仅包含本次授权文件的 multipart 请求体。
        const form = new FormData()
        form.append(field, new Blob([file.data]), file.name)
        update({ total: file.data.length, phase: 'sending' })
        // response：Fetch 原始响应，成功状态和 JSON 合法性由 jsonResponse 复验。
        const response = await fetch(url, {
          method: 'POST',
          body: form,
          headers: this.#headers(),
          signal,
          redirect: 'error',
        })
        // result：已经通过 HTTP 和 JSON 校验的原始响应，不解释业务成功。
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
   *
   * 检查下载来源并登记含保存对话框等待的下载任务。
   */
  async download(owner, args, chooseDestination) {
    record(args)
    // url：由固定 API 基址或下载白名单校验后的目标 URL。
    const url = trustedUrl(text(args.url, 2000))
    ensure(this.origins.includes(url.origin), '该下载来源未配置为可信地址', 'ORIGIN_NOT_ALLOWED')
    return this.tasks.run(
      owner,
      args.id,
      'download',
      /**
       * 经用户选择目标后有界写临时文件，完成和取消复验后才原子替换。
       * signal：当前任务 AbortSignal，等待后提交结果或副作用前需检查取消。
       * update：当前任务公开进度发布器，不携带响应内容或凭据。
       */
      async (signal, update) => {
        // destination：用户在原生选择器明确批准的下载绝对路径；取消为 null。
        const destination = await chooseDestination()
        signal.throwIfAborted()
        if (!destination) return { saved: false }
        // temp：下载目标同目录的随机 .part 路径，成功才替换目标。
        const temp = `${destination}.${randomUUID()}.part`
        // handle：独占创建的临时下载文件句柄，finally 尝试关闭。
        let handle
        try {
          // response：Fetch 原始响应，成功状态和 JSON 合法性由 jsonResponse 复验。
          const response = await fetch(url, { signal, redirect: 'error' })
          ensure(response.ok, `下载失败（HTTP ${response.status}）`, 'HTTP_ERROR')
          handle = await open(temp, 'wx', 0o600)
          // total：服务端声明的下载总字节数，仅用于展示，不用于实际上限判断。
          const total = Number(response.headers.get('content-length')) || 0
          // completed：真正从响应流收到并写入的字节数。
          let completed = 0
          // lastUpdate：上次进度发布的墙钟毫秒，用于节流通知。
          let lastUpdate = 0
          // chunk：本次流读取的二进制块，按字节计算上限。
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
