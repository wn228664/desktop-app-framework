# 桌面 API 与基础封装

## 调用方式

preload 公开 `window.desktop`，每个调用返回 `{ok:true,data}` 或 `{ok:false,error:{code,message,details?}}`。通常通过 renderer 的 `unwrap()` 调用，把失败信封转成 Error。

```js
import { unwrap } from '../core/desktop.js'

const info = await unwrap((api) => api.info())
const preferences = await unwrap((api) => api.preferences.get())
await unwrap((api) => api.preferences.set({ theme: 'dark' }))
```

不要直接导入 ipcRenderer，也不要给桥添加 `invoke(channel, ...)`、任意 shell、任意文件路径或任意 HTTP URL 的接口。

## 接口清单

| 方法                              | 参数                                  | 返回 / 行为                                                          |
| --------------------------------- | ------------------------------------- | -------------------------------------------------------------------- |
| info()                            | 无                                    | 应用版本、系统、架构、运行时版本、是否安装包、API 配置状态、存储告警 |
| preferences.get()                 | 无                                    | 偏好快照                                                             |
| preferences.set(patch)            | 白名单字段                            | 成功持久化后的完整快照                                               |
| files.pick()                      | 无                                    | 原生多选，取消返回 []，成功返回 [{id,name,size}]                     |
| files.readText(id)                | 窗口授权 ID                           | UTF-8 文本，最多 1 MiB                                               |
| files.saveText({content})         | 文本，最多 1 Mi 个字符                | 原生另存，返回 {saved}；写入失败拒绝                                 |
| files.release(id)                 | 授权 ID                               | 释放本窗口的文件授权，重复调用安全                                   |
| credentials.set({token,remember}) | token 最多 8192 字符；remember 布尔值 | 主进程设置令牌，清理进行中请求                                       |
| credentials.clear()               | 无                                    | 清空内存与磁盘令牌，并取消旧任务                                     |
| request(options)                  | 见下文                                | 原始 JSON；不解析业务成功码                                          |
| upload(options)                   | id、path、fileId、field               | multipart POST 的 JSON 响应                                          |
| download(options)                 | id、url                               | 可信来源下载，原生另存，返回 {saved}                                 |
| tasks.list()                      | 无                                    | 当前窗口任务，最多 50 条完成历史 + 进行中任务                        |
| tasks.cancel(id)                  | 自己的任务 ID                         | 幂等取消；不能取消其他窗口任务                                       |
| tasks.subscribe(fn)               | 回调                                  | unsubscribe 函数；只推送数据，不暴露 IPC event                       |
| clipboard.write(value)            | 文本，最多 1 Mi 个字符                | 用户触发的写入                                                       |
| clipboard.read()                  | 无                                    | 当前剪贴板文本，最多 1 Mi 个字符                                     |
| notify({title,body})              | 标题最多 80、正文最多 500 字符        | 系统通知；系统可抑制展示                                             |
| openExternal(url)                 | HTTPS URL，最多 2000 字符             | 用户确认后交给系统浏览器                                             |
| updates.get()                     | 无                                    | 更新状态                                                             |
| updates.run(action)               | check / download / install            | 执行当前状态允许的操作                                               |
| updates.subscribe(fn)             | 回调                                  | unsubscribe 函数                                                     |

## 请求

```js
import { request } from '../core/desktop.js'

const controller = new AbortController()
const result = await request({
  path: 'resources',
  method: 'POST',
  body: { name: '由接入方定义' },
  signal: controller.signal,
})
// 离开页面或用户取消时：controller.abort()
```

`path` 仅支持 API 基址下的相对路径；GET 不允许 body。支持 GET/POST/PUT/PATCH/DELETE，请求体最大 1 MiB，JSON 响应最大 5 MiB，超时 60 秒。204 返回 null；其他成功响应必须是合法 JSON。

请求体在 renderer 先取 JSON 快照，支持 Vue reactive 对象，避免 IPC 克隆 Proxy 失败。循环引用等不可序列化输入返回 INVALID_ARGUMENT；发送后的草稿修改不影响已经提交的请求体。

