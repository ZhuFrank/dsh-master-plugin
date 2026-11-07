/**
 * 文字里的绝对路径（带扩展名），服务端（产物列表）和客户端（就地打开）共用。
 * G5-F ④：路径结束 = 空白、引号、反引号、全角标点（）：，。；、！？、半角 ) ] , ; :，以及句末的「.」。
 * 以前全角「（」「：」只在「不能出现在路径里」那边，没在「路径到这为止」那边 ⇒ `…/stats.md（601B，16 行）` 整条认不出。
 */
const END = "\\s`'\"（）：，。；、！？)\\]"
const PATH_RE = new RegExp(`(?:^|[\\s\`'"（(：:，,；、])(\\/(?:Users|tmp|private|var|opt|Volumes)\\/[^${END}]+?\\.[A-Za-z0-9]{1,8})(?=$|[${END},;:]|\\.(?:\\s|$))`, 'g')
export function findPaths(text: string, max = 8): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(PATH_RE)) out.add(m[1]!)
  return [...out].slice(0, max)
}
