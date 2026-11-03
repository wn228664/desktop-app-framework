import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 构建前生成第三方许可汇总，输出 resources/THIRD_PARTY_NOTICES.txt，再由 builder 随应用分发。
 * 使用当前锁定安装结果，不联网补写许可；收集开发依赖是为了覆盖已被打入 renderer 的 UI 库。
 * 这份清单不决定依赖是否安全，漏洞审计、来源与平台许可仍需分别核对。
 */

/**
 * @param {string} directory 当前 npm 安装目录或 scope/嵌套 node_modules 目录。
 * @param {Map<string,string>} output 按 name@version 去重的许可内容，递归中原地填充。
 * @returns {Promise<void>} 缺失嵌套 node_modules 属正常情况；真实读取/解析失败继续向上抛出。
 */
async function collect(directory, output) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const path = join(directory, entry.name)
    if (entry.name.startsWith('@')) {
      await collect(path, output)
      continue
    }
    let metadata
    try {
      metadata = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    const key = `${metadata.name}@${metadata.version}`
    if (!output.has(key)) {
      const files = await readdir(path, { withFileTypes: true })
      const licenses = files.filter(
        (file) => file.isFile() && /^(licen[cs]e|copying|notice)([.-]|$)/i.test(file.name),
      )
      const bodies = []
      for (const file of licenses) bodies.push(await readFile(join(path, file.name), 'utf8'))
      output.set(
        key,
        `${key}\nLicense: ${metadata.license || 'See upstream package'}\n${typeof metadata.repository === 'string' ? metadata.repository : metadata.repository?.url || ''}\n\n${bodies.join('\n\n') || 'No top-level license text supplied; consult the upstream package.'}`,
      )
    }
    try {
      await collect(join(path, 'node_modules'), output)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

const notices = new Map()
await collect('node_modules', notices)
const header =
  'Third-party notices\nGenerated from the locked installation. Includes development tools and bundled runtime libraries. Electron and Chromium licenses are also included beside the packaged application.\n\n'
await writeFile(
  'resources/THIRD_PARTY_NOTICES.txt',
  header +
    [...notices]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, text]) => text)
      .join('\n\n' + '='.repeat(80) + '\n\n'),
)
console.log(`Collected license notices for ${notices.size} installed packages`)
