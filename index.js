const FormData = require('form-data')
const crypto = require('crypto')

// TODO:
// handle html but also any file formats
// add in-links info (at least for files)
// store last-modified and e-tag and use is when re-crawling a site
// all specifications listed here http://robots-txt.com/
// normalize URL to prevent duplicates

const datasetSchema = [
  {
    key: 'title',
    type: 'string',
    'x-refersTo': 'http://www.w3.org/2000/01/rdf-schema#label',
    'x-capabilities': { textAgg: false }
  },
  {
    key: 'url',
    type: 'string',
    'x-refersTo': 'https://schema.org/WebPage',
    'x-capabilities': { text: false, values: false, textAgg: false, insensitive: false }
  },
  {
    key: 'tags',
    type: 'string',
    separator: ',',
    'x-refersTo': 'https://schema.org/DefinedTermSet',
    'x-capabilities': { text: false, textStandard: false, textAgg: false, insensitive: false }
  },
  {
    key: 'etag',
    type: 'string',
    separator: ',',
    'x-capabilities': { index: false, values: false, text: false, textStandard: false, textAgg: false, insensitive: false }
  },
  {
    key: 'lastModified',
    type: 'string',
    'x-capabilities': { index: false, values: false, text: false, textStandard: false, textAgg: false, insensitive: false }
  },
  {
    key: 'attachmentPath',
    type: 'string',
    'x-refersTo': 'http://schema.org/DigitalDocument',
    'x-capabilities': { text: false, textStandard: false, values: false, textAgg: false, insensitive: false }
  }
]

// a global variable to manage interruption
let stopped

const normalizeURL = (url) => {
  for (const indexSuffix of ['index.html', 'index.php', 'index.jsp', 'index.cgi']) {
    if (url.endsWith('/' + indexSuffix)) return url.slice(0, url.length - indexSuffix.length)
  }
  return url
}

class PagesIterator {
  constructor (log) {
    this.pages = []
    this.cursor = -1
    this.log = log
  }

  [Symbol.asyncIterator] () {
    return this
  }

  push (page) {
    // TODO: apply no-follow rules
    if (typeof page === 'string') page = { url: page }
    page.normalizedURL = normalizeURL(page.url)
    if (this.pages.find(p => p.normalizedURL === page.normalizedURL)) return
    page._id = crypto.createHash('sha256').update(page.normalizedURL).digest('base64url').slice(0, 20)
    this.pages.push(page)
  }

  async next () {
    this.cursor += 1
    if (this.cursor === 0) await this.log.task('Crawl pages')
    await this.log.progress('Crawl pages', this.cursor, this.pages.length)
    const page = this.pages[this.cursor]
    await this.log.debug('next page', page)
    return { value: page, done: this.cursor === this.pages.length }
  }
}

exports.run = async ({ pluginConfig, processingConfig, processingId, dir, tmpDir, axios, log, patchConfig, ws }) => {
  let dataset
  if (processingConfig.datasetMode === 'create') {
    await log.step('Dataset creation')
    dataset = (await axios.post('api/v1/datasets', {
      id: processingConfig.dataset.id,
      title: processingConfig.dataset.title,
      isRest: true,
      schema: datasetSchema,
      extras: { processingId }
    })).data
    await log.info(`dataset created, id="${dataset.id}", title="${dataset.title}"`)
    await patchConfig({ datasetMode: 'update', dataset: { id: dataset.id, title: dataset.title } })
    await ws.waitForJournal(dataset.id, 'finalize-end')
  } else if (processingConfig.datasetMode === 'update') {
    await log.step('Check dataset')
    dataset = (await axios.get(`api/v1/datasets/${processingConfig.dataset.id}`)).data
    if (!dataset) throw new Error(`the dataset does not exist, id="${processingConfig.dataset.id}"`)
    await log.info(`the dataset exists, id="${dataset.id}", title="${dataset.title}"`)
  }

  const pages = new PagesIterator(log)

  await log.step('Init pages list')
  await log.info(`add ${processingConfig.startURLs.length} pages from config`)
  for (const url of processingConfig.startURLs) await pages.push({ url, source: 'config start URLs' })
  if (processingConfig.datasetMode === 'update') {
    const existingPages = (await axios.get(`api/v1/datasets/${dataset.id}/lines`, { params: { select: '_id,url,etag,lastModified', size: 10000 } })).data.results
    await log.info(`add ${existingPages.length} pages from previous crawls`)
    for (const page of existingPages) await pages.push({ page, source: 'previous exploration' })
  }
  // TODO: init from sitemap

  const sendPage = async (page, data, contentType = 'text/html', filename = 'content.html') => {
    await log.debug('post page', page)
    // TODO: apply no-index rules
    const form = new FormData()
    let title = page.title.trim()
    if (processingConfig.titlePrefix && title.startsWith(processingConfig.titlePrefix)) {
      title = title.replace(processingConfig.titlePrefix, '')
    }
    form.append('title', title)
    form.append('url', page.url)
    if (page.tags && page.tags.length) form.append('tags', page.tags.join(','))
    data = typeof data === 'string' ? Buffer.from(data) : data
    const dataOpts = {
      contentType,
      filename,
      knownLength: data.length
    }
    form.append('attachment', data, dataOpts)
    const headers = {
      ...form.getHeaders(),
      'content-length': form.getLengthSync()
    }
    await axios({
      method: 'put',
      url: `api/v1/datasets/${dataset.id}/lines/${page._id}`,
      data: form,
      headers
    })
  }

  for await (const page of pages) {
    const pageIntervalPromise = new Promise(resolve => setTimeout(resolve, pluginConfig.pageIntervalMS || 1000))
    if (stopped) break
    // TODO: apply if-none-match and if-modified-since headers if etag or lastModified are available
    let response
    try {
      response = await axios.get(page.url)
    } catch (err) {
      await log.warning(`failed to fetch page ${page.url} - ${err.status || err.message}`)
      if (page.source) await log.warning(`this broken URL comes from ${page.source}`)
      await pageIntervalPromise
      continue
    }

    // console.log(response.headers, response.data)
    const isHTML = (response.headers['content-type'] && response.headers['content-type'].startsWith('text/html;')) || (typeof response.data === 'string' && response.data.trim().startsWith('<html'))
    if (isHTML) {
      const cheerio = require('cheerio')
      const $ = cheerio.load(response.data)
      page.title = $('title').text()
      $('a').each(function (i, elem) {
        const href = $(this).attr('href')
        if (href) pages.push({ url: new URL(href, page.url).href, source: page.url })
      })

      if (processingConfig.prune) {
        processingConfig.prune.forEach(s => $(s).remove())
      }

      await sendPage(page, response.data)
    }
    await pageIntervalPromise
  }
}

// used to manage interruption
// not required but it is a good practice to prevent incoherent state a smuch as possible
// the run method should finish shortly after calling stop, otherwise the process will be forcibly terminated
// the grace period before force termination is 20 seconds
exports.stop = async () => {
  stopped = true
}
