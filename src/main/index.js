import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  safeStorage,
  screen,
  session,
  shell,
  Tray,
} from 'electron'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { appendFile, mkdir } from 'node:fs/promises'
import updaterPackage from 'electron-updater'
import { AppError, publicError } from '../shared/errors.js'
import {
  ensure,
  preferencesPatch,
  defaultPreferences,
  record,
  text,
  trustedUrl,
} from '../shared/validation.js'
import { assertSender } from './security.js'
import { atomicWrite, JsonStore } from './services/storage.js'
import { Credentials } from './services/credentials.js'
import { FileGrants } from './services/file-grants.js'
import { Network } from './services/network.js'
import { Tasks } from './services/tasks.js'
import { Updates } from './services/updates.js'
import { windowBounds } from '../shared/config.js'

/**
 * Electron 主进程入口，拥有系统权限，也是 renderer 与操作系统之间的唯一授权边界。
 * 启动顺序：确定独立数据目录 → 单实例锁 → 加载配置/凭据 → 组装服务与 IPC → 注册原生菜单 → 创建窗口。
 * 创建新窗口只恢复 UI，不重复注册全局 IPC；每次调用仍按当前窗口、主框架和精确文档 URL 校验。
 * 窗口销毁撤销文件授权与任务，凭据跟随主进程生命周期；应用退出前等待窗口几何写入。
 * 修改系统能力时，需同时维护 preload 固定方法、这里的输入校验、renderer 封装及对应测试。
 */
// directory：当前主进程构建文件所在目录，原生资源和 renderer 均相对此处解析。
const directory = fileURLToPath(new URL('.', import.meta.url))
// config：构建阶段注入的公开配置，不能存放业务密钥。
const config = __DESKTOP_CONFIG__
// development：是否为未打包运行，限制测试目录和开发工具能力。
const development = !app.isPackaged
if (development && process.env.DESKTOP_TEST_USER_DATA) {
  // 仅开发/自动化测试允许隔离目录；正式安装包不接受此环境变量重定向用户数据。
  app.setPath('userData', process.env.DESKTOP_TEST_USER_DATA)
  app.setAppLogsPath(join(process.env.DESKTOP_TEST_USER_DATA, 'logs'))
}
app.setName(config.productName)
if (process.platform === 'win32') app.setAppUserModelId(config.appId)

// window：唯一主窗口引用；closed 后清空，重建时不复用旧授权。
let window
// tray：可选系统托盘实例，关闭偏好时立即销毁。
let tray
// quitting：应用退出已开始的标记，让第二次 quit 穿透保存门禁。
let quitting = false
// trustedDocument：本次窗口唯一受信文档 URL，忽略 hash 但精确匹配其余部分。
let trustedDocument
// preferences：非敏感偏好的 JsonStore，磁盘成功后才提交内存。
let preferences
// bounds：窗口普通几何的 JsonStore，不保存最大化后的临时尺寸。
let bounds
// updates：用户驱动的更新状态机实例。
let updates
// storageWarning：启动时存储异常的公开提示，不含文件内容或底层路径。
let storageWarning = ''
// servicesReady：配置和服务已初始化的门禁，激活事件不能抢先创建窗口。
let servicesReady = false
// windowClosing：当前窗口正在关闭的标记，阻止展示即将销毁的窗口。
let windowClosing = false
// reopenAfterClose：关闭期间收到的单次重新显示意图，在清理旧窗口后兑现。
let reopenAfterClose = false
// dialogs：正持有原生交互的窗口集合，同窗口只能有一个原生对话框周期。
const dialogs = new Set()
// grants：仅主进程可访问的文件授权表，窗口关闭时撤销。
const grants = new FileGrants()
// tasks：主进程任务注册表，向所属存活窗口发布公开状态。
const tasks = new Tasks(
  /**
   * 只向任务所属的存活窗口投递公开任务事件。
   * owner：Electron 提供的调用窗口 webContents.id，用于任务和文件能力归属。
   * value：去掉私有 owner 的任务事件或 reset 信号。
   */
  (owner, value) => {
    if (window && !window.isDestroyed() && window.webContents.id === owner) {
      window.webContents.send('desktop:task', value)
    }
  },
)

