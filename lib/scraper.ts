import { createHash } from 'node:crypto'
import UrlPattern from 'url-pattern'
import robotsParser from 'robots-parser'
import cheerio from 'cheerio'
import FormData from 'form-data'
import type { ProcessingContext } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from '../types/processingConfig/index.ts'

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

let stopped: boolean | undefined

const normalizeURL = (url: string, ignoreHash = false, addSlash = false): string => {
  const parsedURL = new URL(url)
  for (const indexSuffix of ['index.html', 'index.php', 'index.jsp', 'index.cgi']) {
    if (parsedURL.pathname.endsWith('/' + indexSuffix)) {
      parsedURL.pathname = parsedURL.pathname.slice(0, parsedURL.pathname.length - indexSuffix.length)
    }
  }
  if (ignoreHash) parsedURL.hash = ''
  if (addSlash && !parsedURL.pathname.endsWith('/')) parsedURL.pathname += '/'
  return parsedURL.href
}

const getId = async (page: { url: string }): Promise<string> => {
  return createHash('sha256').update(normalizeURL(page.url)).digest('base64url').slice(0, 20)
}

interface Page {
  url: string
  title?: string
  tags?: string[]
  etag?: string
  lastModified?: string
  attachmentPath?: string
  _id?: string
  parsedURL?: URL
  source?: string
  noindex?: boolean
  nofollow?: boolean
  parentId?: string
}

class PagesIterator {
  pages: Page[] = []
  cursor = -1
  log: any
  pluginConfig: any
  processingConfig: ProcessingConfig
  robots: Record<string, any>
  excludeURLPatterns: any[] = []

  constructor (log: any, pluginConfig: any, processingConfig: ProcessingConfig, robots: Record<string, any>) {
    this.log = log
    this.pluginConfig = pluginConfig
    this.processingConfig = processingConfig
    this.robots = robots
    this.excludeURLPatterns = (processingConfig.excludeURLPatterns || []).map((p: string) => {
      const url = new URL(p)
      const pattern = new UrlPattern(url.pathname)
      pattern.hostname = url.hostname
      return pattern
    })
  }

  [Symbol.asyncIterator] () {
    return this
  }

