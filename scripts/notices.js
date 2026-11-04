import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 构建前生成第三方许可汇总，输出 resources/THIRD_PARTY_NOTICES.txt，再由 builder 随应用分发。
 * 使用当前锁定安装结果，不联网补写许可；收集开发依赖是为了覆盖已被打入 renderer 的 UI 库。
 * 这份清单不决定依赖是否安全，漏洞审计、来源与平台许可仍需分别核对。
 *
 * @param {string} directory 当前 npm 安装目录或 scope/嵌套 node_modules 目录。
 * @param {Map<string,string>} output 按 name@version 去重的许可内容，递归中原地填充。
 * @returns {Promise<void>} 缺失嵌套 node_modules 属正常情况；真实读取/解析失败继续向上抛出。
 *
 * 递归收集已安装依赖许可，保留内容和来源，真实读取失败终止构建。
 */
async function collect(directory, output) {
  // entries：当前依赖目录中带类型的条目。
  const entries = await readdir(directory, { withFileTypes: true })
  // entry：当前候选依赖目录，跳过文件和点开头目录。
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    // path：当前依赖包的安装路径。
    const path = join(directory, entry.name)
    if (entry.name.startsWith('@')) {
      await collect(path, output)
      continue
    }
    // metadata：当前实际安装包的 package.json 内容。
    let metadata
    try {
      metadata = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))
    } catch (error) {
      // error：依赖元数据或嵌套目录读取失败，仅 ENOENT 可跳过。

      if (error.code === 'ENOENT') continue
      throw error
    }
    // key：name@version 许可去重键。
    const key = `${metadata.name}@${metadata.version}`
    if (!output.has(key)) {
      // files：当前包根目录的条目，用于筛选许可证文本。
      const files = await readdir(path, { withFileTypes: true })
      // licenses：当前包根目录名称符合 LICENSE/COPYING/NOTICE 的普通文件。
      const licenses = files.filter(
        /**
         * 仅接受名称符合许可约定的普通文件。
         * file：当前许可候选文件或正在读取的许可证条目。
         */
        (file) => file.isFile() && /^(licen[cs]e|copying|notice)([.-]|$)/i.test(file.name),
      )
      // bodies：当前包已读取的原始许可文本，保留上游声明。
      const bodies = []
      // file：当前许可候选文件或正在读取的许可证条目。
      for (const file of licenses) bodies.push(await readFile(join(path, file.name), 'utf8'))
      output.set(
        key,
        `${key}\nLicense: ${metadata.license || 'See upstream package'}\n${typeof metadata.repository === 'string' ? metadata.repository : metadata.repository?.url || ''}\n\n${bodies.join('\n\n') || 'No top-level license text supplied; consult the upstream package.'}`,
      )
    }
    try {
      await collect(join(path, 'node_modules'), output)
    } catch (error) {
      // error：依赖元数据或嵌套目录读取失败，仅 ENOENT 可跳过。

      if (error.code !== 'ENOENT') throw error
    }
  }
}

// notices：按 name@version 去重的完整许可证文本映射。
const notices = new Map()
await collect('node_modules', notices)
// header：分发清单固定说明，强调来自当前锁定安装结果。
const header =
  'Third-party notices\nGenerated from the locked installation. Includes development tools and bundled runtime libraries. Electron and Chromium licenses are also included beside the packaged application.\n\n'
await writeFile(
  'resources/THIRD_PARTY_NOTICES.txt',
  header +
    [...notices]
      .sort(
        /**
         * 按 name@version 自然文字顺序稳定排列许可条目。
         * a：排序时左侧 name@version 键。
         * b：排序时右侧 name@version 键。
         */
        ([a], [b]) => a.localeCompare(b),
      )
      .map(
        /**
         * 提取原始许可文本，避免把映射结构写入分发清单。
         * text：去掉去重键后的完整包许可说明文本。
         */
        ([, text]) => text,
      )
      .join('\n\n' + '='.repeat(80) + '\n\n'),
)
console.log(`Collected license notices for ${notices.size} installed packages`)
