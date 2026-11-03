import { ensure, text, trustedUrl } from './validation.js'

/**
 * 构建期公开配置契约。electron-vite 与 builder 必须共用此解析器，避免运行端和安装包各读一套规则。
 * @param {Object<string,string>} environment Vite loadEnv 返回的环境值；未知键不会进入结果。
 * @param {boolean} [development=false] true 只放开本机 HTTP API，不放开下载或更新的 HTTPS 要求。
 * @returns {{DESKTOP_API_BASE_URL:string,DESKTOP_DOWNLOAD_ORIGINS:string,DESKTOP_UPDATE_URL:string}}
 * 标准化公开配置；白名单会去重并以逗号连接，未配置能力保留空串。
 * @throws {AppError} URL、origin 或更新发布者不合法时终止构建，避免带错配置分发。
 */
export function resolveRuntimeConfig(environment, development = false) {
  const base = environment.DESKTOP_API_BASE_URL?.trim() || ''
  if (base) {
    const url = trustedUrl(base, development)
    ensure(!url.search, 'API 基址不能包含查询参数')
  }
  const origins = (environment.DESKTOP_DOWNLOAD_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const url = trustedUrl(item)
      ensure(
        url.pathname === '/' && !url.search,
        '下载白名单必须填写 origin，不能包含路径或查询参数',
      )
      return url.origin
    })
  const update = environment.DESKTOP_UPDATE_URL?.trim() || ''
  if (update) {
    ensure(!trustedUrl(update).search, '更新基址不能包含查询参数')
    ensure(
      typeof environment.DESKTOP_UPDATE_PUBLISHER === 'string' &&
        environment.DESKTOP_UPDATE_PUBLISHER.trim().length > 0,
      '启用更新服务时必须填写 DESKTOP_UPDATE_PUBLISHER',
    )
    text(environment.DESKTOP_UPDATE_PUBLISHER, 256)
  }
  return {
    DESKTOP_API_BASE_URL: base,
    DESKTOP_DOWNLOAD_ORIGINS: [...new Set(origins)].join(','),
    DESKTOP_UPDATE_URL: update,
  }
}

/**
 * 原生窗口几何校验；实际显示器工作区夹取由主进程创建窗口时完成。
 * @param {Object} value 完整 x/y/width/height，单位为 Electron 屏幕逻辑像素，不接受部分补丁。
 * @returns {{x:number,y:number,width:number,height:number}} 仅保留几何字段的新对象。
 * @throws {AppError} 非整数、非正尺寸或超范围值；JsonStore.load 会将其归为配置损坏并使用默认值。
 */
export function windowBounds(value) {
  for (const key of ['x', 'y', 'width', 'height'])
    ensure(Number.isSafeInteger(value?.[key]), '窗口尺寸无效')
  ensure(Math.abs(value.x) <= 1_000_000 && Math.abs(value.y) <= 1_000_000, '窗口位置超出范围')
  ensure(
    value.width > 0 && value.width <= 32_768 && value.height > 0 && value.height <= 32_768,
    '窗口尺寸超出范围',
  )
  return { x: value.x, y: value.y, width: value.width, height: value.height }
}
