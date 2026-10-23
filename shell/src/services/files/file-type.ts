import type { FileEntry } from '../../stores/app'

export const fileTypeLabels = {
  directory: '文件夹', symlink: '符号链接', unknown: '未知类型', file: '文件',
  text: '文本文件', markdown: 'Markdown 文档', log: '日志文件',
  config: '配置文件', json: 'JSON 数据', yaml: 'YAML 配置', xml: 'XML 文档',
  javascript: 'JavaScript 源码', typescript: 'TypeScript 源码', 'typescript-declaration': 'TypeScript 声明',
  python: 'Python 源码', vue: 'Vue 组件', html: 'HTML 文档', css: '样式表', code: '源代码',
  shell: 'Shell 脚本', powershell: 'PowerShell 脚本', batch: '批处理脚本', build: '构建脚本',
  docker: '容器配置', git: 'Git 配置', dependency: '依赖配置', lock: '锁文件',
  image: '图片', audio: '音频', video: '视频', archive: '压缩包',
  pdf: 'PDF 文档', document: '办公文档', spreadsheet: '表格', presentation: '演示文稿',
  sql: 'SQL 脚本', database: '数据库', font: '字体', certificate: '密钥 / 证书',
  package: '安装包', application: '程序文件', binary: '二进制文件', disk: '磁盘镜像',
} as const

export type FileType = keyof typeof fileTypeLabels

function associations(groups: [FileType, string][]): Map<string, FileType> {
  return new Map(groups.flatMap(([type, names]) => names.split(' ').map(name => [name, type] as const)))
}

const filenames = associations([
  ['text', 'readme license licence copying authors contributors notice changelog changes'],
  ['config', '.env .editorconfig .npmrc .yarnrc .inputrc .curlrc .wgetrc .prettierrc .eslintrc'],
  ['shell', '.bashrc .bash_profile .bash_logout .profile .zshrc .zprofile .zshenv .zlogin .zlogout'],
  ['git', '.gitignore .gitattributes .gitmodules .gitconfig .gitkeep'],
  ['docker', 'dockerfile containerfile .dockerignore docker-compose.yml docker-compose.yaml compose.yml compose.yaml'],
  ['build', 'makefile gnumakefile cmakelists.txt justfile taskfile.yml taskfile.yaml rakefile gemfile'],
  ['dependency', 'package.json package-lock.json npm-shrinkwrap.json yarn.lock pnpm-lock.yaml bun.lock bun.lockb cargo.toml cargo.lock go.mod go.sum pyproject.toml requirements.txt pipfile pipfile.lock poetry.lock uv.lock composer.json composer.lock gemfile.lock'],
])

const extensions = associations([
  ['text', 'txt text rst adoc tex'], ['markdown', 'md markdown mdx'], ['log', 'log'],
  ['config', 'conf config cfg ini cnf toml properties service socket timer desktop'],
  ['json', 'json jsonc jsonl ndjson ipynb'], ['yaml', 'yaml yml'], ['xml', 'xml xsd xsl xslt plist'],
  ['javascript', 'js mjs cjs jsx'], ['typescript', 'ts mts cts tsx'], ['typescript-declaration', 'd.ts d.mts d.cts'],
  ['python', 'py pyi pyw'], ['vue', 'vue'], ['html', 'html htm xhtml'], ['css', 'css scss sass less'],
  ['code', 'c h cc cpp cxx hpp hxx cs fs fsx go rs java kt kts swift m mm php phtml rb pl pm r lua dart ex exs erl hrl hs clj cljs scala svelte proto graphql gql'],
  ['shell', 'sh bash zsh fish ksh csh'], ['powershell', 'ps1 psm1 psd1'], ['batch', 'bat cmd'], ['build', 'mk cmake gradle'],
  ['lock', 'lock'],
  ['image', 'png jpg jpeg gif webp avif bmp ico icns svg svgz tif tiff heic heif psd xcf'],
  ['audio', 'mp3 wav flac aac ogg opus m4a wma aiff mid midi'], ['video', 'mp4 mkv mov avi webm m4v mpg mpeg wmv flv'],
  ['archive', 'zip 7z rar tar gz bz2 xz zst zstd lz lz4 lzma tgz tbz tbz2 txz tzst tar.gz tar.bz2 tar.xz tar.zst tar.lz4'],
  ['pdf', 'pdf'], ['document', 'doc docx odt rtf pages epub'], ['spreadsheet', 'xls xlsx xlsm ods csv tsv numbers'],
  ['presentation', 'ppt pptx odp'], ['sql', 'sql'], ['database', 'db sqlite sqlite3 db3 mdb accdb'],
  ['font', 'ttf otf woff woff2 eot'], ['certificate', 'key pem crt cer der p12 pfx pub'],
  ['package', 'deb rpm apk msi msix pkg'], ['application', 'exe com appimage'],
  ['binary', 'bin dll so dylib a o obj class pyc wasm'], ['disk', 'iso img dmg vhd vhdx qcow qcow2 vmdk'],
])

/** A display hint from listing metadata, never a content/MIME or execution-safety check. */
export function fileType({ name, kind }: Pick<FileEntry, 'name' | 'kind'>): FileType {
  if (kind !== 'file') return kind
  const normalized = name.toLowerCase()
  const exact = filenames.get(normalized)
  if (exact) return exact
  if (/^(?:dockerfile|containerfile)\..+/.test(normalized)) return 'docker'
  if (/^\.env\..+/.test(normalized)) return 'config'

  // Start after the leading dot: an arbitrary dotfile is not an extension.
  for (let dot = normalized.indexOf('.', 1); dot !== -1; dot = normalized.indexOf('.', dot + 1)) {
    const type = extensions.get(normalized.slice(dot + 1))
    if (type) return type
  }
  return 'file'
}
