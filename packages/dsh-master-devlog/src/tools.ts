/** 记忆层的模型工具（总管和执行会话都有）。时间一律由插件按北京时间填。 */
import { MemoryLayer, MemoryInputError, DEPTHS, MEMORY_TYPES, SECTIONS, type Depth, type MemoryType } from './memory.ts'

export interface MemToolSpec { name: string; description: string; parameters: Record<string, unknown>; run(args: unknown, caller: string): Promise<unknown> }

const S = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra })
const A = (description: string) => ({ type: 'array', items: { type: 'string' }, description })
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false })
function obj(v: unknown): Record<string, any> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new MemoryInputError('参数必须是对象')
  return v as Record<string, any>
}
const strs = (v: unknown): string[] => Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []

export interface MemToolContext {
  /** 当前这一轮的标识（会话 + 轮开始时间），用来保证「一次请求一条」。 */
  turnKey(caller: string): string | undefined
  /** 调用者当前在途的任务 ID（写进 devlog 的 task 字段）。 */
  currentTask?(caller: string): string | undefined
}

export function memoryTools(layer: MemoryLayer, ctx: MemToolContext): MemToolSpec[] {
  return [
    { name: 'devlog_add',
      description: '写一条 devlog（一次请求一条；时间、文件名由插件定）。深度匹配改动分量：琐碎只写「改了什么」；实质写改了什么/为什么/坑与教训；基础性五段全写。改动碰到以前碰过的文件或 tag 时，必须在 related 里引用相关旧条目（先 devlog_recall 看前情），或在 no_related_reason 说明为什么无关。「以后绝不能再这么干」级的教训填 lesson，会同时写一条 feedback 记忆（记忆桥）。',
      parameters: schema({
        slug: S('2–8 个小写英文词的 kebab 摘要，如 g3-memory-layer'), hook: S('一句具体的话：点名产物、决策或坑'), tags: A('至少 3 个具体 tag：脚本名、层、工具、领域'),
        files_touched: A('改过或新建的每个路径（这一轮没改文件就留空，并写 no_files_reason）'), no_files_reason: S('没改文件时写为什么（比如：受阻，等用户批准）'), depth: S('琐碎 / 实质 / 基础性', { enum: [...DEPTHS] }),
        sections: { type: 'object', description: `段落：${SECTIONS.join('、')}`, properties: Object.fromEntries(SECTIONS.map(k => [k, { type: 'string' }])), additionalProperties: false },
        related: A('相关的旧 devlog slug'), no_related_reason: S('碰到了旧地方但确实无关时，说明为什么'),
        lesson: { type: 'object', description: '硬教训（可选）：写进 feedback 记忆', properties: { rule: { type: 'string' }, why: { type: 'string' }, how: { type: 'string' } }, required: ['rule', 'why', 'how'], additionalProperties: false },
        task: S('相关任务 ID（可选，默认取你当前在途的任务）'),
      }, ['slug', 'hook', 'tags', 'depth', 'sections']),
      run: async (a, caller) => {
        const x = obj(a)
        return layer.devlogAdd({ slug: String(x.slug ?? ''), hook: String(x.hook ?? ''), tags: strs(x.tags), files_touched: strs(x.files_touched), no_files_reason: x.no_files_reason, depth: x.depth as Depth,
          sections: x.sections && typeof x.sections === 'object' ? x.sections : {}, related: strs(x.related), no_related_reason: x.no_related_reason, lesson: x.lesson,
          task: x.task ?? ctx.currentTask?.(caller), session: caller, turnKey: ctx.turnKey(caller) })
      } },
    { name: 'devlog_amend', description: '给已有 devlog 条目追加一行补记（同一次请求的后续改动、事后发现）。',
      parameters: schema({ slug: S('条目 slug'), line: S('补记内容，一句') }, ['slug', 'line']),
      run: async (a, caller) => { const x = obj(a); return layer.devlogAmend(String(x.slug ?? ''), String(x.line ?? ''), caller) } },
    { name: 'devlog_recall', description: '回忆：按 tag（只匹配 tag 段）或文件路径查过去的 devlog、决策、相关记忆。动以前碰过的地方之前先查，并把过去的决策 / 坑摆出来。',
      parameters: schema({ term: S('tag 关键词'), files: A('要动的文件路径') }, []),
      run: async (a, caller) => { const x = obj(a); return layer.recall({ term: x.term, files: strs(x.files), session: caller }) } },
    { name: 'decision_add', description: '记一条长期决策（只追加；推翻旧决策时用 supersedes 指向它的编号，不改旧行）。长推理先写进 devlog，这里指回 context_slug。',
      parameters: schema({ decision: S('决定了什么，一句'), reasoning: S('为什么，一句'), context_slug: S('长推理所在的 devlog slug'), supersedes: { type: 'integer', description: '推翻的决策编号（可选）' } }, ['decision', 'reasoning', 'context_slug']),
      run: async (a, caller) => { const x = obj(a); return layer.decisionAdd({ decision: x.decision, reasoning: x.reasoning, context_slug: x.context_slug, supersedes: typeof x.supersedes === 'number' ? x.supersedes : undefined, session: caller }) } },
    { name: 'memory_write', description: '写或更新一条记忆（user 用户是谁 / feedback 做事方式的纠正与确认 / project 进行中的事 / reference 外部资源）。一条记忆一件事；body 里用 [[名字]] 链接别的记忆或 devlog；feedback/project 要写 **Why:** 和 **How to apply:**。能随时查到的信息不要记。',
      parameters: schema({ name: S('kebab 名字'), type: S('记忆类型', { enum: [...MEMORY_TYPES] }), description: S('一行摘要（回忆时据此判断相关性）'), body: S('正文') }, ['name', 'type', 'description', 'body']),
      run: async (a, caller) => { const x = obj(a); return layer.memoryWrite({ name: x.name, type: x.type as MemoryType, description: x.description, body: x.body, session: caller }) } },
    { name: 'memory_search', description: '按关键词搜记忆（名字、摘要、正文）。',
      parameters: schema({ term: S('关键词') }, ['term']),
      run: async (a) => ({ hits: layer.memorySearch(String(obj(a).term ?? '')) }) },
  ]
}