/**
 * @param {unknown} error 待记录错误，只提取 publicError 的代号，不落请求、令牌、路径和堆栈。
 * @returns {Promise<void>} 记录失败不递归记录；文件超过 1 MiB 时先清空，再追加时间与代号。
 * 这是受限诊断记录，不是业务埋点；renderer 提示由 IPC 错误信封单独负责。
 *
 * 记录脱敏错误代号，日志限体积，失败不递归。
 */
async function logError(error) {
  // path：由主进程构造的日志或选择器批准的文件绝对路径，不能向 renderer 泄露。
  const path = join(app.getPath('logs'), 'framework.log')
  try {
    await mkdir(app.getPath('logs'), { recursive: true })
    // stat：按需加载的文件状态函数，仅检查日志体积。
    const { stat } = await import('node:fs/promises')
    if (
      (
        await stat(path).catch(
          /**
           * 日志文件状态无法读取时按零体积处理，实际追加仍由外层捕获失败。
           */
          () => ({ size: 0 }),
        )
      ).size >
      1024 * 1024
    ) {
      await atomicWrite(path, '')
    }
    await appendFile(path, `${new Date().toISOString()} ${publicError(error).code}\n`)
  } catch {
    /* 日志失败不递归记录，业务错误仍返回调用方。 */
  }
}

/**
 * @returns {Object} 偏好副本，安装包中以系统实际启动项状态覆盖旧存储值。
 * 查询本身不注册/移除启动项，尊重用户在系统设置中做出的变更。
 *
 * 返回偏好副本，安装包的开机启动以系统实际状态为准。
 */
function preferencesSnapshot() {
  // value：当前偏好副本，用系统实际登录启动状态覆盖安装包快照。
  const value = preferences.get()
  if (app.isPackaged) value.launchAtLogin = app.getLoginItemSettings().openAtLogin
  return value
}

/**
 * 应用已校验的主题、缩放与托盘偏好；持久化由外层事务负责。
 * @param {Object} value 完整偏好快照，不能直接传 renderer 的未校验补丁。
 * @param {boolean} [changeLoginItem=false] 仅显式切换启动项时为 true；普通启动和修改外观不能写系统启动项。
 * @returns {Promise<void>} 系统调用失败会向外抛出，由偏好事务恢复上一份实际状态。
 *
 * 应用已校验偏好，启动项仅在本次显式变更时写入，托盘按需创建或销毁。
 */
async function applyPreferences(value, changeLoginItem = false) {
  nativeTheme.themeSource = value.theme
  window?.webContents.setZoomFactor(value.zoom)
  if (app.isPackaged && changeLoginItem)
    app.setLoginItemSettings({ openAtLogin: value.launchAtLogin })
  if (value.closeToTray && !tray) {
    // image：原生托盘图像，macOS 使用模板图标适配系统外观。
    const image = nativeImage.createFromPath(
      join(
        directory,
        process.platform === 'darwin'
          ? '../../resources/trayTemplate.png'
          : '../../resources/icon.png',
      ),
    )
    if (process.platform === 'darwin') image.setTemplateImage(true)
    tray = new Tray(image)
    tray.setToolTip(config.productName)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: '显示窗口',
          click: showWindow,
        },
        {
          label: '退出',

          /**
           * 托盘退出菜单走标准应用退出链。
           */
          click: () => app.quit(),
        },
      ]),
    )
    tray.on('click', showWindow)
  } else if (!value.closeToTray && tray) {
    tray.destroy()
    tray = null
  }
}

/**
 * 统一响应应用激活、第二实例和托盘显示，先恢复最小化状态再显示和聚焦。
 * 关闭中只登记一次重开意图，由 closed 完成清理后执行，避免展示马上要销毁的旧窗口。
 * 服务尚未就绪时不抢先创建窗口，正常启动链会负责首次显示。
 *
 * 统一显示、激活与重建窗口，先完成旧窗口清理。
 */
