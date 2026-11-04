import { AppError } from './errors.js'

/**
 * 主进程与构建配置共享的输入契约。renderer 可做体验校验，但不能代替主进程复验。
 * 本文件不读取环境、磁盘或 UI 状态，校验失败一律抛出可公开的 AppError。
 *
 * 统一断言入口；调用方提供的提示必须可以公开展示。
 * @param {unknown} condition 按 JavaScript 真值判断。
 * @param {string} [message='参数不合法'] 用户提示。
 * @param {string} [code='INVALID_ARGUMENT'] 供调用方区分的错误代号。
 * @throws {AppError} 条件不满足时抛出，不返回默认成功值。
 *
 * 条件不满足时以指定公开提示和代码抛出 AppError。
 */
export function ensure(condition, message = '参数不合法', code = 'INVALID_ARGUMENT') {
  if (!condition) throw new AppError(code, message)
}

/**
 * 检查普通记录对象，拒绝 Date/Map/数组及可引起原型污染的顶层键。
 * @param {unknown} value 待校验值；允许 Object.prototype 或 null 原型。
 * @returns {Object} 原对象，不复制、不深度修改；嵌套字段仍由具体接口继续校验。
 * @throws {AppError} 类型或顶层键不符合 IPC 记录契约。
 *
 * 校验普通记录及顶层安全键，不复制或替代具体字段校验。
 */
export function record(value) {
  ensure(value && typeof value === 'object' && !Array.isArray(value))
  ensure([Object.prototype, null].includes(Object.getPrototypeOf(value)), '仅支持普通对象')
  ensure(
    Object.keys(value).every(
      /**
       * 拒绝可污染原型的顶层键名。
       * key：当前记录键或偏好键，按白名单拒绝原型污染及未知设置项。
       */
      (key) => !['__proto__', 'constructor', 'prototype'].includes(key),
    ),
  )
  return value
}

/**
 * 校验字符串类型和长度；长度按 UTF-16 字符单元计算，不是 UTF-8 字节数。
 * @param {unknown} value 输入值，不进行隐式 String 转换。
 * @param {number} [max=1000] 包含边界的长度上限。
 * @param {boolean} [allowEmpty=false] false 时，空串与纯空白均拒绝。
 * @returns {string} 原字符串，保留前后空白；需要 trim 的配置由调用方显式处理。
 *
 * 校验文本类型、长度和空值策略并保留原字符串。
 */
export function text(value, max = 1000, allowEmpty = false) {
  ensure(
    typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0),
  )
  return value
}

/**
 * 校验跨进程任务标识。标识用于取消归属，不应携带用户信息或接口地址。
 * @param {unknown} value 8～80 位字母、数字、下划线或连字符；推荐 crypto.randomUUID()。
 * @returns {string} 已校验标识；是否重复由 Tasks 注册时判断。
 *
 * 校验跨进程任务标识的字符集与长度。
 */
export function requestId(value) {
  ensure(typeof value === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(value), '请求标识不合法')
  return value
}

/** 非敏感偏好的默认快照；启动项与托盘默认关闭，令牌不允许放入此对象。 */
// defaultPreferences：冻结的非敏感默认设置，系统启动项与托盘均默认关闭。
export const defaultPreferences = Object.freeze({
  theme: 'system',
  compact: false,
  closeToTray: false,
  launchAtLogin: false,
  zoom: 1,
})

/**
 * 验证偏好补丁；允许只提交一个字段，也允许空补丁。
 * @param {Object} value theme、compact、closeToTray、launchAtLogin、zoom 的部分集合。
 * @returns {Object} 原补丁。这里只验证值，不写文件或修改系统设置。
 * @throws {AppError} 未知字段、非布尔开关、非法主题或不支持的缩放比例。
 *
 * 验证偏好字段白名单与每个字段的值域。
 */
export function preferencesPatch(value) {
  record(value)
  // key：当前记录键或偏好键，按白名单拒绝原型污染及未知设置项。
  // item：当前偏好字段值，类型必须匹配其已知键。
  for (const [key, item] of Object.entries(value)) {
    ensure(Object.hasOwn(defaultPreferences, key), '存在不支持的设置项')
    if (key === 'theme') ensure(['system', 'light', 'dark'].includes(item), '主题不合法')
    else if (key === 'zoom') ensure([0.8, 1, 1.25, 1.5].includes(item), '缩放比例不合法')
    else ensure(typeof item === 'boolean', '设置值类型不合法')
  }
  return value
}

/**
 * 将相对 API 路径解析到固定基址下，兼容带或不带开头单个斜线的调用方式。
 * @param {string} base 已通过配置校验的基址，例如 https://host/api/。
 * @param {string} path 最长 2000 字符，可带查询参数；禁止完整 URL、片段、反斜线与目录越界。
 * @returns {URL} 与基址同源且仍位于基址目录内的 URL。
 * @throws {AppError} 基址为空时为 NOT_CONFIGURED，路径越界时为 INVALID_ARGUMENT。
 *
 * 将相对路径限定在固定 API 来源和基址目录内。
 */
export function apiUrl(base, path) {
  ensure(base, '请先配置 DESKTOP_API_BASE_URL', 'NOT_CONFIGURED')
  text(path, 2000)
  ensure(
    !/^[a-z][a-z0-9+.-]*:|^[/\\]{2}|\\|#/i.test(path) &&
      ![...path].some(
        /**
         * 识别路径内控制字符与 ASCII 空白。
         * char：相对路径中的单个 Unicode 字符，空白及控制字符不可通过。
         */
        (char) => char.codePointAt(0) <= 32,
      ),
    '仅支持 API 相对路径',
  )
  // root：补齐目录末尾斜线后的固定 API 基址。
  const root = new URL(base.endsWith('/') ? base : `${base}/`)
  // url：经 URL 解析的候选地址，后续继续检查来源、目录或协议。
  const url = new URL(path.replace(/^\//, ''), root)
  ensure(url.origin === root.origin && url.pathname.startsWith(root.pathname), 'API 路径超出范围')
  return url
}

/**
 * 校验受信 URL 的基本传输约束，不负责批准下载来源或 API 目录范围。
 * @param {string} value 最长 2000 字符；拒绝 URL 内嵌用户名、密码和片段。
 * @param {boolean} [allowLocal=false] 仅为开发 API 允许 localhost/127.0.0.1 的 HTTP。
 * @returns {URL} 解析后的 URL；普通查询参数由上层按用途决定是否允许。
 * @throws {AppError} 非法 URL 或不允许的协议，code 为 INVALID_ARGUMENT。
 *
 * 解析可信传输 URL，开发 API 可显式允许本机 HTTP。
 */
export function trustedUrl(value, allowLocal = false) {
  text(value, 2000)
  // url：经 URL 解析的候选地址，后续继续检查来源、目录或协议。
  let url
  try {
    url = new URL(value)
  } catch {
    throw new AppError('INVALID_ARGUMENT', 'URL 格式不合法')
  }
  ensure(!url.username && !url.password && !url.hash, 'URL 不允许包含凭据或片段')
  ensure(
    url.protocol === 'https:' ||
      (allowLocal && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)),
    '只允许 HTTPS 地址',
  )
  return url
}
