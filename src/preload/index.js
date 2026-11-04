import { contextBridge, ipcRenderer } from 'electron'

/**
 * 沙盒 preload 的固定能力桥。只暴露具体方法，不暴露 ipcRenderer、任意通道、Node 或文件路径。
 * 调用返回 {ok:true,data} / {ok:false,error:{code,message,details?}}，renderer/core/desktop.js 负责解包。
 * files 的 id 只是当前窗口授权，不能跨窗口使用；credentials 只有设置/清除，没有读取接口。
 * tasks.subscribe 与 updates.subscribe 返回 unsubscribe，订阅者必须在页面/应用作用域销毁时调用。
 * 任务事件还可能为 {type:'reset'}，表示旧上下文失效；事件回调不接触原始 Electron event。
 */

// call：只允许本文件固定方法调用的 IPC invoke 包装器。
const call =
  /**
   * 调用固定 desktop IPC 方法并保留统一信封。
   * method：由本文件定义的固定桌面方法名。
   * payload：固定桥方法的调用载荷，主进程仍需校验。
   */
  (method, payload) => ipcRenderer.invoke(`desktop:${method}`, payload)
/** 只向监听者转交数据；保留同一个 handler 引用，才能准确移除本次订阅而不影响其他监听者。 */
// subscribe：固定事件通道订阅器，返回本次监听的独立清理函数。
const subscribe =
  /**
   * 订阅固定公开事件并返回精确解绑函数。
   * channel：仅由本文件选择的 desktop:task 或 desktop:update 通道。
   * listener：renderer 提供的数据观察器，卸载时必须调用返回的清理函数。
   */
  (channel, listener) => {
    // handler：剔除原始 Electron event 后转交数据的稳定监听引用。
    const handler =
      /**
       * 只转交事件数据，不泄露原始 Electron 事件对象。
       * _event：不允许向 renderer 回调转发的原始 Electron 事件。
       * value：具体固定桥方法的载荷或公开事件数据，参数形状由该方法契约约束。
       */
      (_event, value) => listener(value)
    ipcRenderer.on(channel, handler)
    return (
      /**
       * 移除本订阅持有的监听函数，不影响其他调用者。
       */
      () => ipcRenderer.removeListener(channel, handler)
    )
  }

contextBridge.exposeInMainWorld('desktop', {
  /**
   * 读取公开应用诊断。
   */
  info: () => call('info'),
  /**
   * get 返回偏好快照，安装包会反映实际启动项状态。
   * set 接收白名单补丁，成功 data 是落盘后的完整快照，失败不会被桥伪装成保存成功。
   */
  preferences: {
    /**
     * 读取非敏感偏好快照。
     */
    get: () => call('preferences.get'),
    /**
     * 提交偏好补丁，等待主进程持久化结果。
     * value：非敏感偏好字段补丁。
     */
    set: (value) => call('preferences.set', value),
  },
  /**
   * pick：原生多选，取消为 []，成功 data 为 [{id,name,size}]，size 是字节。
   * readText(id)：当前窗口的授权 ID，返回最多 1 MiB 的 UTF-8 文本。
   * saveText({content})：原生另存，最多 1 Mi 字符，返回 {saved}；取消为 false。
   * release(id)：只撤销授权，不删除文件；文件跨窗口、变化或超限由主进程拒绝。
   */
  files: {
    /**
     * 打开原生文件选择器，取得当前窗口授权。
     */
    pick: () => call('files.pick'),
    /**
     * 凭不透明 ID 读取有界 UTF-8 文本。
     * id：不透明文件授权 ID 或任务 ID，主进程按方法验证归属。
     */
    readText: (id) => call('files.readText', { id }),
    /**
     * 打开原生另存对话框保存文本。
     * value：待另存的文本对象 {content}。
     */
    saveText: (value) => call('files.saveText', value),
    /**
     * 撤销本窗口单个文件授权。
     * id：不透明文件授权 ID 或任务 ID，主进程按方法验证归属。
     */
    release: (id) => call('files.release', { id }),
  },
  /** set({token,remember}) 显式设置，clear 清除内存/密文；没有读取接口，不能把令牌带回 renderer。 */
  credentials: {
    /**
     * 设置主进程凭据，不向 renderer 返回令牌。
     * value：待设置的凭据对象 {token,remember}，无读取令牌返回值。
     */
    set: (value) => call('credentials.set', value),
    /**
     * 清除内存凭据和旧密文。
     */
    clear: () => call('credentials.clear'),
  },
  /**
   * 调用固定 JSON 请求能力。
   * value：JSON 请求参数 {id,path,method?,body?}。
   */
  request: (value) => call('request', value),
  /**
   * 调用固定授权文件上传能力。
   * value：上传参数 {id,path,fileId,field?}。
   */
  upload: (value) => call('upload', value),
  /**
   * 调用固定可信来源下载能力。
   * value：下载参数 {id,url}。
   */
  download: (value) => call('download', value),
  /**
   * list/cancel 只作用于调用窗口，cancel(id) 可重复调用。
   * subscribe(listener) 收到任务快照或 reset，并返回解绑函数；不转发 Electron 事件对象。
   */
  tasks: {
    /**
     * 读取本窗口公开任务快照。
     */
    list: () => call('tasks.list'),
    /**
     * 幂等取消本窗口指定任务。
     * id：不透明文件授权 ID 或任务 ID，主进程按方法验证归属。
     */
    cancel: (id) => call('tasks.cancel', { id }),
    /**
     * 订阅公开任务事件或上下文 reset。
     * listener：renderer 提供的数据观察器，卸载时必须调用返回的清理函数。
     */
    subscribe: (listener) => subscribe('desktop:task', listener),
  },
  /** 显式读写文本，最多 1 Mi 字符；页面不能在初始化或轮询时偷偷读取用户剪贴板。 */
  clipboard: {
    /**
     * 用户触发时写入文本剪贴板。
     * value：用户显式选择写入剪贴板的文本。
     */
    write: (value) => call('clipboard.write', { value }),
    /**
     * 用户触发时读取有界文本剪贴板。
     */
    read: () => call('clipboard.read'),
  },
  /**
   * 显示有界公开系统通知。
   * value：系统通知参数 {title,body}。
   */
  notify: (value) => call('notify', value),
  /**
   * 经主进程校验与原生确认打开 HTTPS 外链。
   * url：待原生确认的 HTTPS 外链文本。
   */
  openExternal: (url) => call('openExternal', { url }),
  /** get/subscribe 观察状态，run 只允许 check/download/install；install 前的用户确认由页面负责。 */
  updates: {
    /**
     * 读取更新公开状态。
     */
    get: () => call('updates.get'),
    /**
     * 按用户选择请求更新检查、下载或安装。
     * action：用户明确发起的更新动作 check/download/install。
     */
    run: (action) => call('updates.run', { action }),
    /**
     * 订阅公开更新状态变化。
     * listener：renderer 提供的数据观察器，卸载时必须调用返回的清理函数。
     */
    subscribe: (listener) => subscribe('desktop:update', listener),
  },
})
