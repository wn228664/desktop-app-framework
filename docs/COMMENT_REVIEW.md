# 源码注释检查

日期：2026-11-03。范围：src、scripts、tests、e2e、构建/检查配置与 CI，共 52 个源码和配置文件。

## 已落实到源码的内容

| 位置       | 注释内容                                                               | 示例源码                                                                                                                                                                                            |
| ---------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 主进程入口 | 启动顺序、系统权限、IPC 责任链、窗口销毁/重开、设置事务与退出保存      | [main/index.js](../src/main/index.js)                                                                                                                                                               |
| 网络与任务 | 参数、返回、HTTP/JSON 契约、大小与超时单位、取消归属、进度与观察者边界 | [network.js](../src/main/services/network.js)、[tasks.js](../src/main/services/tasks.js)                                                                                                            |
| 文件与存储 | 原生授权 ID、窗口隔离、文件身份、原子替换、配置失败行为与系统加密      | [file-grants.js](../src/main/services/file-grants.js)、[storage.js](../src/main/services/storage.js)、[credentials.js](../src/main/services/credentials.js)                                         |
| 公共函数   | 类型、默认值、单位、空值、同步/异步异常、快照和取消责任                | [desktop.js](../src/renderer/src/core/desktop.js)、[format.js](../src/renderer/src/core/format.js)、[async-action.js](../src/renderer/src/core/async-action.js)                                     |
| 通用组件   | Props、事件、插槽、暴露方法、接入示例与生命周期                        | [FileUpload.vue](../src/renderer/src/components/FileUpload.vue)、[DataTable.vue](../src/renderer/src/components/DataTable.vue)、[ActionDialog.vue](../src/renderer/src/components/ActionDialog.vue) |
| 状态与页面 | 状态所有权、快照优先级、初始化门禁、演示数据与用户操作边界             | [App.vue](../src/renderer/src/App.vue)、[tasks.js](../src/renderer/src/stores/tasks.js)、[Settings.vue](../src/renderer/src/views/Settings.vue)                                                     |
| 配置与布局 | 构建白名单、平台签名、CSP、固定外壳与内部滚动、缩放适配                | [electron-builder.cjs](../electron-builder.cjs)、[electron.vite.config.js](../electron.vite.config.js)、[app.css](../src/renderer/src/styles/app.css)                                               |
| 测试       | 临时目录清理、实际 HTTP/文件行为、加密和系统接口替身的验证边界         | [review.test.js](../tests/review.test.js)、[desktop.spec.js](../e2e/desktop.spec.js)                                                                                                                |

## 验证结果

- 52 个文件逐一比对，注释整理未改变 JS 语法树、Vue 脚本/模板、CSS 规则、YAML 配置或 HTML 实际标签/属性。
- JS/Vue 源码中的非空注释内容由 57 行补充到 462 行，涵盖公共契约和维护说明；此统计不包含 CSS、HTML 和 YAML 注释。
- ESLint、Prettier、生产构建、28 项核心测试、9 组真实 Electron 回归通过。
- 自动代码质量扫描无 fatal；4 类既有布局提示仍按布局矩阵和内部滚动证据复核，没有弱化检查。

方法与组件的具体契约保留在源码旁；文档用于索引和验证记录。后续修改行为时应同时更新相邻注释、对应示例与测试，避免源码和说明脱节。
