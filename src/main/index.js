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
const directory = fileURLToPath(new URL('.', import.meta.url))
const config = __DESKTOP_CONFIG__
const development = !app.isPackaged
if (development && process.env.DESKTOP_TEST_USER_DATA) {
  // 仅开发/自动化测试允许隔离目录；正式安装包不接受此环境变量重定向用户数据。
  app.setPath('userData', process.env.DESKTOP_TEST_USER_DATA)
  app.setAppLogsPath(join(process.env.DESKTOP_TEST_USER_DATA, 'logs'))
}
app.setName(config.productName)
if (process.platform === 'win32') app.setAppUserModelId(config.appId)

let window
let tray
let quitting = false
let trustedDocument
let preferences
let bounds
let updates
let storageWarning = ''
let servicesReady = false
let windowClosing = false
let reopenAfterClose = false
const dialogs = new Set()
const grants = new FileGrants()
const tasks = new Tasks((owner, value) => {
  if (window && !window.isDestroyed() && window.webContents.id === owner) {
    window.webContents.send('desktop:task', value)
  }
})

/**
 * @param {unknown} error 待记录错误，只提取 publicError 的代号，不落请求、令牌、路径和堆栈。
 * @returns {Promise<void>} 记录失败不递归记录；文件超过 1 MiB 时先清空，再追加时间与代号。
 * 这是受限诊断记录，不是业务埋点；renderer 提示由 IPC 错误信封单独负责。
 */
