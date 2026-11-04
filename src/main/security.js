import { AppError } from '../shared/errors.js'

/**
 * 校验每次 IPC 的调用身份，不能只因 preload 使用固定通道就省略这一层。
 * @param {Electron.IpcMainInvokeEvent} event Electron 提供的调用事件，不接受 renderer 自报窗口 ID。
 * @param {Electron.BrowserWindow|null} window 当前主窗口；销毁后立即失去授权。
 * @param {string} trustedDocument 精确文档 URL，不含路由 hash；开发地址由当前 dev server 提供。
 * @returns {void} 主窗口、主框架、文档均匹配才放行，允许 hash 路由切换。
 * @throws {AppError} FORBIDDEN：其他窗口、iframe、外部文档或已销毁窗口均拒绝。
 *
 * 核对窗口、主框架和精确文档 URL，任一不匹配即拒绝 IPC。
 */
export function assertSender(event, window, trustedDocument) {
  // frame：本次 IPC 的真实 senderFrame，必须等于当前窗口主框架。
  const frame = event.senderFrame
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    !frame ||
    frame !== event.sender.mainFrame ||
    frame.url.split('#')[0] !== trustedDocument
  )
    throw new AppError('FORBIDDEN', '当前页面无权调用桌面接口')
}
