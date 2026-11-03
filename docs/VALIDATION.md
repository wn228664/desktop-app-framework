# 本次交付验证

日期：2026-11-03。状态：**已验证待环境确认**。已包含本轮深入复核，修复明细见 [DEEP_REVIEW.md](DEEP_REVIEW.md)。

本批已落地独立 Electron 框架，自有代码为 JavaScript / Vue，界面使用 Element Plus。写入范围为本项目新目录；其他已有项目没有进行代码修改。源码由 [GitHub 仓库](https://github.com/wn228664/desktop-app-framework) 管理，本地验证与远端 CI 分开记录。依赖与锁文件保持不变。

## 已执行

| 项目                 | 结果              | 证据范围                                                                     |
| -------------------- | ----------------- | ---------------------------------------------------------------------------- |
| 干净依赖安装         | 通过              | npm ci，锁定版本与完整性校验                                                 |
| ESLint               | 通过，无错误/警告 | 应用、脚本、测试、配置                                                       |
| Prettier             | 通过              | 匹配的源文件和文档                                                           |
| Node 核心测试        | 28 项通过         | 动作取消/重试/旧结果、URL 与 IPC、文件授权、持久化、请求/上传/下载、更新状态 |
| 生产构建             | 通过              | main、CommonJS preload、renderer                                             |
| 真实 Electron E2E    | 9 组通过          | 下列交互与沙盒边界                                                           |
| 开发模式             | 通过              | npm run dev，实际原生窗口检查首页与表格，无启动错误                          |
| macOS arm64 应用目录 | 通过              | release/mac-arm64/Desktop Framework.app                                      |
| macOS arm64 DMG      | 通过              | release/desktop-app-framework-1.0.0-mac-arm64.dmg，已执行 hdiutil 校验       |
| macOS 安装包模式启动 | 通过              | 实际启动 .app，确认 packaged=true、版本 1.0.0 与首页可见                     |
| Windows x64 应用目录 | 通过              | release/win-unpacked/Desktop Framework.exe 及配套资源；未在 Windows 执行     |
| Windows x64 NSIS     | 通过              | release/desktop-app-framework-1.0.0-win-x64.exe，未在 Windows 安装/运行      |
| 依赖审计             | 有明确例外        | 完整范围只返回 1 项上游中危，非 dev 范围 0 项，见 DEPENDENCIES.md            |

## 交互覆盖

1. Electron 沙盒、上下文隔离、renderer 无 Node require/process；固定桌面桥可用；未配置 API 返回 NOT_CONFIGURED。
2. 表格搜索、重置、分页、键盘排序、行选择；页面切换后选择不泄漏到其他条件。
3. 表单必填校验、成功反馈、弹窗进行中主动取消、抽屉内容区滚动。
4. 临时 UTF-8 文件真实读取、原子另存、取消选择保持原内容。原生对话框选择结果在测试进程中替换，文件服务与 IPC 使用实际实现；未写用户文件。
5. 主题保存与刷新恢复。5 个页面在 1240×820/100%、760×540/100%、1000×700/125%、760×540/150% 下检查根节点无水平/垂直滚动；表格正文高度大于 50 个逻辑像素，分页在视口内可达。

新增回归覆盖：同帧连续点击仅一次成功回调，最小化恢复与关闭中重开，损坏窗口尺寸回退，外观设置不写系统启动项。

适配复核发现过极短逻辑视口下正文被工具栏挤压，已增加专项布局并补上述回归断言。根节点禁止滚动与内部内容可达分别检查，避免以 overflow:hidden 掩盖内容裁切。

## 质量复核

按进程权限、主框架来源、凭据切换、异步结果失效、文件/计时器/监听释放、配置并发与回滚、布局触达、注释和分发依赖检查源码。

随后完成 52 个源码/配置文件的注释整理，公共函数和组件契约直接写在实现旁。语法树与配置语义比对无变化；覆盖范围和示例源码见 [COMMENT_REVIEW.md](COMMENT_REVIEW.md)。

自动代码门禁无 fatal。4 类布局提示已人工复核：100% 根容器与表格高度用于固定外壳；像素提示主要包含边框和装饰图；overflow:hidden 搭配内部滚动与 E2E 可达性断言；5px 导航点是装饰，实际链接命中区远大于 24px。没有为消除提示删掉滚动边界或弱化检查。

## 产物与截图

应用目录在 release/，构建结果在 out/。本地截图在 artifacts/，其中 overview-macos.png 是真实 Electron 界面，packaged-macos.png 是安装包模式界面。测试报告位于 playwright-report/。

最终归档一致性与 SHA-256 见 artifacts/package-integrity.json；第三方许可随应用分发。

这些目录均被 gitignore 排除，正常提交只包含源码、锁文件、文档、资源与 CI 配置。构建前生成的第三方许可随应用分发，不需要手工复制。

## 仍需对应环境确认

- Windows 实机/VM：启动、安装/卸载、托盘、通知、系统启动项、DPI、多屏、输入法和文件对话框。目录构建不能替代 Windows 运行。
- macOS x64 和 Windows arm64：配置具备目标支持，本次未构建/运行对应架构。
- 公开分发：开发者身份、平台签名、macOS 公证、正式更新服务及升级链路。本机包默认不自动使用已有签名证书。
- 上传/下载/API：核心传输与错误路径有测试；没有可用于产品验收的真实后端，未假装接入业务接口。
- 系统加密：使用 safeStorage 异步 API，核心行为通过注入加密实现测试；正式签名后的 Keychain/DPAPI 体验需在目标系统验证。
- CI：推送触发 macOS/Windows 工作流；远端状态以 [Actions 实际运行](https://github.com/wn228664/desktop-app-framework/actions/workflows/desktop.yml) 为准，不以本地通过代替。
- 上游 minimatch 中危与 npm attestation 公钥缺失：见 DEPENDENCIES.md，不能标为全供应链通过。

## 启动与回滚

本机开发启动：`npm run dev`。已构建版本：`npm run start`；运行 .app 也可直接打开 macOS 产物。

这是独立新项目，无旧项目迁移或数据库变更。停止应用后移走本项目目录即可撤销源码交付；应用首次运行会在平台 userData 目录生成自身偏好和缓存，清理前请确认未包含后续用户数据。框架默认不启用启动项、托盘或网络服务。
