import neostandard from 'neostandard'

export default [
  { ignores: ['config/*', '**/.type/', 'data/', 'node_modules/', 'test/', '*.config.cjs', '.husky/*'] },
  ...neostandard({ ts: true })
]
