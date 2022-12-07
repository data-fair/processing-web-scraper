process.env.NODE_ENV = 'test'
const config = require('config')
const express = require('express')
const assert = require('assert').strict
const webScraper = require('../')
const testUtils = require('@data-fair/processings-test-utils')

describe('Web scraper processing', () => {
  let server
  before('start example sites server', async () => {
    const app = express()
    app.use(express.static('test/resources'))
    server = app.listen(3343)
  })
  after('shutdown example sites server', () => {
    server.close()
  })

  let context
  afterEach(async function () {
    this.timeout(10000)
    if (context) {
      await context.cleanup()
      context = null
    }
  })

  it('should expose a plugin config schema for super admins', async () => {
    const schema = require('../plugin-config-schema.json')
    assert.equal(schema.properties.userAgent.default, 'data-fair-web-scraper')
  })

  it('should expose a processing config schema for users', async () => {
    const schema = require('../processing-config-schema.json')
    assert.equal(schema.type, 'object')
  })

  it('should crawl a site', async function () {
    this.timeout(60000)

    context = testUtils.context({
      pluginConfig: {
        userAgent: 'data-fair-web-scraper-test',
        crawlDelay: 0.1
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
    }, config, true, false)

    await webScraper.run(context)
    assert.equal(context.processingConfig.datasetMode, 'update')
    const dataset = context.processingConfig.dataset
    assert.equal(dataset.title, 'Web scraper test')
    await context.ws.waitForJournal(dataset.id, 'finalize-end')

    const pages = (await context.axios.get(`api/v1/datasets/${dataset.id}/lines`, {
      params: { sort: '_updatedAt', select: '_file.content_type,_file.content,title,url' }
    })).data.results

    const page2 = pages.find(p => p.url === 'http://localhost:3343/site1/page2/')
    assert.ok(page2)
    assert.ok(page2['_file.content'].includes('Page 2 content'))
    assert.equal(page2.title, 'Page 2 title')
    assert.ok(!pages.find(p => p.url === 'http://localhost:3343/site1/page2/index.html'), 'duplicate page')

    assert.ok(!pages.find(p => p.url === 'http://localhost:3343/site1/meta-noindex.html'), 'meta noindex page')
    assert.ok(pages.find(p => p.url === 'http://localhost:3343/site1/meta-nofollow.html'), 'meta nofollow page')
    assert.ok(!pages.find(p => p.url === 'http://localhost:3343/site1/meta-nofollow-link.html'), 'meta nofollow link page')

    assert.ok(!pages.find(p => p.url === 'http://localhost:3343/site1/robots-disallow.html'), 'robots disallow page')

    const sectionsPage = pages.find(p => p.url === 'http://localhost:3343/site1/sections.html')
    assert.ok(sectionsPage)
    assert.equal(sectionsPage['_file.content'], 'This page contains sections')
    const section1Page = pages.find(p => p.url === 'http://localhost:3343/site1/sections.html#section1')
    assert.ok(section1Page)
    assert.ok(section1Page['_file.content'].endsWith('Section 1 content'))
    assert.equal(section1Page.title, 'Section 1 title')
    const section2Page = pages.find(p => p.url === 'http://localhost:3343/site1/sections.html#section2')
    assert.ok(section2Page)
    assert.ok(section2Page['_file.content'].endsWith('Section 2 content'))
    assert.equal(section2Page.title, 'Section 2 title')
    // another execution should use the previous exploration result
    // await webScraper.run(context)
  })
})