function showWindow() {
  if (windowClosing) {
    reopenAfterClose = true
    return
  }
  if (!window) {
    if (servicesReady) createWindow()
    return
  }
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

/**
 * 注册固定 IPC 通道。operation 的参数来自不受信任的 renderer，必须在具体操作中继续校验。
 * @param {string} method desktop: 后的固定方法名，不允许 renderer 自定义通道。
 * @param {Function} operation 接收 (payload,owner)，owner 从 Electron 事件获取，禁止使用客户端自报 ID。
 * @param {boolean} [nativeDialog=false] 在整个 operation Promise 期间保留本窗口的原生交互互斥锁。
 * @returns {void} 回调统一返回成功/公开失败信封，窗口销毁后也不在 finally 再读取 sender 的原生属性。
 *
 * 为固定 IPC 方法安装统一身份校验、公开信封和原生交互互斥。
 */
function handle(method, operation, nativeDialog = false) {
  ipcMain.handle(
    `desktop:${method}`,
    /**
     * 读取可信 owner，执行具体操作，失败脱敏且 finally 释放本次持有的对话框锁。
     * event：Electron 提供的原生事件，用于校验 sender 或阻止默认窗口行为。
     * payload：renderer 传入的未信任载荷，具体 IPC 处理器必须继续验证字段。
     */
    async (event, payload) => {
      // ownsDialog：本调用是否取得原生对话框锁，finally 只释放自己的锁。
      let ownsDialog = false
      // owner：Electron 提供的调用窗口 webContents.id，用于任务和文件能力归属。
      const owner = event.sender.id
      try {
        assertSender(event, window, trustedDocument)
        if (nativeDialog) {
          ensure(!dialogs.has(owner), '请先完成当前文件对话框', 'BUSY')
          dialogs.add(owner)
          ownsDialog = true
        }
        return { ok: true, data: await operation(payload, owner) }
      } catch (error) {
        // error：当前捕获的异常；跨 IPC 只交付 publicError 的公开字段。

        void logError(error)
        return { ok: false, error: publicError(error) }
      } finally {
        if (ownsDialog) dialogs.delete(owner)
      }
    },
  )
}

/**
 * 应用级只注册一次桌面协议；窗口重建时复用这些处理器，实际权限仍由 handle 动态校验。
 * @param {Credentials} credentials 主进程令牌容器，只有 set/clear 对 renderer 开放。
 * @param {Network} network 已固定 API 与下载来源的传输服务。
 * 文件方法只接受授权 ID 或原生保存结果；系统读写只在用户操作触发的通道中执行。
 *
 * 应用级注册固定桌面协议；窗口重建继续复用处理器。
 */
function registerIpc(credentials, network) {
  // preferenceQueue：将系统设置副作用和偏好落盘一起串行处理的 Promise 尾部。
  let preferenceQueue = Promise.resolve()
  handle(
    'info',
    /**
     * 读取公开应用和平台能力状态，不返回令牌或用户路径。
     */
    () => ({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      packaged: app.isPackaged,
      apiConfigured: Boolean(config.DESKTOP_API_BASE_URL),
      storageWarning,
    }),
  )
  handle('preferences.get', preferencesSnapshot)
  handle(
    'preferences.set',
    /**
     * 验证偏好补丁并排队系统/磁盘事务。
     * payload：renderer 传入的未信任载荷，具体 IPC 处理器必须继续验证字段。
     */
    (payload) => {
      // patch：已通过白名单校验的偏好补丁。
      const patch = preferencesPatch(payload)
      ensure(app.isPackaged || !patch.launchAtLogin, '开机启动仅在安装后的应用中设置')
      // 整个系统副作用与存储事务串行，不能只给文件写入排队。
      // task：本笔排队的偏好事务 Promise，失败向调用方拒绝。
      const task = preferenceQueue.then(
        /**
         * 先应用系统设置再落盘，失败恢复之前实际偏好并继续拒绝。
         */
        async () => {
          // previous：本次操作前的偏好或窗口几何快照，具体由所在函数读取。
          const previous = preferencesSnapshot()
          // next：本笔事务合并后的完整偏好，先应用系统再提交存储。
          const next = { ...previous, ...patch }
          // changeLoginItem：本补丁是否明确包含 launchAtLogin，普通外观变更不能写系统启动项。
          const changeLoginItem = Object.hasOwn(patch, 'launchAtLogin')
          try {
            await applyPreferences(next, changeLoginItem)
            return await preferences.patch({ ...patch, launchAtLogin: next.launchAtLogin })
          } catch (error) {
            // error：当前捕获的异常；跨 IPC 只交付 publicError 的公开字段。

            await applyPreferences(previous, changeLoginItem)
            throw error
          }
        },
      )
      preferenceQueue = task.catch(
        /**
         * 消费尾部失败以保持后续偏好事务可执行，本笔 task 仍向调用方拒绝。
         */
        () => {},
      )
      return task
    },
  )
  handle(
    'files.pick',
    /**
     * 原生选择文件后逐个建授权，任一失败撤销本批已建授权。
     * _payload：此无参数 IPC 方法忽略的载荷，窗口身份仍取 Electron 事件。
     * owner：Electron 提供的调用窗口 webContents.id，用于任务和文件能力归属。
     */
    async (_payload, owner) => {
      // result：原生多文件选择器结果，取消时不创建授权。
      const result = await dialog.showOpenDialog(window, {
        title: '选择文件',
        properties: ['openFile', 'multiSelections'],
      })
      if (result.canceled) return []
      ensure(
        window && !window.isDestroyed() && window.webContents.id === owner,
        '文件选择窗口已关闭',
        'CANCELLED',
      )
      ensure(result.filePaths.length <= 10, '一次最多选择 10 个文件')
      // selected：本次多选已建成的文件授权，任一后续文件失败时整批撤销。
      const selected = []
      try {
        // path：由主进程构造的日志或选择器批准的文件绝对路径，不能向 renderer 泄露。
        for (const path of result.filePaths) selected.push(await grants.add(owner, path))
        return selected
      } catch (error) {
        // error：当前捕获的异常；跨 IPC 只交付 publicError 的公开字段。

        // 多文件选择按一批处理，任意文件拒绝时撤销前面已建的授权，避免 UI 拿不到的能力占住名额。
        // file：文件授权或读取结果，只含本调用所需的 id/名称/字节。
        for (const file of selected) grants.release(owner, file.id)
        throw error
      }
    },
    true,
  )
  handle(
    'files.readText',
    /**
     * 以当前窗口授权读取有界文件并严格按 UTF-8 解码。
     * payload：renderer 传入的未信任载荷，具体 IPC 处理器必须继续验证字段。
     * owner：Electron 提供的调用窗口 webContents.id，用于任务和文件能力归属。
     */
    async (payload, owner) => {
      // file：文件授权或读取结果，只含本调用所需的 id/名称/字节。
      const file = await grants.read(owner, record(payload).id, 1024 * 1024)
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(file.data)
      } catch {
        throw new AppError('INVALID_ENCODING', '仅支持 UTF-8 文本文件')
      }
    },
  )
  handle(
    'files.release',
    /**
     * 只撤销当前窗口持有的指定文件授权。
     * payload：renderer 传入的未信任载荷，具体 IPC 处理器必须继续验证字段。
     * owner：Electron 提供的调用窗口 webContents.id，用于任务和文件能力归属。
     */
    (payload, owner) => grants.release(owner, record(payload).id),
  )
  handle(
    'files.saveText',
    /**
     * 原生确认保存目标后原子写入校验后的文本；取消无写入。
     * payload：renderer 传入的未信任载荷，具体 IPC 处理器必须继续验证字段。
     */
    async (payload) => {
      record(payload)
      // content：经过类型和最大长度校验的另存文本。
      const content = text(payload.content, 1024 * 1024, true)
      // result：原生另存为结果，只有 filePath 明确存在才写入。
      const result = await dialog.showSaveDialog(window, {
        title: '保存文本',
        defaultPath: 'document.txt',
      })
      if (result.canceled || !result.filePath) return { saved: false }
      await atomicWrite(result.filePath, content)
      return { saved: true }
    },
    true,
  )
  handle(
    'credentials.set',
    /**
     * 验证令牌输入后清理旧任务上下文，再切换凭据。
     * payload：renderer 传入的未信任载荷，具体 IPC 处理器必须继续验证字段。
     * owner：Electron 提供的调用窗口 webContents.id，用于任务和文件能力归属。
     */
    async (payload, owner) => {
      record(payload)
      ensure(typeof payload.remember === 'boolean', 'remember 必须是布尔值')
      // token：已校验但仅保留主进程的访问令牌，不能记录日志。
      const token = text(payload.token, 8192)
      // 先完成输入校验再清理旧上下文，错误输入不能误取消当前正在进行的任务。
      tasks.clear(owner)
      await credentials.set(token, payload.remember)
    },
  )
  handle(
    'credentials.clear',
    /**
     * 清理窗口任务上下文并删除内存及旧密文凭据。
     * _payload：此无参数 IPC 方法忽略的载荷，窗口身份仍取 Electron 事件。
     * owner：Electron 提供的调用窗口 webContents.id，用于任务和文件能力归属。
     */
    async (_payload, owner) => {
      tasks.clear(owner)
      await credentials.set('')
    },
  )
  handle(
    'request',
    /**
     * 将校验责任交给固定 Network JSON 请求入口。
     * payload：renderer 传入的未信任载荷，具体 IPC 处理器必须继续验证字段。
     * owner：Electron 提供的调用窗口 webContents.id，用于任务和文件能力归属。
     */
    (payload, owner) => network.request(owner, payload),
  )
  handle(
    'upload',
    /**
     * 将授权文件上传交给固定 Network 上传入口。
     * payload：renderer 传入的未信任载荷，具体 IPC 处理器必须继续验证字段。
     * owner：Electron 提供的调用窗口 webContents.id，用于任务和文件能力归属。
     */
    (payload, owner) => network.upload(owner, payload),
  )
  handle(
    'download',
    /**
     * 启动下载并由原生保存选择器决定目标路径。
     * payload：renderer 传入的未信任载荷，具体 IPC 处理器必须继续验证字段。
     * owner：Electron 提供的调用窗口 webContents.id，用于任务和文件能力归属。
     */
    async (payload, owner) => {
      record(payload)
      return network.download(
        owner,
        payload,
        /**
         * 提供下载保存目标，用户取消时返回 null。
         */
        async () => {
          // result：下载保存选择器结果，取消时交给 Network 返回 saved:false。
          const result = await dialog.showSaveDialog(window, {
            title: '保存下载文件',
            defaultPath: 'download.bin',
          })
          return result.canceled ? null : result.filePath
        },
      )
    },
    true,
  )
  handle(
    'tasks.list',
    /**
     * 返回仅属于当前窗口的公开任务快照。
     * _payload：此无参数 IPC 方法忽略的载荷，窗口身份仍取 Electron 事件。
     * owner：Electron 提供的调用窗口 webContents.id，用于任务和文件能力归属。
     */
    (_payload, owner) => tasks.list(owner),
  )
  handle(
    'tasks.cancel',
    /**
     * 请求取消当前窗口持有的指定任务。
     * payload：renderer 传入的未信任载荷，具体 IPC 处理器必须继续验证字段。
     * owner：Electron 提供的调用窗口 webContents.id，用于任务和文件能力归属。
     */
    (payload, owner) => tasks.cancel(owner, record(payload).id),
  )
  handle(
    'clipboard.write',
    /**
     * 显式校验后写入文本剪贴板，不接受任意格式。
     * payload：renderer 传入的未信任载荷，具体 IPC 处理器必须继续验证字段。
     */
    (payload) => clipboard.writeText(text(record(payload).value, 1024 * 1024, true)),
  )
  handle(
    'clipboard.read',
    /**
     * 用户触发时读取文本剪贴板并执行长度限制。
     */
    () => {
      // value：用户显式触发读取的剪贴板文本，长度超过上限必须拒绝。
      const value = clipboard.readText()
      ensure(value.length <= 1024 * 1024, '剪贴板内容过大')
      return value
    },
  )
  handle(
    'notify',
    /**
     * 确认系统支持后显示有界标题与正文的通知。
     * payload：renderer 传入的未信任载荷，具体 IPC 处理器必须继续验证字段。
     */
    (payload) => {
      record(payload)
      ensure(Notification.isSupported(), '当前系统不支持通知', 'UNSUPPORTED')
      new Notification({ title: text(payload.title, 80), body: text(payload.body, 500) }).show()
    },
  )
  handle(
    'openExternal',
    /**
     * 校验 HTTPS 外链并经原生二次确认后交给系统浏览器。
     * payload：renderer 传入的未信任载荷，具体 IPC 处理器必须继续验证字段。
     */
    async (payload) => {
      // url：通过可信协议校验的外链 URL，系统打开前仍需原生确认。
      const url = trustedUrl(text(record(payload).url, 2000))
      // result：外链确认结果，仅 response=1 才交系统浏览器。
      const result = await dialog.showMessageBox(window, {
        type: 'question',
        title: '打开外部链接',
        message: `使用默认浏览器打开 ${url.hostname}？`,
        detail: url.href,
        buttons: ['取消', '打开'],
        defaultId: 0,
        cancelId: 0,
      })
      if (result.response === 1) await shell.openExternal(url.href)
    },
    true,
  )
  handle(
    'updates.get',
    /**
     * 返回更新状态机当前公开状态。
     */
    () => updates.state,
  )
  handle(
    'updates.run',
    /**
     * 只把有界动作文本交给更新状态机，合法动作由状态机决定。
     * payload：renderer 传入的未信任载荷，具体 IPC 处理器必须继续验证字段。
     */
    (payload) => updates.run(text(record(payload).action, 20)),
  )
}

