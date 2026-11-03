# Desktop App Framework

业务无关的 macOS / Windows 桌面应用框架。使用 **Electron + Vue 3 + JavaScript + Element Plus**，不包含自有 TypeScript 源码，不依赖业务后端即可启动。

源码：[wn228664/desktop-app-framework](https://github.com/wn228664/desktop-app-framework) · [自动化验证](https://github.com/wn228664/desktop-app-framework/actions/workflows/desktop.yml)

这是可持续开发的项目基础：包含独立的主进程、受限预加载桥、组件化界面、文件与传输服务、自动化验证和打包配置。演示页只展示框架能力，未接入的服务明确提示未配置。

## 快速开始

要求 Node.js 22.13+，建议使用维护中的 Node.js 22 LTS；npm 10+。在 macOS 或 Windows PowerShell 进入项目目录后运行：

```sh
npm ci
npm run dev
```

`npm ci` 使用锁文件。首次启动 Electron 或首次打包需要联网下载对应平台运行时。所有命令均以项目根目录为工作目录，不需要数据库、账号或后端服务。

```sh
npm run verify        # ESLint、格式、单测、生产构建
npm run test:e2e      # 启动真实 Electron，执行桌面交互验证
npm run start         # 运行已构建的应用；先执行 npm run build
npm run pack:mac      # macOS 应用目录，适合本机冒烟检查
npm run pack:win      # Windows 应用目录
npm run dist:mac      # macOS DMG / ZIP：arm64、x64
npm run dist:win      # Windows NSIS 安装包：x64、arm64
```

生产发布的签名、公证和更新配置见 [平台与发布](docs/PLATFORMS.md)。本机验证范围、构建产物与未覆盖项见 [交付验证](docs/VALIDATION.md)。跨平台配置与跨平台运行验收分开记录。

## 技术选型

| 层         | 选择                                       | 作用                               |
| ---------- | ------------------------------------------ | ---------------------------------- |
| 桌面运行时 | Electron 45                                | macOS、Windows 原生窗口和系统集成  |
| 构建       | electron-vite 6 / Vite 8                   | 主进程、preload、renderer 分离构建 |
| 界面       | Vue 3.5 / Element Plus 2                   | 成熟桌面控件、键盘与焦点管理       |
| 路由与状态 | Vue Router / Pinia                         | Hash 路由、设置与任务状态          |
| 安装与更新 | electron-builder / electron-updater        | 平台安装包和用户触发的更新流程     |
| 质量       | ESLint / Prettier / Node Test / Playwright | 静态检查、核心测试、真实窗口验证   |

依赖采用精确版本和 `package-lock.json`；自有应用代码统一使用 JavaScript / Vue SFC。依赖自身附带的 `.d.ts` 不属于项目 TypeScript 源码。

## 已包含的框架能力

- 固定桌面外壳、原生标题栏与系统菜单、Hash 路由、路由懒加载、未知路由回首页。
- `FrameworkPage`、`StateView`、`AsyncButton`、`SchemaForm`、`SearchForm`、`DataTable`、`ActionDialog`、`FileUpload` 等可复用组件。
- 表格本地/远程加载、分页、排序、稳定行键、行选择、列显隐、刷新与错误重试；搜索条件以提交快照生效。
- 弹窗与抽屉异步提交、防重复、取消、输入与错误保留、关闭后结果失效。
- 可取消动作、输入防抖、格式化、空条件处理、参数与 URL 校验等基础封装。
- 主进程 HTTP 请求、主进程凭据、JSON 有界解析、状态码错误、超时、主动取消、拒绝重定向。
- 原生文件选择授权、文件 ID、窗口隔离、文件变化检查、有界 UTF-8 读取、原子另存。
- 顺序上传、下载白名单、下载进度、任务取消、临时文件清理、有界任务历史。
- 用户触发的剪贴板读写、系统通知、外部 HTTPS 链接确认。
- 明暗主题与跟随系统、紧凑密度、80%～150% 缩放、窗口尺寸恢复与多屏边界处理。
- 托盘与开机启动均默认关闭；用户启用后才应用相应系统行为。
- 偏好白名单、串行配置写入、系统加密凭据可选持久化、有限本地错误日志。
- 更新检查、显式下载、安装前确认；默认不自动下载，不在退出时自动安装。

外壳、`body` 和文档根节点不滚动。页面内容区、表格、弹窗、抽屉在各自容器内滚动。窄窗口、短窗口和界面缩放按实际可用空间重排。

## 目录

```text
src/
  main/                 # 有系统权限：窗口、IPC、文件、网络、凭据、更新
    services/           # 可单测的基础服务
    security.js         # IPC 主框架与文档来源验证
  preload/              # 固定、窄口径的 contextBridge
  shared/               # 错误与输入契约，不依赖 Vue / Electron
  renderer/
    index.html          # CSP，禁止外部脚本与嵌入文档
    src/
      components/       # 通用交互组件
      composables/      # Vue 生命周期封装
      core/             # 动作、桥接、格式化等基础函数
      stores/           # 偏好和任务
      styles/           # 主题、布局与响应式
      views/            # 纯框架演示页，可按需删除
tests/                  # 核心契约、安全边界与故障测试
e2e/                    # 真实 Electron 交互
resources/              # 平台图标和 macOS 权限声明
docs/                   # 架构、组件、API、质量和发布说明
.github/workflows/      # macOS / Windows 验证与构建
```

## 接入你的应用

1. 在 `app.config.json` 统一修改 `appId`、`productName`，主进程和打包器共同读取；`package.json` 管理 npm 名称与版本。图标在 resources/。`appId` 与正式签名身份确定后保持稳定。
2. 从 `.env.example` 复制出 `.env`，按需设置可信 API、下载 origin 和更新地址。只有白名单中的公开配置会编译进主进程，修改后需重新构建，禁止写密钥。更新服务需同时配置发布者与真实签名，见平台文档。
3. 在 `src/renderer/src/router.js` 添加路由，在新模块中使用现有组件；演示页可整体移除，不影响主进程服务。
4. 根据真实接口文档写服务适配。`request()` 返回原始 JSON，框架不猜测业务成功码、登录模型或分页响应字段。
5. 新增系统能力时同时定义主进程校验、preload 固定接口、调用方取消/清理和对应测试。

远程表格示例：

```js
import { request } from './src/renderer/src/core/desktop.js'

// 接口字段必须以你的服务端契约为准；这里仅说明组件需要的返回形状。
async function loadRows({ page, pageSize, query, signal }) {
  const result = await request({
    path: `items?page=${page}&pageSize=${pageSize}&keyword=${encodeURIComponent(query.keyword || '')}`,
    signal,
  })
  return { rows: result.rows, total: result.total }
}
```

详细契约见 [组件使用](docs/COMPONENTS.md) 与 [桌面 API](docs/API.md)。代码约束见 [质量与注释](docs/QUALITY.md)。

## 框架边界

没有预置登录、权限菜单、用户管理、订单、支付、阅读器、第三方客服、统计上报或任意业务接口。没有示例密钥、默认服务端、自动启动系统任务或自动发布流程。演示动作明确标为本地操作。

HTTP 凭据、文件授权和系统能力由主进程持有。渲染层启用沙盒与上下文隔离，不具有 Node 权限，不暴露任意文件路径、任意 IPC 通道或任意外部协议。

## 文档索引

- [架构与扩展](docs/ARCHITECTURE.md)
- [组件与交互契约](docs/COMPONENTS.md)
- [桌面 API、文件与传输](docs/API.md)
- [平台、安装包、签名和更新](docs/PLATFORMS.md)
- [代码质量、注释与验证](docs/QUALITY.md)
- [源码注释整理记录](docs/COMMENT_REVIEW.md)
- [依赖审计](docs/DEPENDENCIES.md)
- [本次交付验证](docs/VALIDATION.md)
- [深入检查与修复记录](docs/DEEP_REVIEW.md)

上游说明：[Electron 安全](https://www.electronjs.org/docs/latest/tutorial/security)、[electron-vite](https://electron-vite.org/)、[Element Plus](https://element-plus.org/)、[electron-builder](https://www.electron.build/)。
