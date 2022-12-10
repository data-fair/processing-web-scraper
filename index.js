const FormData = require('form-data')
const crypto = require('crypto')
const robotsParser = require('robots-parser')

// TODO:
// handle html but also any file formats
// add in-links info (at least for files)
// store last-modified and e-tag and use is when re-crawling a site
// specifications listed here http://robots-txt.com/
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
  const parsedURL = new URL(url)
  for (const indexSuffix of ['index.html', 'index.php', 'index.jsp', 'index.cgi']) {
    if (parsedURL.pathname.endsWith('/' + indexSuffix)) {
      parsedURL.pathname = parsedURL.pathname.slice(0, parsedURL.pathname.length - indexSuffix.length)
    }
  }
  return parsedURL.href
}

const getId = (page) => {
  return crypto.createHash('sha256').update(normalizeURL(page.url)).digest('base64url').slice(0, 20)
}

class PagesIterator {
  constructor (log, pluginConfig, processingConfig, robots) {
    this.pages = []
    this.cursor = -1
    this.log = log
    this.pluginConfig = pluginConfig
    this.processingConfig = processingConfig
    this.robots = robots
  }

  [Symbol.asyncIterator] () {
    return this
  }

  push (page) {
    // TODO: apply no-follow rules
    if (typeof page === 'string') page = { url: page }
    if (!this.processingConfig.baseURLs.find(b => page.url.startsWith(b))) return
    page.parsedURL = page.parsedURL || new URL(page.url)
    if (page.parsedURL.hash) return
    if (this.robots[page.parsedURL.origin] && !this.robots[page.parsedURL.origin].isAllowed(page.url, this.pluginConfig.userAgent || 'data-fair-web-scraper')) {
      return
    }
    page._id = getId(page)
    if (this.pages.find(p => p._id === page._id)) return
    this.pages.push(page)
  }

