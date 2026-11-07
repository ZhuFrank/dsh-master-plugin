// G10：沙盒 DSH 的环境里去掉 GIT_CONFIG_*（DSH 的 bash 沙盒只传 COUNT 不传 KEY/VALUE，git 会报错）。
import { it, expect } from 'vitest'
import { withoutGitConfigEnv } from '../src/sandbox.ts'

it('去掉 GIT_CONFIG_COUNT / KEY_n / VALUE_n，别的变量（包括 GIT_ 开头的）原样留着', () => {
  const env = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a', GIT_CONFIG_VALUE_0: 'b', GIT_CONFIG_KEY_1: 'c', GIT_CONFIG_VALUE_1: 'd',
    GIT_CONFIG_GLOBAL: '/x', GIT_AUTHOR_NAME: 'n', PATH: '/bin', HOME: '/h' }
  expect(withoutGitConfigEnv(env)).toEqual({ GIT_CONFIG_GLOBAL: '/x', GIT_AUTHOR_NAME: 'n', PATH: '/bin', HOME: '/h' })
})
