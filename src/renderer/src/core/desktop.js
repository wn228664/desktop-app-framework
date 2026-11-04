/**
 * renderer 的桌面能力入口。页面通过这里使用 preload，不直接依赖 Electron 或 Node。
 * 错误保留 code/message/details，具体提示方式由组件决定，避免请求层重复弹出通知。
 *
 * @param {Function} operation 接收 window.desktop，返回一个固定桥方法的调用 Promise。
 * @returns {Promise<*>} {ok:true,data} 中的 data；合法的空返回值可能为 undefined/null。
 * @throws {Error} 浏览器无 preload 时为 UNSUPPORTED；失败信封转换为携带公开 code 的 Error。
 * @example const info = await unwrap((api) => api.info())
 *
 * 解包固定桥成功信封，失败转为含公开字段的 Error。
 */
export async function unwrap(operation) {
  if (!window.desktop)
    throw Object.assign(new Error('请通过 Electron 启动应用'), { code: 'UNSUPPORTED' })
  // result：主进程 IPC 结果或已解包操作值，身份/取消由具体函数复验。
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
 *
 * 复制 JSON 请求体并绑定任务取消，结果返回前复验 signal。
 * path：相对 API 路径，由主进程复验来源和目录边界。
 * method：请求 HTTP 方法，默认 GET。
 * body：调用者请求体，只允许可序列化为 JSON 的内容。
 * signal：当前动作 AbortSignal，异步完成后提交结果或副作用前须复验。
 */
export function request({ path, method = 'GET', body, signal } = {}) {
  // snapshot：请求体经 JSON 序列化复制后的可跨 IPC 传输快照。
  let snapshot
  if (body !== undefined) {
    try {
      snapshot = JSON.parse(JSON.stringify(body))
    } catch {
      throw Object.assign(new Error('请求体必须可序列化为 JSON'), { code: 'INVALID_ARGUMENT' })
    }
  }
  // id：本次请求/传输随机任务 ID，用于跟踪和取消。
  const id = crypto.randomUUID()
  // cancel：把当前 signal 的取消转发为指定任务 ID 的主进程取消。
  const cancel =
    /**
     * 向主进程请求取消本次任务，取消投递失败不能产生未处理拒绝。
     */
    () => {
      void unwrap(
        /**
         * 调用本窗口指定任务的固定取消入口。
         * api：沙盒 preload 的固定 desktop 能力接口。
         */
        (api) => api.tasks.cancel(id),
      ).catch(
        /**
         * 消费取消投递失败，实际请求结果仍由原 Promise 返回。
         */
        () => {},
      )
    }
  signal?.throwIfAborted()
  // Vue reactive 对象不能直接经 IPC 克隆，JSON 请求先取得可传输的快照。
  // promise：本次已经发出的固定桥调用 Promise。
  const promise = unwrap(
    /**
     * 把可克隆请求快照发送给固定 JSON 请求桥。
     * api：沙盒 preload 的固定 desktop 能力接口。
     */
    (api) => api.request({ id, path, method, body: snapshot }),
  )
  signal?.addEventListener('abort', cancel, { once: true })
  return promise
    .then(
      /**
       * 请求返回后先复验取消，再交付结果。
       * result：主进程 IPC 结果或已解包操作值，身份/取消由具体函数复验。
       */
      (result) => {
        signal?.throwIfAborted()
        return result
      },
    )
    .finally(
      /**
       * 请求结束时解除本次 signal 的取消监听。
       */
      () => signal?.removeEventListener('abort', cancel),
    )
}

/**
 * 为上传/下载关联统一任务 ID 和取消监听，结束后始终解绑监听。
 * @param {'upload'|'download'} kind 传输类型，不接受任意桥方法名。
 * @param {Object} options 上传为 {path,fileId,field?}，下载为 {url}；ID 由此处生成。
 * @param {AbortSignal} [signal] 取消会通知主进程，不能撤回服务端已接收的上传。
 * @returns {Promise<*>} 上传返回 JSON；下载返回 {saved}，用户取消保存对话框为 false。
 * @throws {Error} 类型错误、主进程错误或取消；原生对话框不会被 AbortSignal 强制关闭。
 *
 * 为上传或下载创建随机 ID，绑定取消并在 finally 解除监听。
 */
export async function transfer(kind, options, signal) {
  if (!['upload', 'download'].includes(kind)) throw new Error('传输类型不支持')
  signal?.throwIfAborted()
  // id：本次请求/传输随机任务 ID，用于跟踪和取消。
  const id = crypto.randomUUID()
  // cancel：把当前 signal 的取消转发为指定任务 ID 的主进程取消。
  const cancel =
    /**
     * 向主进程取消当前传输任务。
     */
    () => {
      void unwrap(
        /**
         * 调用固定任务取消桥方法。
         * api：沙盒 preload 的固定 desktop 能力接口。
         */
        (api) => api.tasks.cancel(id),
      ).catch(
        /**
         * 消费取消投递失败，不覆盖传输最终结果。
         */
        () => {},
      )
    }
  // promise：本次已经发出的固定桥调用 Promise。
  const promise = unwrap(
    /**
     * 调用已验证 kind 对应的固定传输桥并传入生成的任务 ID。
     * api：沙盒 preload 的固定 desktop 能力接口。
     */
    (api) => api[kind]({ ...options, id }),
  )
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    // result：主进程 IPC 结果或已解包操作值，身份/取消由具体函数复验。
    const result = await promise
    signal?.throwIfAborted()
    return result
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}
