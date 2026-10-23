import type { FileEntry } from '../../stores/app'
import associations from '../../assets/file-icons/associations.json'

const filenames = new Map(Object.entries(associations.fileNames))
const extensions = new Map(Object.entries(associations.fileExtensions))
const folders = new Map(Object.entries(associations.folderNames))
const namedFormats = new Map([
  ['readme', '说明文档'], ['license', '许可证'], ['licence', '许可证'],
  ['makefile', '构建脚本'], ['gnumakefile', '构建脚本'],
  ...['.gitignore', '.gitattributes', '.gitmodules', '.gitconfig', '.gitkeep'].map(name => [name, 'Git 配置'] as const),
  ...['.bashrc', '.bash_profile', '.bash_logout', '.profile', '.zshrc', '.zprofile', '.zshenv', '.zlogin', '.zlogout'].map(name => [name, 'Shell 脚本'] as const),
])

const formats = new Map([
  ['文本文件', 'txt text'], ['Markdown 文档', 'md markdown mdx'], ['日志文件', 'log'],
  ['配置文件', 'conf config cfg ini cnf properties toml'], ['JSON 文件', 'json jsonc json5 jsonl ndjson'],
  ['YAML 文件', 'yaml yml'], ['XML 文件', 'xml xsd xsl xslt plist'],
  ['JavaScript 源码', 'js mjs cjs jsx'], ['TypeScript 源码', 'ts mts cts tsx'], ['TypeScript 声明', 'd.ts d.mts d.cts'],
  ['Python 源码', 'py pyi pyw'], ['Vue 组件', 'vue'], ['HTML 文档', 'html htm xhtml'], ['样式表', 'css scss sass less'],
  ['Go 源码', 'go'], ['Rust 源码', 'rs'], ['Java 源码', 'java'], ['C 源码', 'c h'], ['C++ 源码', 'cc cpp cxx hpp hxx'],
  ['C# 源码', 'cs'], ['PHP 源码', 'php phtml'], ['Ruby 源码', 'rb'], ['Swift 源码', 'swift'], ['Kotlin 源码', 'kt kts'],
  ['Shell 脚本', 'sh bash zsh fish ksh csh'], ['PowerShell 脚本', 'ps1 psm1 psd1'], ['批处理脚本', 'bat cmd'],
  ['PNG 图片', 'png'], ['JPEG 图片', 'jpg jpeg'], ['SVG 图片', 'svg svgz'], ['图片', 'gif webp avif bmp ico icns tif tiff heic heif'],
  ['音频', 'mp3 wav flac aac ogg opus m4a wma aiff mid midi'], ['视频', 'mp4 mkv mov avi webm m4v mpg mpeg wmv flv'],
  ['压缩包', 'zip 7z rar tar gz bz2 xz zst zstd lz lz4 lzma tgz tbz tbz2 txz tzst tar.gz tar.bz2 tar.xz tar.zst tar.lz4'],
  ['PDF 文档', 'pdf'], ['办公文档', 'doc docx odt rtf pages'], ['表格', 'xls xlsx xlsm ods csv tsv numbers'],
  ['演示文稿', 'ppt pptx odp'], ['SQL 脚本', 'sql'], ['数据库', 'db sqlite sqlite3 db3 mdb accdb'],
  ['字体', 'ttf otf woff woff2 eot'], ['密钥 / 证书', 'key pem crt cer der p12 pfx pub'],
  ['安装包', 'deb rpm apk msi msix pkg'], ['程序文件', 'exe com appimage'],
  ['二进制文件', 'bin dll so dylib a o obj class pyc wasm'], ['磁盘镜像', 'iso img dmg vhd vhdx qcow qcow2 vmdk'],
].flatMap(([label, suffixes]) => suffixes.split(' ').map(suffix => [suffix, label] as const)))

export interface FilePresentation {
  icon: string
  typeLabel: string
  decoration?: '⤷' | '?'
}

function suffixes(name: string): string[] {
  const result: string[] = []
  for (let dot = name.indexOf('.'); dot !== -1; dot = name.indexOf('.', dot + 1)) {
    if (dot + 1 < name.length) result.push(name.slice(dot + 1))
  }
  return result
}

function parentName(path: string, name: string): string {
  // Backslashes are legal filename characters on POSIX hosts.
  const normalized = /^(?:[a-z]:[\\/]|\\\\)/i.test(path) ? path.replace(/\\/g, '/') : path
  return normalized.slice(0, -name.length).replace(/\/$/, '').split('/').pop()?.toLowerCase() ?? ''
}

/** Display metadata only: icon purpose, file format and link status are independent. */
export function filePresentation({ name, path, kind }: Pick<FileEntry, 'name' | 'path' | 'kind'>): FilePresentation {
  const normalized = name.toLowerCase()
  const qualified = parentName(path, name) + '/' + normalized
  if (kind === 'directory') {
    return { icon: folders.get(qualified) ?? folders.get(normalized) ?? associations.folder, typeLabel: '文件夹' }
  }
  if (kind === 'unknown') return { icon: associations.file, typeLabel: '未知类型', decoration: '?' }

  const endings = suffixes(normalized)
  const exact = filenames.get(qualified) ?? filenames.get(normalized)
  const extension = endings.find(suffix => extensions.has(suffix))
  // Name families are a fallback, so Dockerfile.tar.gz and .env.custom.zip remain archives.
  const family = /^(?:dockerfile|containerfile)(?:\.|$)/.test(normalized) ? 'docker'
    : /^\.env(?:\.|$)/.test(normalized) ? 'tune' : undefined
  const icon = exact ?? (extension ? extensions.get(extension) : undefined) ?? family ?? associations.file
  if (kind === 'symlink') return { icon, typeLabel: '符号链接', decoration: '⤷' }

  const format = endings.find(suffix => formats.has(suffix))
  // Unknown outer suffixes such as .part must not inherit an inner file's format.
  const typeLabel = format ? formats.get(format)!
    : namedFormats.get(normalized) ?? (family && !extension ? (family === 'docker' ? '容器配置' : '环境配置')
      : normalized === '.env' ? '环境配置'
        : endings.length ? endings[endings.length - 1].toUpperCase() + ' 文件' : '文件')
  return { icon, typeLabel }
}
