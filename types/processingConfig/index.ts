export interface Dataset {
  id?: string
  title?: string
}

export interface Anchor {
  tags?: string[]
  wrapperSelector?: string
  titleSelector?: string
}

export interface ProcessingConfig {
  datasetMode?: 'create' | 'update'
  dataset?: Dataset
  baseURLs?: string[]
  startURLs?: string[]
  titlePrefix?: string
  titleSelectors?: string[]
  tagsSelectors?: string[]
  extractKeywords?: boolean
  extractArticleTags?: boolean
  extractDescription?: boolean
  sitemaps?: string[]
  prune?: string[]
  excludeURLPatterns?: string[]
  anchors?: Anchor[]
}
