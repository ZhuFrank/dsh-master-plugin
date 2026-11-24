/**
 * G16：给模型看的文字里跟平台有关的词。DSH 在 Windows 上给的命令行工具是 pwsh，Mac / Linux 上是 bash（dsh-base 的 cordis.patch.yml 按平台开关）。
 * 非 Windows 上和以前逐字一样。
 */
const WIN = process.platform === 'win32'
const MAC = process.platform === 'darwin'
/** 命令行工具名。 */
export const SHELL_TOOL = WIN ? 'pwsh' : 'bash'
/** 「看内存用插件的工具，不要自己读」那半句（vm_stat 只有 macOS 有；Linux / Windows 写通用的）。 */
export const MEM_SELF_READ = MAC ? '不要自己读 vm_stat 的 free 页（口径不一样，会读成只剩一百多 MB）' : '不要自己读系统的内存数（口径不一样）'
