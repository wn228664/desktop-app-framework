# macOS、Windows 与发布

当前锁定的 Electron 45.2.1 官方 npm 包声明支持 macOS Ventura（13）及以上、Windows 10 及以上；不覆盖更早系统。本项目配置 macOS Intel / Apple Silicon 和 Windows x64 / arm64，实际验收范围见 VALIDATION.md。

## 开发与打包矩阵

| 平台                | 开发        | 配置产物            | 建议发布机器                       |
| ------------------- | ----------- | ------------------- | ---------------------------------- |
| macOS arm64 / x64   | npm run dev | .app、DMG、ZIP      | macOS 对应架构或受支持交叉构建环境 |
| Windows x64 / arm64 | npm run dev | 应用目录、NSIS .exe | Windows 对应架构环境               |

原生标题栏、编辑菜单、窗口缩放/最小化、应用单实例、托盘、通知、文件对话框和剪贴板均通过 Electron API 实现，避免用 Web 样式模拟系统行为。

在 macOS 上成功生成 Windows 目录，只能证明包结构和目标运行时下载成功，不能证明 exe 已在 Windows 启动。Windows 安装、通知、启动项、托盘、系统 DPI、多屏和更新需在 Windows 实机或 VM 验收。arm64 产物也必须单独测试，不能以 x64 测试替代。

## 安装包

```sh
npm run dist:mac
npm run dist:win
```

输出位于 release/。配置默认包含 arm64 与 x64；只打本机架构可以运行 `npx electron-builder --mac --arm64` 或 `npx electron-builder --win --x64`（先 build）。使用锁定的本地依赖，不使用 `npx ...@latest` 临时替换版本。

macOS ZIP 是自动更新的常用产物，DMG 用于人工安装。Windows NSIS 允许选择安装目录并创建快捷方式。应用图标有 PNG / ICNS / ICO 与独立托盘模板图，不使用 Electron 默认品牌图标。

## 签名与公证

生产分发需自备合法身份与证书：

- macOS：Developer ID Application 签名、Hardened Runtime、公证。按 electron-builder 官方文档配置 Apple ID 应用专用密码或 App Store Connect API 凭据。
- Windows：代码签名证书或受支持签名服务。根据实际证书设置 publisherName、签名方式与安全的 CI secret。

框架没有证书、账号、Team ID、私钥或发布令牌。`DESKTOP_MAC_SIGN_IDENTITY` 默认留空，使 mac 配置为 `identity: null`，避免自动选取开发机器已有签名身份；正式发布时显式填写签名身份。未签名/未公证的本地测试包可能触发 Gatekeeper 或 SmartScreen，不能把“能打包”写成“已通过公开分发认证”。不要关闭操作系统防护来绕过发布要求。

`CSC_IDENTITY_AUTO_DISCOVERY=false` 可在测试构建时明确关闭自动查找签名身份；正式发布需去掉该测试设置并配置真实身份。`resources/entitlements.mac.plist` 只保留 Electron JIT 所需声明，新增敏感系统能力前评估对应权限。

参考：[Electron 签名](https://www.electronjs.org/docs/latest/tutorial/code-signing)、[electron-builder macOS](https://www.electron.build/mac.html)、[Windows 签名](https://www.electron.build/code-signing-win.html)。

## 更新

`.env` 中配置 `DESKTOP_UPDATE_URL` 为不含查询参数的 HTTPS generic provider 基址，同时填写 `DESKTOP_UPDATE_PUBLISHER`（Windows 证书发布者）。macOS 发布时再填写 `DESKTOP_MAC_SIGN_IDENTITY`。构建器读取与生产构建一致的环境文件，自动生成 `publish`、Windows `publisherName` 和包内 `app-update.yml`。

配置更新地址后，构建会强制代码签名；缺少真实签名不能生成可更新的正式包。运行时使用包内标准元数据，不单独调用 setFeedURL 绕开缺失元数据的检查。测试确认真实 NSIS updater 会读取 publisherName 并进入签名验证回调，实际证书验证和在线升级仍需目标环境验收。

按 electron-builder / electron-updater 约定托管各平台更新元数据与产物，保持 appId、版本、签名身份和 publisherName 一致。默认 `publish: null`，不自动探测或发布到 GitHub。

流程为：用户检查 → 有可用版本 → 用户下载 → 下载完成 → 用户确认安装并重启。默认禁用自动下载、退出安装和预发布版本。开发模式或未配置服务时显示未配置，不模拟最新版本或成功检查。

接入发布服务后应验收正常升级、无可用版本、离线、下载中断、签名错误、元数据损坏与重启安装。这里没有可发布的真实更新服务，不能替代这些环境测试。

## CI

`.github/workflows/desktop.yml` 配置 macOS / Windows runner：`npm ci`、完整 verify、真实 Electron E2E、对应平台应用目录构建。构建结果与截图作为 artifact 保留。工作流没有自动上传 release 或推送远端的步骤。

源码仓库为 [wn228664/desktop-app-framework](https://github.com/wn228664/desktop-app-framework)。推送会触发验证，远端结果以 [GitHub Actions](https://github.com/wn228664/desktop-app-framework/actions/workflows/desktop.yml) 的实际记录为准；工作流配置存在不等于检查已通过。

## 手工平台验收

在目标系统检查：首次安装与启动、退出后重开、窗口最小/最大/全屏、多显示器恢复、系统 100%/125%/150% DPI、键盘导航、输入法、明暗主题、文件选择/另存取消与覆盖、通知权限、托盘关闭/退出、开机启动、卸载后残留和签名更新。

不要在共享机器上默认开启开机启动。应用读取系统实际启动项状态；启动应用、读取设置、修改外观均不注册或移除启动项，只有用户显式切换该开关才修改。开发模式禁止启用启动项；测试使用独立临时 userData 和 logs，不触碰用户实际偏好或文件。
