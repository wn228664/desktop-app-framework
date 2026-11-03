import { contextBridge, ipcRenderer } from 'electron'

/**
 * 沙盒 preload 的固定能力桥。只暴露具体方法，不暴露 ipcRenderer、任意通道、Node 或文件路径。
 * 调用返回 {ok:true,data} / {ok:false,error:{code,message,details?}}，renderer/core/desktop.js 负责解包。
 * files 的 id 只是当前窗口授权，不能跨窗口使用；credentials 只有设置/清除，没有读取接口。
 * tasks.subscribe 与 updates.subscribe 返回 unsubscribe，订阅者必须在页面/应用作用域销毁时调用。
 * 任务事件还可能为 {type:'reset'}，表示旧上下文失效；事件回调不接触原始 Electron event。
 */

const call = (method, payload) => ipcRenderer.invoke(`desktop:${method}`, payload)
/** 只向监听者转交数据；保留同一个 handler 引用，才能准确移除本次订阅而不影响其他监听者。 */
const subscribe = (channel, listener) => {
  const handler = (_event, value) => listener(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('desktop', {
  /** 应用/平台/配置状态诊断；成功 data 不包含令牌、用户文件路径或完整环境变量。 */
  info: () => call('info'),
  /**
   * get 返回偏好快照，安装包会反映实际启动项状态。
   * set 接收白名单补丁，成功 data 是落盘后的完整快照，失败不会被桥伪装成保存成功。
   */
  preferences: {
    get: () => call('preferences.get'),
    set: (value) => call('preferences.set', value),
  },
  /**
   * pick：原生多选，取消为 []，成功 data 为 [{id,name,size}]，size 是字节。
   * readText(id)：当前窗口的授权 ID，返回最多 1 MiB 的 UTF-8 文本。
   * saveText({content})：原生另存，最多 1 Mi 字符，返回 {saved}；取消为 false。
   * release(id)：只撤销授权，不删除文件；文件跨窗口、变化或超限由主进程拒绝。
   */
  files: {
    pick: () => call('files.pick'),
    readText: (id) => call('files.readText', { id }),
    saveText: (value) => call('files.saveText', value),
    release: (id) => call('files.release', { id }),
  },
  /** set({token,remember}) 显式设置，clear 清除内存/密文；没有读取接口，不能把令牌带回 renderer。 */
  credentials: {
    set: (value) => call('credentials.set', value),
    clear: () => call('credentials.clear'),
  },
  /** JSON 请求接收 {id,path,method?,body?}；上传/下载分别使用文件授权 ID 与可信 URL，均由主进程限额。 */
  request: (value) => call('request', value),
  upload: (value) => call('upload', value),
  download: (value) => call('download', value),
  /**
   * list/cancel 只作用于调用窗口，cancel(id) 可重复调用。
   * subscribe(listener) 收到任务快照或 reset，并返回解绑函数；不转发 Electron 事件对象。
   */
  tasks: {
    list: () => call('tasks.list'),
    cancel: (id) => call('tasks.cancel', { id }),
    subscribe: (listener) => subscribe('desktop:task', listener),
  },
  /** 显式读写文本，最多 1 Mi 字符；页面不能在初始化或轮询时偷偷读取用户剪贴板。 */
  clipboard: {
    write: (value) => call('clipboard.write', { value }),
    read: () => call('clipboard.read'),
  },
  /** 接收 {title,body}，系统不支持时返回 UNSUPPORTED；成功调用不保证系统专注模式允许实际展示。 */
  notify: (value) => call('notify', value),
  /** 仅接受 HTTPS；主进程展示原生确认后才交给系统浏览器，不能用来执行任意协议或 shell。 */
  openExternal: (url) => call('openExternal', { url }),
  /** get/subscribe 观察状态，run 只允许 check/download/install；install 前的用户确认由页面负责。 */
  updates: {
    get: () => call('updates.get'),
    run: (action) => call('updates.run', { action }),
    subscribe: (listener) => subscribe('desktop:update', listener),
  },
})