async function logError(error) {
  const path = join(app.getPath('logs'), 'framework.log')
  try {
    await mkdir(app.getPath('logs'), { recursive: true })
    const { stat } = await import('node:fs/promises')
    if ((await stat(path).catch(() => ({ size: 0 }))).size > 1024 * 1024) {
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
 */
function preferencesSnapshot() {
  const value = preferences.get()
  if (app.isPackaged) value.launchAtLogin = app.getLoginItemSettings().openAtLogin
  return value
}

/**
 * 应用已校验的主题、缩放与托盘偏好；持久化由外层事务负责。
 * @param {Object} value 完整偏好快照，不能直接传 renderer 的未校验补丁。
 * @param {boolean} [changeLoginItem=false] 仅显式切换启动项时为 true；普通启动和修改外观不能写系统启动项。
 * @returns {Promise<void>} 系统调用失败会向外抛出，由偏好事务恢复上一份实际状态。
 */
async function applyPreferences(value, changeLoginItem = false) {
  nativeTheme.themeSource = value.theme
  window?.webContents.setZoomFactor(value.zoom)
  if (app.isPackaged && changeLoginItem)
    app.setLoginItemSettings({ openAtLogin: value.launchAtLogin })
  if (value.closeToTray && !tray) {
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
        { label: '退出', click: () => app.quit() },
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
 */
function handle(method, operation, nativeDialog = false) {
  ipcMain.handle(`desktop:${method}`, async (event, payload) => {
    let ownsDialog = false
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
      void logError(error)
      return { ok: false, error: publicError(error) }
    } finally {
      if (ownsDialog) dialogs.delete(owner)
    }
  })
}

/**
 * 应用级只注册一次桌面协议；窗口重建时复用这些处理器，实际权限仍由 handle 动态校验。
 * @param {Credentials} credentials 主进程令牌容器，只有 set/clear 对 renderer 开放。
 * @param {Network} network 已固定 API 与下载来源的传输服务。
 * 文件方法只接受授权 ID 或原生保存结果；系统读写只在用户操作触发的通道中执行。
 */
function registerIpc(credentials, network) {
  let preferenceQueue = Promise.resolve()
  handle('info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    packaged: app.isPackaged,
    apiConfigured: Boolean(config.DESKTOP_API_BASE_URL),
    storageWarning,
  }))
  handle('preferences.get', preferencesSnapshot)
  handle('preferences.set', (payload) => {
    const patch = preferencesPatch(payload)
    ensure(app.isPackaged || !patch.launchAtLogin, '开机启动仅在安装后的应用中设置')
    // 整个系统副作用与存储事务串行，不能只给文件写入排队。
    const task = preferenceQueue.then(async () => {
      const previous = preferencesSnapshot()
      const next = { ...previous, ...patch }
      const changeLoginItem = Object.hasOwn(patch, 'launchAtLogin')
      try {
        await applyPreferences(next, changeLoginItem)
        return await preferences.patch({ ...patch, launchAtLogin: next.launchAtLogin })
      } catch (error) {
        await applyPreferences(previous, changeLoginItem)
        throw error
      }
    })
    preferenceQueue = task.catch(() => {})
    return task
  })
  handle(
    'files.pick',
    async (_payload, owner) => {
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
      const selected = []
      try {
        for (const path of result.filePaths) selected.push(await grants.add(owner, path))
        return selected
      } catch (error) {
        // 多文件选择按一批处理，任意文件拒绝时撤销前面已建的授权，避免 UI 拿不到的能力占住名额。
        for (const file of selected) grants.release(owner, file.id)
        throw error
      }
    },
    true,
  )
  handle('files.readText', async (payload, owner) => {
    const file = await grants.read(owner, record(payload).id, 1024 * 1024)
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(file.data)
    } catch {
      throw new AppError('INVALID_ENCODING', '仅支持 UTF-8 文本文件')
    }
  })
  handle('files.release', (payload, owner) => grants.release(owner, record(payload).id))
  handle(
    'files.saveText',
    async (payload) => {
      record(payload)
      const content = text(payload.content, 1024 * 1024, true)
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
  handle('credentials.set', async (payload, owner) => {
    record(payload)
    ensure(typeof payload.remember === 'boolean', 'remember 必须是布尔值')
    const token = text(payload.token, 8192)
    // 先完成输入校验再清理旧上下文，错误输入不能误取消当前正在进行的任务。
    tasks.clear(owner)
    await credentials.set(token, payload.remember)
  })
  handle('credentials.clear', async (_payload, owner) => {
    tasks.clear(owner)
    await credentials.set('')
  })
  handle('request', (payload, owner) => network.request(owner, payload))
  handle('upload', (payload, owner) => network.upload(owner, payload))
  handle(
    'download',
    async (payload, owner) => {
      record(payload)
      return network.download(owner, payload, async () => {
        const result = await dialog.showSaveDialog(window, {
          title: '保存下载文件',
          defaultPath: 'download.bin',
        })
        return result.canceled ? null : result.filePath
      })
    },
    true,
  )
  handle('tasks.list', (_payload, owner) => tasks.list(owner))
  handle('tasks.cancel', (payload, owner) => tasks.cancel(owner, record(payload).id))
  handle('clipboard.write', (payload) =>
    clipboard.writeText(text(record(payload).value, 1024 * 1024, true)),
  )
  handle('clipboard.read', () => {
    const value = clipboard.readText()
    ensure(value.length <= 1024 * 1024, '剪贴板内容过大')
    return value
  })
  handle('notify', (payload) => {
    record(payload)
    ensure(Notification.isSupported(), '当前系统不支持通知', 'UNSUPPORTED')
    new Notification({ title: text(payload.title, 80), body: text(payload.body, 500) }).show()
  })
  handle(
    'openExternal',
    async (payload) => {
      const url = trustedUrl(text(record(payload).url, 2000))
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
  handle('updates.get', () => updates.state)
  handle('updates.run', (payload) => updates.run(text(record(payload).action, 20)))
}

/**
 * 根据当前显示器工作区创建唯一主窗口，保存位置不能使窗口在换屏后完全落到屏幕外。
 * renderer 仅加载本次开发文档或打包 HTML；开启 sandbox/contextIsolation，禁止 Node、webview 和任意新窗口。
 * 最小尺寸按可用工作区夹取，缩放由偏好应用；内容滚动由 Vue 组件控制，原生标题栏保留系统窗口行为。
 */
function createWindow() {
  const previous = bounds.get()
  const area = screen.getDisplayMatching(previous).workArea
  const width = Math.min(Math.max(previous.width, 760), area.width)
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
  const contents = window.webContents
  const owner = contents.id
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event) => event.preventDefault())
  contents.on('will-attach-webview', (event) => event.preventDefault())
  window.once('ready-to-show', () => window.show())
  window.on('close', (event) => {
    if (!quitting && preferences.get().closeToTray) {
      event.preventDefault()
      window.hide()
      return
    }
    windowClosing = true
    void bounds.patch(window.getNormalBounds()).catch(logError)
  })
  window.on('closed', () => {
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
  })
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
  app.on('before-quit', (event) => {
    // 第一次退出等待异步保存；quitting 让后续 app.quit 穿透，避免反复 preventDefault 导致退出死循环。
    if (quitting) return
    quitting = true
    if (window && bounds) {
      event.preventDefault()
      void bounds
        .patch(window.getNormalBounds())
        .catch(logError)
        .finally(() => app.quit())
    }
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app
    .whenReady()
    .then(async () => {
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      )
      session.defaultSession.setPermissionCheckHandler(() => false)
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
      const credentials = new Credentials(
        join(app.getPath('userData'), 'credential.bin'),
        safeStorage,
      )
      for (const store of [preferences, bounds, credentials]) {
        // 单份配置损坏不阻断整个框架启动；保留错误提示与原文件，由后续显式设置恢复。
        try {
          await store.load()
        } catch (error) {
          storageWarning = publicError(error).message
          void logError(error)
        }
      }
      const network = new Network(
        {
          development,
          apiBase: config.DESKTOP_API_BASE_URL ?? '',
          downloadOrigins: (config.DESKTOP_DOWNLOAD_ORIGINS ?? '')
            .split(',')
            .map((item) => item.trim())
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
    })
    .catch(async (error) => {
      await logError(error)
      dialog.showErrorBox('应用启动失败', publicError(error).message)
      app.exit(1)
    })
}