/**
 * 根据当前显示器工作区创建唯一主窗口，保存位置不能使窗口在换屏后完全落到屏幕外。
 * renderer 仅加载本次开发文档或打包 HTML；开启 sandbox/contextIsolation，禁止 Node、webview 和任意新窗口。
 * 最小尺寸按可用工作区夹取，缩放由偏好应用；内容滚动由 Vue 组件控制，原生标题栏保留系统窗口行为。
 *
 * 按当前工作区恢复唯一主窗口，安装生命周期和安全边界。
 */
function createWindow() {
  // previous：上一次成功保存的正常窗口几何。
  const previous = bounds.get()
  // area：与保存位置相匹配的显示器工作区，用于夹取窗口位置和尺寸。
  const area = screen.getDisplayMatching(previous).workArea
  // width：按最小值与当前工作区上限夹取后的窗口宽度。
  const width = Math.min(Math.max(previous.width, 760), area.width)
  // height：按最小值与当前工作区上限夹取后的窗口高度。
  const height = Math.min(Math.max(previous.height, 540), area.height)
  window = new BrowserWindow({
    title: config.productName,
    show: false,
    width,
    height,
    x: Math.max(area.x, Math.min(previous.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(previous.y, area.y + area.height - height)),
    minWidth: Math.min(760, area.width),
    minHeight: Math.min(540, area.height),
    backgroundColor: '#f4f6fa',
    icon: join(directory, '../../resources/icon.png'),
    webPreferences: {
      preload: join(directory, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: development,
    },
  })
  // contents：本窗口 webContents，权限与事件绑定到此实例。
  const contents = window.webContents
  // owner：Electron 提供的调用窗口 webContents.id，用于任务和文件能力归属。
  const owner = contents.id
  contents.setWindowOpenHandler(
    /**
     * 拒绝 renderer 打开任意新窗口。
     */
    () => ({ action: 'deny' }),
  )
  contents.on(
    'will-navigate',
    /**
     * 阻止 renderer 文档自行导航离开可信页面。
     * event：Electron 提供的原生事件，用于校验 sender 或阻止默认窗口行为。
     */
    (event) => event.preventDefault(),
  )
  contents.on(
    'will-attach-webview',
    /**
     * 阻止附加 webview 获得额外宿主能力。
     * event：Electron 提供的原生事件，用于校验 sender 或阻止默认窗口行为。
     */
    (event) => event.preventDefault(),
  )
  window.once(
    'ready-to-show',
    /**
     * 窗口就绪后再显示，避免闪烁未初始化内容。
     */
    () => window.show(),
  )
  window.on(
    'close',
    /**
     * 托盘模式拦截关闭并隐藏，否则登记关闭并排队保存普通几何。
     * event：Electron 提供的原生事件，用于校验 sender 或阻止默认窗口行为。
     */
    (event) => {
      if (!quitting && preferences.get().closeToTray) {
        event.preventDefault()
        window.hide()
        return
      }
      windowClosing = true
      void bounds.patch(window.getNormalBounds()).catch(logError)
    },
  )
  window.on(
    'closed',
    /**
     * 撤销旧窗口文件、任务和原生锁，再按激活意图重建。
     */
    () => {
      // 必须先撤销旧 owner 的能力，再创建重开窗口，不能把旧授权/进度交给新 webContents。
      grants.clear(owner)
      tasks.clear(owner)
      dialogs.delete(owner)
      window = null
      windowClosing = false
      if (reopenAfterClose && !quitting) {
        reopenAfterClose = false
        createWindow()
      }
    },
  )
  // document：打包 renderer 的绝对 HTML 路径，用于形成精确可信 URL。
  const document = join(directory, '../renderer/index.html')
  trustedDocument =
    development && process.env.ELECTRON_RENDERER_URL
      ? `${process.env.ELECTRON_RENDERER_URL.replace(/\/$/, '')}/`
      : pathToFileURL(document).href
  if (development && process.env.ELECTRON_RENDERER_URL) void window.loadURL(trustedDocument)
  else void window.loadFile(document)
  void applyPreferences(preferences.get()).catch(logError)
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', showWindow)
  app.on(
    'before-quit',
    /**
     * 退出前保存窗口几何，只在首次退出时阻止默认退出。
     * event：Electron 提供的原生事件，用于校验 sender 或阻止默认窗口行为。
     */
    (event) => {
      // 第一次退出等待异步保存；quitting 让后续 app.quit 穿透，避免反复 preventDefault 导致退出死循环。
      if (quitting) return
      quitting = true
      if (window && bounds) {
        event.preventDefault()
        void bounds
          .patch(window.getNormalBounds())
          .catch(logError)
          .finally(
            /**
             * 几何保存链完成后再次触发标准退出。
             */
            () => app.quit(),
          )
      }
    },
  )
  app.on(
    'window-all-closed',
    /**
     * 所有窗口关闭时，Windows 退出；macOS 维持应用等待激活。
     */
    () => {
      if (process.platform !== 'darwin') app.quit()
    },
  )
  app
    .whenReady()
    .then(
      /**
       * 按配置、凭据、服务、菜单、窗口的依赖顺序初始化应用。
       */
      async () => {
        session.defaultSession.setPermissionRequestHandler(
          /**
           * 默认拒绝未经框架显式设计的系统权限请求。
           * _contents：权限请求提供的窗口上下文；框架统一拒绝而不授予额外能力。
           * _permission：平台请求的权限名称；框架未声明额外许可，统一拒绝。
           * callback：Electron 权限决策入口，此框架始终传 false。
           */
          (_contents, _permission, callback) => callback(false),
        )
        session.defaultSession.setPermissionCheckHandler(
          /**
           * 同步权限检查同样默认拒绝。
           */
          () => false,
        )
        preferences = new JsonStore(
          join(app.getPath('userData'), 'preferences.json'),
          defaultPreferences,
          preferencesPatch,
        )
        bounds = new JsonStore(
          join(app.getPath('userData'), 'window.json'),
          { x: 80, y: 80, width: 1240, height: 820 },
          windowBounds,
        )
        // credentials：主进程凭据容器，恢复失败时保留公开警告并允许显式重设。
        const credentials = new Credentials(
          join(app.getPath('userData'), 'credential.bin'),
          safeStorage,
        )
        // store：当前启动加载的偏好、几何或凭据存储实例。
        for (const store of [preferences, bounds, credentials]) {
          // 单份配置损坏不阻断整个框架启动；保留错误提示与原文件，由后续显式设置恢复。
          try {
            await store.load()
          } catch (error) {
            // error：当前捕获的异常；跨 IPC 只交付 publicError 的公开字段。

            storageWarning = publicError(error).message
            void logError(error)
          }
        }
        // network：组合固定来源、凭据、文件授权和任务注册表的传输服务。
        const network = new Network(
          {
            development,
            apiBase: config.DESKTOP_API_BASE_URL ?? '',
            downloadOrigins: (config.DESKTOP_DOWNLOAD_ORIGINS ?? '')
              .split(',')
              .map(
                /**
                 * 标准化下载来源条目的空白。
                 * item：逗号分隔的下载 origin 配置项，去掉前后空白后再交传输服务。
                 */
                (item) => item.trim(),
              )
              .filter(Boolean),
          },
          credentials,
          grants,
          tasks,
        )
        updates = new Updates(
          updaterPackage.autoUpdater,
          config.DESKTOP_UPDATE_URL,
          app.isPackaged,
          /**
           * 向当前窗口转发已脱敏更新状态。
           * value：更新状态机发出的公开状态，仅转发当前窗口。
           */
          (value) => {
            window?.webContents.send('desktop:update', value)
          },
        )
        registerIpc(credentials, network)
        Menu.setApplicationMenu(
          Menu.buildFromTemplate([
            ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
            { label: '文件', submenu: [{ role: 'close' }, { role: 'quit' }] },
            {
              label: '编辑',
              submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' },
              ],
            },
            {
              label: '视图',
              submenu: [
                { role: 'togglefullscreen' },
                ...(development ? [{ role: 'toggleDevTools' }] : []),
              ],
            },
            { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
          ]),
        )
        servicesReady = true
        createWindow()
        app.on('activate', showWindow)
      },
    )
    .catch(
      /**
       * 启动失败时记录公开错误、显示原生说明并非零退出。
       * error：当前捕获的异常；跨 IPC 只交付 publicError 的公开字段。
       */
      async (error) => {
        await logError(error)
        dialog.showErrorBox('应用启动失败', publicError(error).message)
        app.exit(1)
      },
    )
}
