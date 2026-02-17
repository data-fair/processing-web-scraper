import express from 'express'
import { strict as assert } from 'node:assert'
import { it, describe, before, after, afterEach } from 'node:test'
import config from 'config'
import testUtils from '@data-fair/lib-processing-dev/tests-utils.js'
import * as webScraperPlugin from '../index.ts'

describe('Web scraper processing', () => {
  let server: any
  before('start example sites server', async () => {
    const app = express()
    app.use(express.static('test-it/resources'))
    server = app.listen(3343)
  })
  after('shutdown example sites server', () => {
    server.close()
  })

  let context: any
  afterEach(async () => {
    if (context) {
      await context.cleanup()
      context = null
    }
  })

  it('should expose a plugin config schema for super admins', async () => {
    const schema = await import('../plugin-config-schema.json', { with: { type: 'json' } })
    assert.equal(schema.default.properties.userAgent.default, 'data-fair-web-scraper')
  })

  it('should expose a processing config schema for users', async () => {
    const schema = await import('../processing-config-schema.json', { with: { type: 'json' } })
    assert.equal(schema.default.type, 'object')
  })

  it('should crawl a site', { timeout: 60000 }, async () => {
    context = testUtils.context({
      pluginConfig: {
        userAgent: 'data-fair-web-scraper-test',
        defaultCrawlDelay: 0.1
      },
      processingConfig: {
        datasetMode: 'create',
        dataset: { title: 'Web scraper test' },
        startURLs: ['http://localhost:3343/site1/'],
        baseURLs: ['http://localhost:3343/site1/'],
        anchors: [{
          tags: ['section'],
          wrapperSelector: '.section',
          titleSelector: 'a'
        }]
      }
    }, config)

    await webScraperPlugin.run(context)
    assert.equal(context.processingConfig.datasetMode, 'update')
    const dataset = context.processingConfig.dataset
    assert.equal(dataset.title, 'Web scraper test')
    await context.ws.waitForJournal(dataset.id, 'finalize-end')

    const pages = (await context.axios.get(`api/v1/datasets/${dataset.id}/lines`, {
      params: { sort: '_updatedAt', select: '_id,_file.content_type,_file.content,title,url,_updatedAt' }
    })).data.results

    const page2 = pages.find((p: any) => p.url === 'http://localhost:3343/site1/page2/')
    assert.ok(page2)
    assert.ok(page2['_file.content'].includes('Page 2 content'))
    assert.equal(page2.title, 'Page 2 title')
    assert.ok(!pages.find((p: any) => p.url === 'http://localhost:3343/site1/page2/index.html'), 'duplicate page')
    assert.ok(pages.find((p: any) => p.url === 'http://localhost:3343/site1/page3/'))

    assert.ok(!pages.find((p: any) => p.url === 'http://localhost:3343/site1/meta-noindex.html'), 'meta noindex page')
    assert.ok(pages.find((p: any) => p.url === 'http://localhost:3343/site1/meta-nofollow.html'), 'meta nofollow page')
    assert.ok(!pages.find((p: any) => p.url === 'http://localhost:3343/site1/meta-nofollow-link.html'), 'meta nofollow link page')

    assert.ok(!pages.find((p: any) => p.url === 'http://localhost:3343/site1/robots-disallow.html'), 'robots disallow page')

    const sectionsPage = pages.find((p: any) => p.url === 'http://localhost:3343/site1/sections.html')
    assert.ok(sectionsPage)
    assert.equal(sectionsPage['_file.content'], 'This page contains sections')
    const section1Page = pages.find((p: any) => p.url === 'http://localhost:3343/site1/sections.html#section1')
    assert.ok(section1Page)
    assert.ok(section1Page['_file.content'].endsWith('Section 1 content'))
    assert.equal(section1Page.title, 'Section 1 title')
    const section2Page = pages.find((p: any) => p.url === 'http://localhost:3343/site1/sections.html#section2')
    assert.ok(section2Page)
    assert.ok(section2Page['_file.content'].endsWith('Section 2 content'))
    assert.equal(section2Page.title, 'Section 2 title')

    // another execution should use the previous exploration result and detect that nothing needs to be done
    await webScraperPlugin.run(context)
    const pages2 = (await context.axios.get(`api/v1/datasets/${dataset.id}/lines`, {
      params: { sort: '_updatedAt', select: '_id,_file.content_type,_file.content,title,url,_updatedAt' }
    })).data.results
    assert.deepEqual(pages, pages2)

    // another execution that should remove extra page and re-create missing page
    // and finally obtain the exact same result as previous explorations
    await context.axios.patch(`api/v1/datasets/${dataset.id}/lines/${sectionsPage._id}`, { lastModified: '', etag: '' })
    await context.axios.post(`api/v1/datasets/${dataset.id}/lines`, { _id: 'extrapage', url: 'http://test.com' })
    await context.ws.waitForJournal(dataset.id, 'finalize-end')
    await webScraperPlugin.run(context)
    await context.ws.waitForJournal(dataset.id, 'finalize-end')
    const pages3 = (await context.axios.get(`api/v1/datasets/${dataset.id}/lines`, {
      params: { sort: '_updatedAt', select: '_id,_file.content_type,_file.content,title,url,_updatedAt' }
    })).data.results
    const sectionsPage2 = pages3.find((p: any) => p.url === 'http://localhost:3343/site1/sections.html')
    assert.ok(sectionsPage2)
    assert.ok(sectionsPage2._updatedAt > sectionsPage._updatedAt)
    assert.deepEqual(
      pages.sort((p1: any, p2: any) => p1.url.localeCompare(p2.url)).map((p: any) => ({ ...p, _updatedAt: null })),
      pages3.sort((p1: any, p2: any) => p1.url.localeCompare(p2.url)).map((p: any) => ({ ...p, _updatedAt: null }))
    )
  })

  it('should crawl data-fair doc', { timeout: 120000 }, async () => {
    context = testUtils.context({
      pluginConfig: {
        userAgent: 'data-fair-web-scraper-test',
        defaultCrawlDelay: 0.1
      },
      processingConfig: {
        dataset: { title: 'data-fair doc test' },
        datasetMode: 'create',
        startURLs: [
          'https://data-fair.github.io/3/'
        ],
        baseURLs: [
          'https://data-fair.github.io/3/'
        ],
        excludeURLPatterns: ['https://data-fair.github.io/3/en(/*)'],
        prune: ['.v-navigation-drawer', '.v-app-bar'],
        titlePrefix: 'Data Fair - ',
        titleSelectors: ['h2'],
        tagsSelectors: ['.section-title']
      }
    }, config)

    await webScraperPlugin.run(context)
    assert.equal(context.processingConfig.datasetMode, 'update')
    const dataset = context.processingConfig.dataset
    assert.equal(dataset.title, 'data-fair doc test')
    await context.ws.waitForJournal(dataset.id, 'finalize-end')

    const pages = (await context.axios.get(`api/v1/datasets/${dataset.id}/lines`, {
      params: { sort: '_updatedAt', select: '_id,_file.content_type,_file.content,title,url,_updatedAt,tags' }
    })).data.results

    console.log(pages.length)
  })
})