  async push (page: Page | string) {
    if (typeof page === 'string') page = { url: page }
    if (!this.processingConfig.baseURLs?.find((b: string) => page.url.startsWith(b))) return
    page.parsedURL = page.parsedURL || new URL(page.url)
    if (page.parsedURL.hash) return
    if (this.excludeURLPatterns.find((p: any) => p.match(page.parsedURL!.pathname) && p.hostname === page.parsedURL!.hostname)) {
      return
    }
    if (this.robots[page.parsedURL!.origin] && !this.robots[page.parsedURL!.origin].isAllowed(page.url, this.pluginConfig.userAgent || 'data-fair-web-scraper')) {
      return
    }
    page._id = await getId(page)
    if (this.pages.find((p: Page) => p._id === page._id)) return
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

export const run = async (context: ProcessingContext<ProcessingConfig>) => {
  const { pluginConfig, processingConfig, processingId, axios, log, patchConfig, ws } = context
  let dataset: any
  if (processingConfig.datasetMode === 'create') {
    await log.step('Dataset creation')
    dataset = (await axios.post('api/v1/datasets', {
      id: processingConfig.dataset?.id,
      title: processingConfig.dataset?.title,
      isRest: true,
      schema: datasetSchema,
      extras: { processingId }
    })).data
    if (dataset.status !== 'finalized') {
      await ws.waitForJournal(dataset.id, 'finalize-end')
    }
    await log.info(`dataset created, id="${dataset.id}", title="${dataset.title}"`)
    await patchConfig({ datasetMode: 'update', dataset: { id: dataset.id, title: dataset.title } })
  } else if (processingConfig.datasetMode === 'update') {
    await log.step('Check dataset')
    dataset = (await axios.get(`api/v1/datasets/${processingConfig.dataset?.id}`)).data
    if (!dataset) throw new Error(`the dataset does not exist, id="${processingConfig.dataset?.id}"`)
    await log.info(`the dataset exists, id="${dataset.id}", title="${dataset.title}"`)
  }

  const robots: Record<string, any> = {}
  const sitemaps = processingConfig.sitemaps || []
  for (const baseURL of processingConfig.baseURLs || []) {
    const { origin } = new URL(baseURL)
    if (robots[origin]) continue
    try {
      const response = await axios.get(origin + '/robots.txt')
      robots[origin] = robotsParser(origin + '/robots.txt', response.data)
      for (const sitemap of robots[origin].getSitemaps()) {
        if (!sitemaps.includes(sitemap)) sitemaps.push(sitemap)
      }
    } catch (err: any) {
      await log.info(`failed to fetch ${origin + '/robots.txt'} - ${err.status || err.message}`)
    }
  }

  const pages = new PagesIterator(log, pluginConfig, processingConfig, robots)

  await log.step('Init pages list')
  let existingPages: Page[] | undefined
  if (processingConfig.datasetMode === 'update') {
    existingPages = (await axios.get(`api/v1/datasets/${dataset.id}/lines`, { params: { select: '_id,url,etag,lastModified', size: 10000 } })).data.results
    if (existingPages) {
      await log.info(`add ${existingPages.length} pages from previous crawls`)
      for (const page of existingPages) {
        page.parsedURL = new URL(page.url)
        if (page.parsedURL.hash) {
          const parentURL = new URL(page.parsedURL)
          parentURL.hash = ''
          page.parentId = await getId({ url: parentURL.href })
        }
        await pages.push({ ...page, source: 'previous exploration' })
      }
    }
  }
  await log.info(`add ${processingConfig.startURLs?.length || 0} pages from config`)
  for (const url of processingConfig.startURLs || []) {
    await pages.push({ url, source: 'config start URLs' })
  }

  for (const sitemapURL of sitemaps) {
    await log.info(`fetch start URLs from sitemap ${sitemapURL}`)
    const sitemap = (await axios.get(sitemapURL)).data
    const $ = cheerio.load(sitemap)
    const sitemapURLs: string[] = []
    $('url loc').each(function (this: any) {
      sitemapURLs.push($(this).text())
    })
    for (const url of sitemapURLs) {
      await pages.push({ url, source: 'sitemap' })
    }
  }

  const sentIds = new Set<string>()
  const sendPage = async (page: Page, data: any, contentType = 'text/html', filename = 'content.html') => {
    await log.debug('send page', page.url)
    const form = new FormData()

    if (page.title) {
      page.title = page.title.trim()
      if (processingConfig.titlePrefix && page.title.startsWith(processingConfig.titlePrefix)) {
        page.title = page.title.replace(processingConfig.titlePrefix, '')
      }
    }
    data = typeof data === 'string' ? Buffer.from(data) : data
    const dataOpts = {
      contentType,
      filename,
      knownLength: data.length
    }
    form.append('attachment', data, dataOpts)
    page._id = await getId(page)
    sentIds.add(page._id)
    const body = { ...page }
    delete body.source
    delete body.parsedURL
    delete body.nofollow
    delete body.noindex
    form.append('_body', JSON.stringify(body))
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

    const crawlDelay = (robots[page.parsedURL!.origin] && robots[page.parsedURL!.origin].getCrawlDelay()) || pluginConfig.defaultCrawlDelay || 1
    await new Promise(resolve => setTimeout(resolve, crawlDelay * 1000))

    const headers: Record<string, string> = { 'user-agent': pluginConfig.userAgent || 'data-fair-web-scraper' }
    if (page.lastModified) headers['if-modified-since'] = page.lastModified
    if (page.etag) headers['if-none-match'] = page.etag
    let response: any
    try {
      response = await axios.get(page.url, { headers, maxRedirects: 0 })
    } catch (err: any) {
      if (err.status === 304) {
        await log.debug(`page was not modified since last exploration ${page.url}`)
        sentIds.add(page._id!)
        for (const existingPage of existingPages || []) {
          if (existingPage.parentId === page._id) sentIds.add(existingPage._id!)
        }
        continue
      }
      if (err.status === 301) {
        await log.debug(`page redirected ${page.url} -> ${err.headers.location}`)
        await pages.push({ url: new URL(err.headers.location, page.url).href, source: 'redirect ' + page.url })
        continue
      }
      await log.warning(`failed to fetch page ${page.url} - ${err.status || err.message}`)
      if (page.source) await log.warning(`this broken URL comes from ${page.source}`)
      continue
    }

    if (response.headers['x-robots-tag']) {
      await log.debug('x-robots-tag header', response.headers['x-robots-tag'])
      for (const part of response.headers['x-robots-tag'].split(',').map((p: string) => p.trim())) {
        if (part === 'noindex') page.noindex = true
        if (part === 'nofollow') page.nofollow = true
      }
    }
    page.lastModified = response.headers['last-modified']
    page.etag = response.headers.etag

    const isHTML = (response.headers['content-type'] && response.headers['content-type'].startsWith('text/html;')) || (typeof response.data === 'string' && response.data.trim().startsWith('<html'))
    if (isHTML) {
      const $ = cheerio.load(response.data)
      const titleSelectors = (processingConfig.titleSelectors || []).concat(['title', 'h1'])
      for (const titleSelector of titleSelectors) {
        page.title = $(titleSelector).text()
        if (page.title) {
          await log.debug(`used title selector "${titleSelector}" -> ${page.title.trim()}`)
          break
        }
      }
      page.tags = []
      if (processingConfig.tagsSelectors && processingConfig.tagsSelectors.length) {
        for (const tagsSelector of processingConfig.tagsSelectors) {
          $(tagsSelector).each(function (this: any) {
            const tag = $(this).text().trim()
            if (tag) page.tags!.push(tag)
          })
        }
      }

      $('meta').each(function (this: any) {
        const name = $(this).attr('name')
        if (name === 'robots') {
          const content = $(this).attr('content')
          log.debug('robots meta', content)
          if (content) {
            for (const part of content.split(',').map((p: string) => p.trim())) {
              if (part === 'noindex') page.noindex = true
              if (part === 'nofollow') page.nofollow = true
            }
          }
        }
      })

      if (!page.noindex && processingConfig.anchors && processingConfig.anchors.length) {
        const anchorsPages: [Page, string][] = []
        $('a').each(function (this: any) {
          const href = $(this).attr('href')
          if (!href) return
          const parsedURL = new URL(href, page.url)
          if (parsedURL.hash && normalizeURL(parsedURL.href, true, true) === normalizeURL(page.url, true, true)) {
            const targetElement = $(parsedURL.hash)
            if (!targetElement) return
            for (const anchor of processingConfig.anchors || []) {
              const fragment = anchor.wrapperSelector ? targetElement.closest(anchor.wrapperSelector) : targetElement
              const fragmentHtml = fragment.html()
              if (fragmentHtml) {
                const anchorPage: Page = { url: parsedURL.href, tags: anchor.tags || [], source: 'anchor ' + page.url }
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
        $('a').each(function (this: any) {
          const href = $(this).attr('href')
          if (href) pages.push({ url: new URL(href, page.url).href, source: 'link ' + page.url })
        })
      }

      if (!page.noindex) {
        if (processingConfig.prune) {
          processingConfig.prune.forEach((s: string) => $(s).remove())
        }
        await sendPage(page, $.html())
      }
    }
  }

  if (existingPages) {
    for (const existingPage of existingPages) {
      if (!sentIds.has(existingPage._id!)) {
        await log.info('delete previously explored page that was not indexed this time', existingPage.url)
        await axios.delete(`api/v1/datasets/${dataset.id}/lines/${existingPage._id}`)
      }
    }
  }
}

export const stop = async () => {
  stopped = true
}
