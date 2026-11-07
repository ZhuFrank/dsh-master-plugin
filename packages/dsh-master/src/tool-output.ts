/**
 * G7 ⑥：插件给所有工具声明的输出格式是「对象」（toolDef 的 output.schema），宿主会校验。
 * 工具返回数组 / 字符串 / 空值时宿主报 `"value" must be an object`（3090 上 master_sessions 每次都这样）。
 * 这里兜底：对象原样返回，别的包成 { result }。
 */
export function toolOutput(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : { result: v ?? null }
}
