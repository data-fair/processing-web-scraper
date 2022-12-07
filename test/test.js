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
    assert.equal(schema.properties.robotId.default, 'data-fair-web-scraper')
  })

  it('should expose a processing config schema for users', async () => {
    const schema = require('../processing-config-schema.json')
    assert.equal(schema.type, 'object')
  })

  it('should crawl a site', async function () {
    this.timeout(60000)

    context = testUtils.context({
      pluginConfig: {
        robotId: 'data-fair-web-scraper-test',
        pageIntervalMS: 100
      },
      processingConfig: {
        datasetMode: 'create',
        dataset: { title: 'Web scraper test' },
        startURLs: ['http://localhost:3343/site1/']
      }
    }, config, true, false)

    await webScraper.run(context)
    assert.equal(context.processingConfig.datasetMode, 'update')
    const dataset = context.processingConfig.dataset
    assert.equal(dataset.title, 'Web scraper test')
    await context.ws.waitForJournal(dataset.id, 'finalize-end')
    const lines = (await context.axios.get(`api/v1/datasets/${dataset.id}/lines`)).data
    console.log('lines', lines)

    // another execution should use the previous exploration result
    // await webScraper.run(context)
  })
})
