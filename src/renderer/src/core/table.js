/**
 * 本地表格的升序比较器，不修改或格式化单元格值。
 * @param {*} left 原始值；同列应尽量保持一致类型。
 * @param {*} right 原始值。
 * @returns {number} 负/零/正值：数值按大小、Date 按时间、其他值按中文自然文字顺序。
 * null/undefined/NaN 在升序时置后；外层乘以 -1 得到降序，因此降序时空值会置前。
 * 不推断金额、百分号或带单位字符串的业务含义，这类列应先提供可排序的原始值。
 *
 * 按类型比较两原值，升序把缺失值置后，不猜金额或单位。
 */
export function compareValues(left, right) {
  // missing：空值谓词，仅把 null/undefined/NaN 视为缺失。
  const missing =
    /**
     * 判断单个原值是否属于需要后置的缺失集合。
     * value：当前待比较原值，用于识别缺失值。
     */
    (value) =>
      value === null || value === undefined || (typeof value === 'number' && Number.isNaN(value))
  if (missing(left)) return missing(right) ? 0 : 1
  if (missing(right)) return -1
  if (typeof left === 'number' && typeof right === 'number')
    return left === right ? 0 : left < right ? -1 : 1
  if (left instanceof Date && right instanceof Date)
    return compareValues(left.getTime(), right.getTime())
  return String(left).localeCompare(String(right), 'zh-CN', { numeric: true })
}
