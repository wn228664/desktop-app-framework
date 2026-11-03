# 依赖与供应链记录

验证日期：2026-11-03。运行环境：macOS arm64、Node.js 22.21.1、npm 10.9.4。

## 安装与锁定

直接依赖使用精确版本，`package-lock.json` 固定传递版本和 registry integrity。项目 `.npmrc` 指向官方 `https://registry.npmjs.org/`，不把第三方镜像设为全局默认。

已执行干净 `npm ci`。Vue、Pinia、Router、Element Plus 放在开发依赖中，由 Vite 编译进 renderer；安装包不再携带整套前端编译工具的 node_modules。主进程运行依赖为 electron-updater 及其实际依赖。

构建前自动运行 `scripts/notices.js`，生成 `resources/THIRD_PARTY_NOTICES.txt` 并随安装包分发，覆盖当前安装的构建工具和被打包的库。Electron / Chromium 的原始许可也由打包器保留。

`dependency-sbom.json` 为 npm 生成的 CycloneDX 清单，范围是 npm 的非 dev 依赖；编译进 renderer 的前端库仍需结合 package-lock.json、完整审计和许可清单核对，不能以 omit=dev 清单替代全部分发代码审计。

## 漏洞审计

首轮完整 `npm audit --json` 返回 **21 个中危依赖节点、0 高危、0 严重**。这些节点追溯到同一项 minimatch 告警：

- [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)：globparts amplification 可能导致拒绝服务，受影响范围 `<11.0.1`。
- 涉及 ESLint、electron-builder、asar 等开发/打包链路。运行时依赖审计为 0 告警。
- npm 自动建议把 ESLint / builder 降到很老的主版本；这会破坏当前工具链，未采用 `audit fix --force`。
- minimatch 旧主版本 API 与 11 不同，未使用跨主版本强制 override 假装修复。

最后复核时 npm CLI 的审计请求遇到 TLS 中断。随后使用独立 HTTP 客户端，将锁文件中的包名和版本提交至官方 Bulk Advisory API：全部 448 个包名仅返回上述 minimatch 中危项；非 dev 范围 16 个包名返回 0 告警。请求不包含本地路径、项目代码、令牌或文件内容。前端运行库也包含在完整范围内。

这是一个**明确保留的上游开发工具例外**，不写成全依赖零漏洞。构建只处理可信工作区输入；后续升级采用上游兼容修复，并重跑检查与打包。

## 签名 / 来源校验

`npm audit signatures` 本次未通过：`caniuse-lite@1.0.30001820` 的 attestation 缺少可查询的对应公钥，错误为 `EMISSINGSIGNATUREKEY`。这是未完成的签名验证，不能用 npm ci 成功代替。

Electron 下载使用锁定的官方 npm 包中 `checksums.json` 提供的 SHA-256。`electron-builder.cjs` 直接读取此清单，既保持校验，也避免重复拉取远程 SHASUMS 文件。

本机访问 GitHub release-assets 曾发生 TLS 中断，后续平台打包使用 `npmmirror.com/mirrors/electron` 下载归档，并对照上述官方校验值验证；没有关闭 TLS 或校验。镜像仅在构建命令环境中使用，没有写入用户全局配置。

Windows x64 Electron 45.2.1 归档的预期 SHA-256：

```text
7c342aee45d5b4ccafe5dfe9037028796b082735a576e21e2b4e2d8422ebb727
```

## 后续维护

升级 Electron 时同时更新精确版本、锁文件和真实窗口测试；配置读取对应版本的校验清单，无需手工维护多份哈希。更新构建工具时先检查 API 与 Node 版本，不用清空错误输出或降低安全检查换取通过。

公开发布前补齐平台签名、公证、远端更新验证，并在目标 Windows 系统执行安装和运行验收。