  async next () {
    this.cursor += 1
    if (this.cursor === 0) await this.log.task('Crawl pages')
    await this.log.progress('Crawl pages', this.cursor, this.pages.length)
    const page = this.pages[this.cursor]
    if (page) await this.log.debug('next page', page.url)
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

  // parse the robots.txt files if available
  const robots = {}
  for (const baseURL of processingConfig.baseURLs) {
    const { origin } = new URL(baseURL)
    if (robots[origin]) continue
    try {
      const response = await axios.get(origin + '/robots.txt')
      robots[origin] = robotsParser(origin + '/robots.txt', response.data)
    } catch (err) {
      await log.info(`failed to fetch ${origin + '/robots.txt'} - ${err.status || err.message}`)
    }
  }

  const pages = new PagesIterator(log, pluginConfig, processingConfig, robots)

  await log.step('Init pages list')
  let existingPages
  if (processingConfig.datasetMode === 'update') {
    existingPages = (await axios.get(`api/v1/datasets/${dataset.id}/lines`, { params: { select: '_id,url,etag,lastModified', size: 10000 } })).data.results
    await log.info(`add ${existingPages.length} pages from previous crawls`)
    for (const page of existingPages) {
      page.parsedURL = new URL(page.url)
      if (page.parsedURL.hash) {
        const parentURL = new URL(page.parsedURL)
        parentURL.hash = ''
        page.parentId = getId({ url: parentURL.href })
      }
      await pages.push({ ...page, source: 'previous exploration' })
    }
  }
  await log.info(`add ${processingConfig.startURLs.length} pages from config`)
  for (const url of processingConfig.startURLs) {
    await pages.push({ url, source: 'config start URLs' })
  }
  // TODO: init from sitemap (and use robots.getSitemaps() to help in this)

  const sentIds = new Set([])
  const sendPage = async (page, data, contentType = 'text/html', filename = 'content.html') => {
    await log.debug('send page', page.url)
    // TODO: apply no-index rules
    const form = new FormData()
    // improve page title
    if (page.title) {
      page.title = page.title.trim()
      if (processingConfig.titlePrefix && page.title.startsWith(processingConfig.titlePrefix)) {
        page.title = page.title.replace(processingConfig.titlePrefix, '')
      }
    }
    form.append('title', page.title)
    form.append('url', page.url)
    if (page.tags && page.tags.length) form.append('tags', page.tags.join(','))
    data = typeof data === 'string' ? Buffer.from(data) : data
    const dataOpts = {
      contentType,
      filename,
      knownLength: data.length
    }
    form.append('attachment', data, dataOpts)
    if (page.lastModified) form.append('lastModified', page.lastModified)
    if (page.etag) form.append('etag', page.etag)
    page._id = getId(page)
    sentIds.add(page._id)
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
    if (stopped) break

    const crawlDelay = (robots[page.parsedURL.origin] && robots[page.parsedURL.origin].getCrawlDelay()) || pluginConfig.defaultCrawlDelay || 1
    await new Promise(resolve => setTimeout(resolve, crawlDelay * 1000))

    // TODO: apply if-none-match and if-modified-since headers if etag or lastModified are available
    const headers = { 'user-agent': pluginConfig.userAgent || 'data-fair-web-scraper' }
    if (page.lastModified) headers['if-modified-since'] = page.lastModified
    if (page.etag) headers['if-none-match'] = page.etag
    let response
    try {
      response = await axios.get(page.url, { headers, maxRedirects: 0 })
    } catch (err) {
      // content did not change
      if (err.status === 304) {
        await log.debug(`page was not modified since last exploration ${page.url}`)
        sentIds.add(page._id)
        for (const existingPage of existingPages) {
          if (existingPage.parentId === page._id) sentIds.add(existingPage._id)
        }
        continue
      }
      // follow a redirect
      if (err.status === 301) {
        await log.debug(`page redirected ${page.url} -> ${err.headers.location}`)
        pages.push({ url: new URL(err.headers.location, page.url).href, source: 'redirect ' + page.url })
        continue
      }
      await log.warning(`failed to fetch page ${page.url} - ${err.status || err.message}`)
      if (page.source) await log.warning(`this broken URL comes from ${page.source}`)
      continue
    }

    if (response.headers['x-robots-tag']) {
      for (const part of response.headers['x-robots-tag'].split(',').map(p => p.trim())) {
        if (part === 'noindex') page.noindex = true
        if (part === 'nofollow') page.nofollow = true
      }
    }

    page.lastModified = response.headers['last-modified']
    page.etag = response.headers.etag

    const isHTML = (response.headers['content-type'] && response.headers['content-type'].startsWith('text/html;')) || (typeof response.data === 'string' && response.data.trim().startsWith('<html'))
    if (isHTML) {
      const cheerio = require('cheerio')
      const $ = cheerio.load(response.data)
      page.title = $('title').text()

      $('meta').each(function (i, elem) {
        const name = $(this).attr('name')
        if (name === 'robots') {
          const content = $(this).attr('content')
          if (content) {
            for (const part of content.split(',').map(p => p.trim())) {
              if (part === 'noindex') page.noindex = true
              if (part === 'nofollow') page.nofollow = true
            }
          }
        }
      })

      if (!page.noindex && processingConfig.anchors && processingConfig.anchors.length) {
        const anchorsPages = []
        $('a').each(function (i, elem) {
          const href = $(this).attr('href')
          if (!href) return
          const parsedURL = new URL(href, page.url)
          if (parsedURL.hash) {
            const targetElement = $(parsedURL.hash)
            if (!targetElement) return
            for (const anchor of processingConfig.anchors || []) {
              const fragment = anchor.wrapperSelector ? targetElement.closest(anchor.wrapperSelector) : targetElement
              const fragmentHtml = fragment.html()
              if (fragmentHtml) {
                const anchorPage = { url: parsedURL.href, tags: anchor.tags || [], source: 'anchor ' + page.url }
                if (anchor.titleSelector) anchorPage.title = fragment.find(anchor.titleSelector).text() || page.title
                else anchorPage.title = targetElement.text() || page.title
                anchorsPages.push([anchorPage, fragmentHtml])
                $(fragment).remove()
              }
            }
          }
        })
        for (const [anchorPage, fragmentHtml] of anchorsPages) {
          await sendPage(anchorPage, `<body>
  ${fragmentHtml}
</body>`)
        }
      }

      if (!page.nofollow) {
        $('a').each(function (i, elem) {
          const href = $(this).attr('href')
          if (href) pages.push({ url: new URL(href, page.url).href, source: 'link ' + page.url })
        })
      }

      if (!page.noindex) {
        if (processingConfig.prune) {
          processingConfig.prune.forEach(s => $(s).remove())
        }
        await sendPage(page, $.html())
      }
    }
  }

  if (existingPages) {
    for (const existingPage of existingPages) {
      if (!sentIds.has(existingPage._id)) {
        await log.info('delete previously explored page that was not indexed this time', existingPage.url)
        await axios.delete(`api/v1/datasets/${dataset.id}/lines/${existingPage._id}`)
      }
    }
  }
}

// used to manage interruption
// not required but it is a good practice to prevent incoherent state a smuch as possible
// the run method should finish shortly after calling stop, otherwise the process will be forcibly terminated
// the grace period before force termination is 20 seconds
exports.stop = async () => {
  stopped = true
}
