/**
 * 应用错误协议。
 * 主进程保留底层异常，跨 IPC 只传 code/message/details；renderer 不依赖 Node Error 的原型。
 * code 用于程序分支，message 用于用户提示；两者不可混用为后端业务成功条件。
 *
 * 可公开的受控异常。只在已确认信息不敏感的边界创建，不直接包裹服务端响应正文。
 * 可安全跨 IPC 投影的受控错误，只包含已确认可公开的代码、提示和细节。
 */
export class AppError extends Error {
  /**
   * @param {string} code 稳定错误代号，例如 INVALID_ARGUMENT、TIMEOUT。
   * @param {string} message 可直接展示的中文提示，不包含令牌、绝对路径或堆栈。
   * @param {Object} [details] 可选公开信息，例如 HTTP 状态码；禁止放原始请求与凭据。
   *
   * 构造可公开异常，调用者负责保证 message/details 的内容边界。
   */
  constructor(code, message, details) {
    super(message)
    // this.name：稳定的受控错误类型名 AppError。
    this.name = 'AppError'
    // this.code：供调用方分支判断的公开错误代号。
    this.code = code
    // this.details：可选公开细节，不能含请求、凭据或本地路径。
    this.details = details
  }
}

/**
 * 将异常转换为可序列化的公开错误。未知错误统一脱敏，不以 error.message 作为兜底文案。
 * @param {unknown} error 任意捕获值；原生 AbortError 会归一为 CANCELLED。
 * @returns {{code:string,message:string,details?:Object}} 不含堆栈与 Error 原型的信封内容。
 *
 * 将受控异常与取消投影为公开信封，未知异常使用固定脱敏说明。
 */
export function publicError(error) {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, details: error.details }
  }
  if (error?.name === 'AbortError') return { code: 'CANCELLED', message: '操作已取消' }
  return { code: 'INTERNAL', message: '操作失败，请重试或查看本地诊断记录' }
}
