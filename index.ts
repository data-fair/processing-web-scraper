import type { PrepareFunction, ProcessingContext } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from './types/processingConfig/index.ts'

export const prepare: PrepareFunction<ProcessingConfig> = async ({ processingConfig, secrets }) => {
  return {
    processingConfig,
    secrets
  }
}

export const run = async (context: ProcessingContext<ProcessingConfig>) => {
  const { run } = await import('./lib/scraper.ts')
  await run(context)
}

export const stop = async () => {
  const { stop } = await import('./lib/scraper.ts')
  await stop()
}
