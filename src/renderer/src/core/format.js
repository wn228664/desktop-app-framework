/**
 * 无状态的展示与筛选工具，不读取全局设置、不修改输入，也不承担业务字段转换。
 *
 * @param {number} value 非负字节数；不接受数值字符串，非法值显示 —。
 * @returns {string} 使用 1024 进制的 B/KiB/MiB/GiB/TiB，最多一位小数，0 显示 0 B。
 *
 * 展示非负有限字节数，非法值返回占位，不承担业务精度转换。
 */
export function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value === 0) return '0 B'
  // unit：1024 进制单位索引，最大 4 对应 TiB。
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4)
  return `${Number((value / 1024 ** unit).toFixed(1))} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`
}

/**
 * @param {Date|string|number} value Date、可解析日期串或毫秒时间戳；秒级时间戳需调用方先转换。
 * @param {Intl.DateTimeFormatOptions} [options] 默认中文、本地时区、中等日期与简短时间，可显式覆盖。
 * @returns {string} 空值/无效日期为 —，有效值按 Intl 格式化。
 * @throws {RangeError|TypeError} 非法 Intl 选项仍会抛出，不能把配置错误当空日期静默隐藏。
 *
 * 按本地时区及调用方 Intl 选项展示日期。
 */
export function formatDate(value, options = {}) {
  if (value === undefined || value === null || value === '') return '—'
  // date：解析出的本地日期，非法时间值显示占位符。
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...options,
  }).format(date)
}

/**
 * @param {Object} value 简单筛选对象，调用方应显式决定是否 trim 字符串。
 * @returns {Object} 去除空串/null/undefined 的新对象，保留 0、false、空数组及嵌套对象。
 * 只做浅层快照；嵌套对象仍共享引用，不适合作为需要完全隔离的历史记录副本。
 *
 * 浅复制筛选条件并移除明确定义的空值。
 */
export function compactQuery(value) {
  return Object.fromEntries(
    Object.entries(value).filter(
      /**
       * 保留 0、false 和非空字段，避免使用真值过滤。
       * item：筛选对象字段值，仅排除空串/null/undefined。
       */
      ([, item]) => item !== '' && item !== null && item !== undefined,
    ),
  )
}

/**
 * @param {string} value 输入的下载地址。
 * @returns {boolean} 是否为不含内嵌凭据的 HTTPS URL；非法输入为 false，不抛异常。
 * 仅服务于输入反馈，不能代替主进程的来源白名单和传输校验。
 *
 * 提供无副作用的 HTTPS 输入反馈，来源批准仍在主进程。
 */
export function isHttpsUrl(value) {
  try {
    // url：待输入反馈的下载 URL，仅检查 HTTPS 和无内嵌凭据。
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}
