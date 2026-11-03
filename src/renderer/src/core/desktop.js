/**
 * renderer 的桌面能力入口。页面通过这里使用 preload，不直接依赖 Electron 或 Node。
 * 错误保留 code/message/details，具体提示方式由组件决定，避免请求层重复弹出通知。
 */

/**
 * @param {Function} operation 接收 window.desktop，返回一个固定桥方法的调用 Promise。
 * @returns {Promise<*>} {ok:true,data} 中的 data；合法的空返回值可能为 undefined/null。
 * @throws {Error} 浏览器无 preload 时为 UNSUPPORTED；失败信封转换为携带公开 code 的 Error。
 * @example const info = await unwrap((api) => api.info())
 */
export async function unwrap(operation) {
  if (!window.desktop)
    throw Object.assign(new Error('请通过 Electron 启动应用'), { code: 'UNSUPPORTED' })
  const result = await operation(window.desktop)
  if (!result?.ok)
    throw Object.assign(new Error(result?.error?.message ?? '桌面接口调用失败'), result?.error)
  return result.data
}

/**
 * 发送 JSON API 请求，保留服务端原始结果，不猜测 code/success/data 等业务字段。
 * @param {Object} options path 为相对 API 路径；method 默认 GET；body 必须可序列化为 JSON。
 * options.signal 关联页面生命周期，卸载/切换条件时由调用方 abort。
 * @returns {Promise<*>} 主进程返回的 JSON/204 null；已取消的迟到结果不会继续交给调用方。
 * @throws {Error} 不可序列化 body 或已取消 signal 可能同步抛出；主进程失败通过 Promise 拒绝。
 * @example await request({ path: 'items', method: 'POST', body: draft, signal })
 */
export function request({ path, method = 'GET', body, signal } = {}) {
  let snapshot
  if (body !== undefined) {
    try {
      snapshot = JSON.parse(JSON.stringify(body))
    } catch {
      throw Object.assign(new Error('请求体必须可序列化为 JSON'), { code: 'INVALID_ARGUMENT' })
    }
  }
  const id = crypto.randomUUID()
  const cancel = () => {
    void unwrap((api) => api.tasks.cancel(id)).catch(() => {})
  }
  signal?.throwIfAborted()
  // Vue reactive 对象不能直接经 IPC 克隆，JSON 请求先取得可传输的快照。
  const promise = unwrap((api) => api.request({ id, path, method, body: snapshot }))
  signal?.addEventListener('abort', cancel, { once: true })
  return promise
    .then((result) => {
      signal?.throwIfAborted()
      return result
    })
    .finally(() => signal?.removeEventListener('abort', cancel))
}

/**
 * 为上传/下载关联统一任务 ID 和取消监听，结束后始终解绑监听。
 * @param {'upload'|'download'} kind 传输类型，不接受任意桥方法名。
 * @param {Object} options 上传为 {path,fileId,field?}，下载为 {url}；ID 由此处生成。
 * @param {AbortSignal} [signal] 取消会通知主进程，不能撤回服务端已接收的上传。
 * @returns {Promise<*>} 上传返回 JSON；下载返回 {saved}，用户取消保存对话框为 false。
 * @throws {Error} 类型错误、主进程错误或取消；原生对话框不会被 AbortSignal 强制关闭。
 */
export async function transfer(kind, options, signal) {
  if (!['upload', 'download'].includes(kind)) throw new Error('传输类型不支持')
  signal?.throwIfAborted()
  const id = crypto.randomUUID()
  const cancel = () => {
    void unwrap((api) => api.tasks.cancel(id)).catch(() => {})
  }
  const promise = unwrap((api) => api[kind]({ ...options, id }))
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    const result = await promise
    signal?.throwIfAborted()
    return result
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}
