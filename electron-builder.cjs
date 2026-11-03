/**
 * 平台分发配置。应用名/appId 取 app.config.json，公开发布配置与 renderer 构建共用同一校验器。
 * 默认只做本地包：不自动发布，也不自动选取机器已有签名身份。
 * 启用更新后必须生成标准元数据并强制签名；签名私钥/密码只通过构建器的安全环境配置提供。
 */
// 校验值来自锁定的官方 Electron npm 包，避免每次打包再拉取远程 SHASUMS，且不关闭归档校验。
const checksums = require('electron/checksums.json')
const identity = require('./app.config.json')

module.exports = async () => {
  const { loadEnv } = await import('vite')
  const { resolveRuntimeConfig } = await import('./src/shared/config.js')
  const environment = loadEnv('production', __dirname, 'DESKTOP_')
  const config = resolveRuntimeConfig(environment)
  const updateUrl = config.DESKTOP_UPDATE_URL
  return {
    ...identity,
    directories: { output: 'release', buildResources: 'resources' },
    // 仅交付构建代码、运行时依赖和必要资源；源文件、测试、环境文件与本地报告不进入应用归档。
    files: [
      'out/**',
      'resources/icon.png',
      'resources/trayTemplate*.png',
      'resources/THIRD_PARTY_NOTICES.txt',
      'package.json',
    ],
    asar: true,
    artifactName: '${name}-${version}-${os}-${arch}.${ext}',
    electronDownload: { checksums },
    // generic 只声明更新托管位置，不替用户上传文件；publisherName 会写入 Windows 更新元数据。
    publish: updateUrl ? { provider: 'generic', url: updateUrl } : null,
    forceCodeSigning: Boolean(updateUrl),
    mac: {
      // 正式发布时显式配置签名身份；本地模板不自动使用机器已有证书。
      identity: environment.DESKTOP_MAC_SIGN_IDENTITY || null,
      icon: 'resources/icon.icns',
      category: 'public.app-category.developer-tools',
      target: [
        { target: 'dmg', arch: ['arm64', 'x64'] },
        { target: 'zip', arch: ['arm64', 'x64'] },
      ],
      hardenedRuntime: true,
      entitlements: 'resources/entitlements.mac.plist',
      entitlementsInherit: 'resources/entitlements.mac.plist',
    },
    win: {
      ...(updateUrl ? { publisherName: [environment.DESKTOP_UPDATE_PUBLISHER.trim()] } : {}),
      icon: 'resources/icon.ico',
      target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
    },
    nsis: {
      // 使用可选择目录的安装向导；修改为 perMachine/静默安装前需重新核对权限、升级与卸载行为。
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
    },
  }
}