renderer 帮助函数自动生成请求 ID，绑定 AbortSignal。底层桥调用需提供 8～80 字符的安全 ID。取消在主进程中执行，窗口关闭也会取消。写操作不自动重试，取消不代表远端已经回滚。

固定请求头只包含必要的 Content-Type 与主进程持有的 Bearer 令牌。框架不允许 renderer 传任意 Host、Authorization、代理或重定向策略。若接口需要自定义契约，新增严格白名单字段及测试。

## 文件和传输

文件选择返回授权句柄，没有绝对路径。授权窗口、大小、修改时间共同检查；授权后文件变化需重新选择。不支持以文本接口读取二进制或任意系统文件。

上传：

```js
import { transfer } from '../core/desktop.js'
await transfer('upload', { path: 'uploads', fileId, field: 'file' }, signal)
```

上传单文件最大 20 MiB，使用有界内存组装 FormData，超时 120 秒。成功响应同样需合法 JSON。大文件/分片/断点续传需独立扩展，不能直接提升上限而不重新评估内存和取消。

下载：

```js
await transfer('download', { url: 'https://your-approved-origin.example/file' }, signal)
```

下载必须属于 `DESKTOP_DOWNLOAD_ORIGINS` 白名单，不携带 API 令牌，禁重定向。保存对话框取消不发请求；下载最多 512 MiB，超时 300 秒。数据写到同目录临时文件，完成后替换，失败/取消清理临时文件，不提前截断原文件。

取消任务可以发生在保存对话框打开期间；系统对话框本身不由任务关闭，但返回后不会继续下载。原生对话框按窗口互斥，避免重复唤起。

任务状态为 running / success / cancelled / failed，进度字段为 completed / total（字节）。未知总量显示不定进度。`owner` 不公开给 renderer。窗口/凭据上下文清理时，订阅会收到 `{type:'reset'}`，调用方应撤销旧任务展示；Pinia 封装已处理该事件及快照竞态。UI 保留最多 50 条完成历史和全部进行中任务，不因历史达到上限隐藏取消入口。

## 偏好与凭据

偏好字段：theme=system/light/dark、compact=false、closeToTray=false、launchAtLogin=false、zoom=0.8/1/1.25/1.5。未知键和值类型直接拒绝。配置通过串行原子写入保存，调用方拿到成功快照后更新显示。

默认数据目录由 `app.getPath('userData')` 决定；应用名默认来自 app.config.json 的 Desktop Framework，macOS 通常位于 `~/Library/Application Support/Desktop Framework`，Windows 通常位于 `%APPDATA%/Desktop Framework`。以平台实际 Electron 返回值为准。

- preferences.json：非敏感偏好。
- window.json：窗口普通尺寸与位置。
- credential.bin：仅用户显式启用 remember 后存在，使用 Electron safeStorage 异步加密。

默认令牌只保存在内存。系统加密不可用时拒绝保存，禁止明文降级。磁盘凭据无法解密时显示告警，要求重新设置；不会把加密内容复制到浏览器存储。macOS 正式签名身份需稳定，避免 Keychain 在构建变更后重复要求授权。

系统加密的威胁边界因平台而异，不能把本地加密当成抵御同一用户下所有恶意软件的保险箱。参阅 [safeStorage 官方说明](https://www.electronjs.org/docs/latest/api/safe-storage)。

## 错误

常见 code：INVALID_ARGUMENT、NOT_CONFIGURED、FORBIDDEN、BUSY、CANCELLED、TIMEOUT、HTTP_ERROR、INVALID_RESPONSE、RESPONSE_TOO_LARGE、FILE_GRANT_EXPIRED、FILE_CHANGED、INVALID_ENCODING、STORAGE_CORRUPT、ENCRYPTION_UNAVAILABLE、CREDENTIAL_UNAVAILABLE、INVALID_STATE、UNSUPPORTED、INTERNAL。

HTTP_ERROR 的 details 只包含 status。业务登录失效、限流和错误码处理应按真实接口契约放在应用适配层；不要在通用请求层猜测 `code=0` 等规则。
