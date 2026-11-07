/**
 * 自动推送回忆 ①（按文件、写之前）的判定：
 * - 只有真的查到前情才拦；没命中直接放行（不让每写一个文件都多绕一轮）。
 * - 同一会话、同一文件按「前情集合签名」只拦一次；前情有新增（签名变了）才再拦。
 * - 这里只管「前情提醒」；受保护目录的拒绝在守卫里，先于这里判定，拦几次都拒。
 */
import type { Prior } from 'dsh-master-devlog'
import { mentionsWord } from 'dsh-master-devlog'

export interface FilePush { files: string[]; priors: Prior[] }

export class FilePushGate {
  private readonly seen = new Map<string, string>()
  constructor(private readonly lookup: (file: string) => Prior[]) {}

  decide(session: string, targets: string[]): FilePush | undefined {
    const files: string[] = []
    const priors = new Map<string, Prior>()
    for (const file of targets) {
      const found = this.lookup(file)
      if (!found.length) continue
      const sig = found.map(p => p.slug).sort().join('|')
      const key = `${session}\u0000${file}`
      if (this.seen.get(key) === sig) continue
      this.seen.set(key, sig)
      files.push(file)
      for (const p of found) priors.set(p.slug, p)
    }
    return files.length ? { files, priors: [...priors.values()] } : undefined
  }
}

/** 自动推送回忆 ②（按话题）：这一步里已经点名的条目（比如回报里刚写的 devlog slug）不再原样推回去。 */
export function topicPriors(priors: Prior[], text: string): Prior[] {
  // 已经点名的 slug 不再推；按词边界（「-」也算词的一部分），snake-game-l1103-2 不算点名了 snake-game
  const t = text.toLowerCase()
  return priors.filter(p => !mentionsWord(t, p.slug.toLowerCase(), /[a-z0-9-]/))
}

export const SCHEDULE_MARK = 'dsh-master 的定时巡检保底'
/**
 * 定时巡检保底到了：这一步只有保底提醒、插件自己巡检没有发现 ⇒ 跳过（不调模型；没配模型时也不会报失败）。
 * 有发现、或混着别的消息 ⇒ 照常进入这一步。
 */
export function scheduleStep(messages: Array<{ kind?: string; form?: string; text: string }>, findings: number): 'skip' | 'enter' {
  // 宿主每一步都会带上环境快照（runtime-context / time-context，form=snapshot），它们不算「叫醒这一步的消息」
  const waking = messages.filter(m => m.form !== 'snapshot')
  if (!waking.length) return 'enter'
  const allSafetyNet = waking.every(m => m.kind === 'schedule' && m.text.includes(SCHEDULE_MARK))
  return allSafetyNet && findings === 0 ? 'skip' : 'enter'
}
