import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useSearchParams } from 'react-router-dom'
import katex from 'katex'
import 'katex/dist/katex.min.css'

import DismissibleError from '../components/DismissibleError'
import CodeBlock from '../components/CodeBlock'
import CodeEmbedCard from '../components/CodeEmbedCard'
import CodeViewerDialog from '../components/CodeViewerDialog'
import ReferencesSection from '../components/ReferencesSection'
import { getNoteContent, getNoteRepositories, getNotes } from '../api/githubNotes'
import { NOTE_REPOSITORIES } from '../config/noteRepositories'

const ExcalidrawViewer = React.lazy(() => import('../components/ExcalidrawViewer'))
const ExcalidrawThumbnail = React.lazy(() => import('../components/ExcalidrawThumbnail'))

let mermaidRenderSequence = 0
const READER_PREVIEW_HOSTS = ['bytebytego.com']

function relativeUrl(value, rawUrl) {
  if (!value || !rawUrl || /^(?:[a-z]+:|#|\/\/)/i.test(value)) return value
  try { return new URL(value, rawUrl).toString() } catch { return value }
}

function displayName(value = '') {
  if (/^(?:19|20)\d{2}(?:\s*[-–—]\s*(?:19|20)\d{2})?$/.test(value.trim())) return value.trim()
  return value.replace(/^\d+[_. -]*/, '').replace(/[_-]+/g, ' ').replace(/\b\w/g, character => character.toUpperCase())
}

function internalNotesTarget(href, note, index) {
  if (!href || !note?.path || (!index?.notes?.length && !index?.allNotes?.length) || href.startsWith('#')) return null
  try {
    const resolved = new URL(href, `https://learning-notes.local/${note.path}`)
    let candidate = null
    const hash = resolved.hash ? decodeURIComponent(resolved.hash.replace(/^#/, '')) : ''
    if (resolved.hostname === 'learning-notes.local') {
      candidate = decodeURIComponent(resolved.pathname.replace(/^\/+/, ''))
    } else if (resolved.hostname === 'github.com') {
      const parts = resolved.pathname.split('/').filter(Boolean)
      if (parts[0]?.toLowerCase() === index.owner?.toLowerCase() && parts[1]?.toLowerCase() === index.repo?.toLowerCase() && ['blob', 'tree'].includes(parts[2]) && parts[3] === index.branch) candidate = decodeURIComponent(parts.slice(4).join('/'))
    } else if (resolved.hostname === 'raw.githubusercontent.com') {
      const parts = resolved.pathname.split('/').filter(Boolean)
      if (parts[0]?.toLowerCase() === index.owner?.toLowerCase() && parts[1]?.toLowerCase() === index.repo?.toLowerCase() && parts[2] === index.branch) candidate = decodeURIComponent(parts.slice(3).join('/'))
    }
    if (candidate === null) return null
    candidate = candidate.replace(/\/+$/, '')

    // Non-markdown file extensions (e.g. .excalidraw, .png, .pdf, etc.) are assets/drawings, not notes or folders
    const lastSegment = candidate.split('/').at(-1) || ''
    if (lastSegment.includes('.') && !/\.(md|markdown)$/i.test(lastSegment)) {
      return null
    }

    const pool = index.allNotes || index.notes || []
    const exactNote = pool.find(item => item.path.toLowerCase() === candidate.toLowerCase())
    if (exactNote) return { type: 'note', note: exactNote, hash }
    if (/\.(md|markdown)$/i.test(candidate)) {
      const fileName = candidate.split('/').at(-1).replace(/\.(md|markdown)$/i, '')
      return {
        type: 'note',
        note: {
          path: candidate,
          title: displayName(fileName),
          github_url: index.repository_url ? `${index.repository_url.replace(/\/$/, '')}/blob/${encodeURIComponent(index.branch)}/${candidate}` : '',
        },
        hash,
      }
    }
    const prefix = candidate ? `${candidate.toLowerCase()}/` : ''
    const folderNotes = pool.filter(item => item.path.toLowerCase().startsWith(prefix))
    if (!folderNotes.length) {
      const folderName = candidate.split('/').filter(Boolean).at(-1) || candidate
      const landingNotePath = `${candidate}/README.md`
      return {
        type: 'folder',
        folderPath: candidate,
        note: {
          path: landingNotePath,
          title: displayName(folderName),
          github_url: index.repository_url ? `${index.repository_url.replace(/\/$/, '')}/tree/${encodeURIComponent(index.branch)}/${candidate}` : '',
        },
        noteCount: 0,
        hash,
      }
    }
    const rankedNotes = [...folderNotes].sort((left, right) => {
      const leftRelative = left.path.slice(candidate.length + (candidate ? 1 : 0))
      const rightRelative = right.path.slice(candidate.length + (candidate ? 1 : 0))
      const score = relativePath => {
        const parts = relativePath.split('/')
        const fileName = parts.at(-1).toLowerCase()
        if (parts.length === 1 && /^(?:readme|index|overview)\.md$/.test(fileName)) return 0
        if (parts.length === 1) return 1
        return 2 + parts.length
      }
      return score(leftRelative) - score(rightRelative) || leftRelative.localeCompare(rightRelative, undefined, { numeric: true })
    })
    return { type: 'folder', folderPath: candidate, note: rankedNotes[0], noteCount: folderNotes.length, hash }
  } catch {
    return null
  }
}

function youtubeVideoId(url) {
  try {
    const parsed = new URL(url)
    if (parsed.hostname === 'youtu.be') return parsed.pathname.split('/').filter(Boolean)[0] || ''
    if (/(^|\.)youtube\.com$/.test(parsed.hostname)) {
      if (parsed.pathname === '/watch') return parsed.searchParams.get('v') || ''
      const parts = parsed.pathname.split('/').filter(Boolean)
      if (['shorts', 'embed', 'live'].includes(parts[0])) return parts[1] || ''
    }
  } catch { /* The caller will use the generic link preview. */ }
  return ''
}

function isYoutubePost(url) {
  try {
    const parsed = new URL(url)
    return /(^|\.)youtube\.com$/.test(parsed.hostname) && parsed.pathname.split('/').filter(Boolean)[0] === 'post'
  } catch {
    return false
  }
}

function youtubeEmbedUrl(videoId) {
  const embed = new URL(`https://www.youtube-nocookie.com/embed/${videoId}`)
  embed.searchParams.set('origin', window.location.origin)
  return embed.toString()
}

function linkDescriptor(href, note, index, label = '') {
  const internalTarget = internalNotesTarget(href, note, index)
  if (internalTarget?.type === 'note') {
    const indexedNote = internalTarget.note
    return {
      type: 'note',
      path: indexedNote.path,
      title: indexedNote.title || displayName(indexedNote.path.split('/').at(-1)),
      url: indexedNote.github_url || relativeUrl(href, note.raw_url),
      hash: internalTarget.hash,
      label,
    }
  }
  if (internalTarget?.type === 'folder') {
    const treePath = internalTarget.folderPath.split('/').map(encodeURIComponent).join('/')
    const folderUrl = index.repository_url ? `${index.repository_url.replace(/\/$/, '')}/tree/${encodeURIComponent(index.branch)}/${treePath}` : relativeUrl(href, note.raw_url)
    return {
      type: 'folder',
      path: internalTarget.note.path,
      folderPath: internalTarget.folderPath,
      noteCount: internalTarget.noteCount,
      title: label || displayName(internalTarget.folderPath.split('/').at(-1)) || 'Repository notes',
      url: folderUrl,
      hash: internalTarget.hash,
      label,
    }
  }
  const url = relativeUrl(href, note?.raw_url)
  try {
    const parsed = new URL(url)
    const hash = parsed.hash ? decodeURIComponent(parsed.hash.replace(/^#/, '')) : ''
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '')
    const videoId = youtubeVideoId(url)
    let type = 'external'
    if (videoId) type = 'youtube'
    else if (isYoutubePost(url)) type = 'youtube-post'
    else if (hostname === 'github.com' || hostname.endsWith('.github.com')) type = 'github'
    else if (hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com')) type = 'chatgpt'
    else if (hostname === 'chat.deepseek.com' || hostname.endsWith('.deepseek.com')) type = 'deepseek'
    else if (hostname === 'excalidraw.com') type = 'excalidraw'
    else if (parsed.pathname.toLowerCase().endsWith('.excalidraw')) type = 'excalidraw'
    const excalidrawFileTitle = type === 'excalidraw' && parsed.pathname.toLowerCase().endsWith('.excalidraw')
      ? displayName(parsed.pathname.split('/').at(-1).replace(/\.excalidraw$/i, ''))
      : null
    const pathSlug = parsed.pathname.split('/').filter(Boolean).pop()?.replace(/[-_]+/g, ' ')?.trim()
    const autoTitle = excalidrawFileTitle || (type === 'excalidraw' ? 'Excalidraw Diagram' : pathSlug && pathSlug.length > 2 ? pathSlug.charAt(0).toUpperCase() + pathSlug.slice(1) : hostname)
    return { type, url, hostname, videoId, hash, title: label || autoTitle, label }
  } catch {
    return { type: 'external', url: href, hostname: '', hash: '', title: label || 'External link', label }
  }
}

function findTargetHeading(headings, rawHash) {
  if (!rawHash || !headings?.length) return null
  const clean = decodeURIComponent(rawHash).replace(/^#/, '').toLowerCase().trim()
  if (!clean) return null
  const cleanSlug = slug(clean)

  // 1. Exact ID match
  let match = headings.find(h => h.id.toLowerCase() === clean || h.id.toLowerCase() === cleanSlug)
  if (match) return match

  // 2. Exact Title slug match
  match = headings.find(h => slug(h.title).toLowerCase() === clean || slug(h.title).toLowerCase() === cleanSlug)
  if (match) return match

  // 3. Match ignoring leading numbers/bullets (e.g. '3-hot-keys' matching 'hot-keys')
  const cleanWithoutNum = clean.replace(/^\d+[-_.]*/, '')
  if (cleanWithoutNum) {
    match = headings.find(h => {
      const hIdWithoutNum = h.id.toLowerCase().replace(/^\d+[-_.]*/, '')
      const hSlugWithoutNum = slug(h.title).toLowerCase().replace(/^\d+[-_.]*/, '')
      return hIdWithoutNum === cleanWithoutNum || hSlugWithoutNum === cleanWithoutNum
    })
    if (match) return match
  }

  // 4. Fuzzy contains match
  match = headings.find(h => {
    const hId = h.id.toLowerCase()
    return clean.includes(hId) || hId.includes(clean)
  })

  return match || null
}

function supportsDrawerPreview(descriptor) {
  if (['note', 'folder', 'youtube', 'excalidraw'].includes(descriptor?.type)) return true
  const hostname = descriptor?.hostname || ''
  return READER_PREVIEW_HOSTS.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))
}

function openInNewTab(url) {
  const opened = window.open(url, '_blank', 'noopener,noreferrer')
  if (opened) opened.opener = null
}

function relativeParts(path, rootPath) {
  const prefix = rootPath ? `${rootPath.replace(/\/$/, '')}/` : ''
  return (path.startsWith(prefix) ? path.slice(prefix.length) : path).split('/')
}

function taxonomy(note, rootPath) {
  const parts = relativeParts(note.path, rootPath)
  return { year: parts.length > 1 ? parts[0] : 'Notes', topic: parts.length > 2 ? parts[1] : 'General' }
}

function formatDirectoryName(name) {
  if (!name) return ''
  return name.split(' / ').map(displayName).join(' / ')
}

function compactNode(node) {
  const compactedDirectories = new Map()
  for (const [key, dir] of node.directories.entries()) {
    let current = compactNode(dir)
    let combinedName = current.name || key
    let combinedPath = current.path
    while (current.notes.length === 0 && current.directories.size === 1) {
      const child = current.directories.values().next().value
      const compactedChild = compactNode(child)
      combinedName = `${combinedName} / ${compactedChild.name}`
      combinedPath = compactedChild.path
      current = compactedChild
    }
    compactedDirectories.set(combinedPath, {
      ...current,
      name: combinedName,
      path: combinedPath,
      directories: current.directories,
    })
  }
  return {
    ...node,
    directories: compactedDirectories,
  }
}

function buildTree(notes, prefixPath, { compact = true } = {}) {
  const root = { path: '', name: '', directories: new Map(), notes: [] }
  const prefix = prefixPath ? `${prefixPath.replace(/\/$/, '')}/` : ''
  for (const note of notes) {
    const relative = note.path.startsWith(prefix) ? note.path.slice(prefix.length) : note.path
    const parts = relative.split('/')
    let cursor = root
    for (const segment of parts.slice(0, -1)) {
      const path = cursor.path ? `${cursor.path}/${segment}` : segment
      if (!cursor.directories.has(segment)) cursor.directories.set(segment, { name: segment, path, directories: new Map(), notes: [] })
      cursor = cursor.directories.get(segment)
    }
    cursor.notes.push(note)
  }
  return compact ? compactNode(root) : root
}

function noteCount(node) {
  return node.notes.length + [...node.directories.values()].reduce((total, child) => total + noteCount(child), 0)
}

function directoryPaths(node) {
  return [...node.directories.values()].flatMap(child => [child.path, ...directoryPaths(child)])
}

function cleanHeading(value) {
  return value.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`~<>]/g, '').trim()
}

function slug(value) {
  return cleanHeading(value).toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-') || 'section'
}

function extractHeadings(markdown = '') {
  const withoutCode = markdown.replace(/^```[\s\S]*?^```/gm, '')
  const counts = {}
  return [...withoutCode.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)].map(match => {
    const title = cleanHeading(match[2])
    const base = slug(title)
    counts[base] = (counts[base] || 0) + 1
    return { level: match[1].length, title, id: counts[base] === 1 ? base : `${base}-${counts[base]}` }
  })
}

function MermaidDiagram({ source }) {
  const containerRef = React.useRef(null)
  const diagramId = React.useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const [error, setError] = React.useState('')
  const [showDialog, setShowDialog] = React.useState(false)
  const [zoom, setZoom] = React.useState(1)
  const [theme, setTheme] = React.useState(() => document.documentElement.getAttribute('data-theme') || 'light')

  React.useEffect(() => {
    const observer = new MutationObserver(() => setTheme(document.documentElement.getAttribute('data-theme') || 'light'))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  React.useEffect(() => {
    let active = true
    setError('')
    const renderDiagram = async () => {
      try {
        const { default: mermaid } = await import('mermaid')
        if (!active) return
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: theme === 'dark' ? 'dark' : 'default' })
        mermaidRenderSequence += 1
        const { svg, bindFunctions } = await mermaid.render(`notes-mermaid-${diagramId}-${mermaidRenderSequence}`, source)
        if (!active || !containerRef.current) return
        containerRef.current.innerHTML = svg
        bindFunctions?.(containerRef.current)
      } catch (renderError) {
        if (active) setError(renderError?.message || 'Unable to render this Mermaid diagram.')
      }
    }
    renderDiagram()
    return () => { active = false }
  }, [diagramId, source, theme])

  React.useEffect(() => {
    if (!showDialog) return undefined
    const close = event => { if (event.key === 'Escape') setShowDialog(false) }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [showDialog])

  if (error) return <div className="mermaid-error"><strong>Mermaid diagram error</strong><span>{error}</span><pre><code>{source}</code></pre></div>
  return <div className="mermaid-card">
    <div className="mermaid-toolbar"><span>Interactive diagram</span><button type="button" onClick={() => { setZoom(1); setShowDialog(true) }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg>Full screen</button></div>
    <div className="mermaid-diagram" ref={containerRef} aria-label="Mermaid diagram" />
    {showDialog && <div className="mermaid-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setShowDialog(false) }}><section className="mermaid-dialog" role="dialog" aria-modal="true" aria-label="Full-screen Mermaid diagram">
      <div className="mermaid-floating-controls" onClick={e => e.stopPropagation()}>
        <button type="button" onClick={() => setZoom(value => Math.max(0.25, Math.round((value - 0.2) * 10) / 10))} title="Zoom out" aria-label="Zoom out">−</button>
        <button type="button" onClick={() => setZoom(1)} title="Reset to Fit" className="zoom-reset-btn">{Math.round(zoom * 100)}%</button>
        <button type="button" onClick={() => setZoom(value => Math.min(3.5, Math.round((value + 0.2) * 10) / 10))} title="Zoom in" aria-label="Zoom in">+</button>
        <button type="button" className="mermaid-dialog-close" onClick={() => setShowDialog(false)} title="Close (Esc)" aria-label="Close diagram">×</button>
      </div>
      <div className="mermaid-dialog-stage"><div className="mermaid-dialog-canvas" style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }} dangerouslySetInnerHTML={{ __html: containerRef.current?.innerHTML || '' }} /></div>
    </section></div>}
  </div>
}

function ImageDialog({ src, alt, onClose }) {
  const [zoom, setZoom] = React.useState(1)

  React.useEffect(() => {
    const close = event => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [onClose])

  return (
    <div
      className="mermaid-dialog-backdrop"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
    >
      <section className="mermaid-dialog image-dialog" role="dialog" aria-modal="true" aria-label={alt ? `Image: ${alt}` : 'Image viewer'}>
        <div className="mermaid-floating-controls" onClick={e => e.stopPropagation()}>
          <button type="button" onClick={() => setZoom(value => Math.max(0.25, Math.round((value - 0.25) * 100) / 100))} title="Zoom out" aria-label="Zoom out">−</button>
          <button type="button" onClick={() => setZoom(1)} title="Reset to Fit" className="zoom-reset-btn">{Math.round(zoom * 100)}%</button>
          <button type="button" onClick={() => setZoom(value => Math.min(4, Math.round((value + 0.25) * 100) / 100))} title="Zoom in" aria-label="Zoom in">+</button>
          <button type="button" className="mermaid-dialog-close" onClick={onClose} title="Close (Esc)" aria-label="Close image">×</button>
        </div>
        <div className="mermaid-dialog-stage">
          <div className="image-dialog-canvas" style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}>
            <img src={src} alt={alt || ''} draggable={false} />
          </div>
        </div>
      </section>
    </div>
  )
}

function TableDialog({ children, onClose }) {
  const [zoom, setZoom] = React.useState(1)

  React.useEffect(() => {
    const close = event => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [onClose])

  return (
    <div
      className="mermaid-dialog-backdrop"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
    >
      <section className="mermaid-dialog table-dialog" role="dialog" aria-modal="true" aria-label="Table viewer">
        <div className="mermaid-floating-controls" onClick={e => e.stopPropagation()}>
          <button type="button" onClick={() => setZoom(value => Math.max(0.4, Math.round((value - 0.15) * 100) / 100))} title="Zoom out" aria-label="Zoom out">−</button>
          <button type="button" onClick={() => setZoom(1)} title="Reset to Fit" className="zoom-reset-btn">{Math.round(zoom * 100)}%</button>
          <button type="button" onClick={() => setZoom(value => Math.min(3, Math.round((value + 0.15) * 100) / 100))} title="Zoom in" aria-label="Zoom in">+</button>
          <button type="button" className="mermaid-dialog-close" onClick={onClose} title="Close (Esc)" aria-label="Close table">×</button>
        </div>
        <div className="mermaid-dialog-stage">
          <div className="table-dialog-canvas" style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}>
            <table className="notes-markdown-table is-dialog-table">
              {children}
            </table>
          </div>
        </div>
      </section>
    </div>
  )
}

function ClickableTable({ children, ...props }) {
  const [open, setOpen] = React.useState(false)
  const close = React.useCallback(() => setOpen(false), [])

  return (
    <>
      <div className="notes-table-container">
        <div className="notes-table-header-toolbar">
          <button
            type="button"
            className="notes-table-expand-btn"
            onClick={() => setOpen(true)}
            title="Expand table full screen"
            aria-label="Expand table full screen"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span>Full screen</span>
          </button>
        </div>
        <div className="notes-table-scroll">
          <table className="notes-markdown-table" {...props}>
            {children}
          </table>
        </div>
      </div>
      {open && <TableDialog onClose={close}>{children}</TableDialog>}
    </>
  )
}

function ExcalidrawDialog({ modal, onClose }) {
  React.useEffect(() => {
    if (!modal) return undefined
    const handleKeyDown = event => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [modal, onClose])

  const [dialogTheme, setDialogTheme] = React.useState(() => {
    const appTheme = typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : 'light'
    return appTheme === 'dark' ? 'dark' : 'light'
  })

  if (!modal) return null

  const title = modal.title || modal.label || (modal.url ? decodeURIComponent(modal.url.split('/').at(-1)) : 'Excalidraw Drawing')

  return (
    <div
      className="excalidraw-dialog-backdrop"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
      role="presentation"
    >
      <section
        className="excalidraw-dialog"
        data-canvas-theme={dialogTheme}
        role="dialog"
        aria-modal="true"
        aria-label={`Drawing: ${title}`}
      >
        <header className="excalidraw-dialog-header">
          <div className="excalidraw-dialog-brand">
            <span className="excalidraw-dialog-badge" aria-hidden="true">
              <svg viewBox="0 0 48 48">
                <rect x="3" y="12" width="32" height="23" rx="4" fill="currentColor" opacity="0.15"/>
                <rect x="3" y="12" width="32" height="23" rx="4" stroke="currentColor" strokeWidth="2.5" fill="none"/>
                <path d="M8 28l5-10 5 6 5-8 5 12" stroke="currentColor" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M36 4l8 8-12 12-5 1 1-5z" fill="currentColor"/>
              </svg>
            </span>
            <div className="excalidraw-dialog-title-group">
              <span>Interactive Drawing</span>
              <strong title={title}>{title}</strong>
            </div>
          </div>

          <div className="excalidraw-dialog-actions">
            {/* Quick Theme Toggle Button */}
            <button
              type="button"
              className={`excalidraw-dialog-theme-btn ${dialogTheme === 'dark' ? 'is-dark' : 'is-light'}`}
              onClick={() => setDialogTheme(t => t === 'dark' ? 'light' : 'dark')}
              title={dialogTheme === 'dark' ? 'Switch drawing to Light theme (Shift+Alt+D)' : 'Switch drawing to Dark theme (Shift+Alt+D)'}
              aria-label={dialogTheme === 'dark' ? 'Switch drawing to Light theme' : 'Switch drawing to Dark theme'}
            >
              {dialogTheme === 'dark' ? (
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="5"/>
                  <line x1="12" y1="1" x2="12" y2="3"/>
                  <line x1="12" y1="21" x2="12" y2="23"/>
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                  <line x1="1" y1="12" x2="3" y2="12"/>
                  <line x1="21" y1="12" x2="23" y2="12"/>
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                </svg>
              )}
            </button>

            {modal.url && (
              <a
                href={modal.url}
                target="_blank"
                rel="noreferrer noopener"
                className="excalidraw-dialog-open-tab-btn"
                title="Open original drawing in a new tab"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                </svg>
                <span>Open in new tab ↗</span>
              </a>
            )}
            <button
              type="button"
              className="excalidraw-dialog-close"
              onClick={onClose}
              aria-label="Close drawing dialog"
              title="Close (Esc)"
            >
              ×
            </button>
          </div>
        </header>

        <div className="excalidraw-dialog-stage" data-canvas-theme={dialogTheme}>
          <React.Suspense fallback={<div className="excalidraw-embed-status"><span className="spinner"/><strong>Loading interactive canvas…</strong></div>}>
            <ExcalidrawViewer
              key={`${modal.url}-${dialogTheme}`}
              url={modal.url}
              initialTheme={dialogTheme}
              onFallback={() => {
                window.open(modal.url, '_blank', 'noopener,noreferrer')
                onClose()
              }}
            />
          </React.Suspense>
        </div>
      </section>
    </div>
  )
}

function ClickableImage({ src, alt, ...props }) {
  const [open, setOpen] = React.useState(false)
  const close = React.useCallback(() => setOpen(false), [])
  return (
    <>
      <span className="notes-image-wrap">
        <img
          src={src}
          alt={alt || ''}
          loading="lazy"
          className="notes-clickable-image"
          onClick={() => setOpen(true)}
          title="Click to enlarge"
          {...props}
        />
        <span className="notes-image-zoom-hint" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg>
        </span>
      </span>
      {open && <ImageDialog src={src} alt={alt} onClose={close} />}
    </>
  )
}

function Breadcrumbs({ index, selectedPath, onDirectory, repositories, selectedRepository, onSelectRepository }) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const pickerRef = React.useRef(null)

  React.useEffect(() => {
    const close = event => { if (!pickerRef.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [])

  if (!index || !selectedPath) return null
  const currentRepo = selectedRepository || repositories?.find(r => r.id === index?.id) || index
  const repoName = currentRepo?.name || index.name || index.repo || 'Notes'
  const owner = currentRepo?.owner || index.owner || ''
  const avatarUrl = owner ? `https://github.com/${encodeURIComponent(owner)}.png?size=96` : ''
  const parts = relativeParts(selectedPath, index.root_path)
  const directories = parts.slice(0, -1)

  const visible = (repositories || []).filter(repository =>
    `${repository.name} ${repository.description}`.toLowerCase().includes(query.trim().toLowerCase())
  )
  const choose = repository => {
    onSelectRepository?.(repository.id)
    setOpen(false)
    setQuery('')
  }

  return (
    <nav className="notes-breadcrumbs" aria-label="Note breadcrumb">
      <div className="notes-breadcrumb-repo-picker" ref={pickerRef}>
        <button
          type="button"
          className="notes-breadcrumb-repo"
          onClick={() => setOpen(value => !value)}
          aria-haspopup="menu"
          aria-expanded={open}
          title={`Switch repository (Current: ${repoName})`}
        >
          {avatarUrl && (
            <img className="notes-breadcrumb-avatar-img" src={avatarUrl} alt={owner} loading="lazy" />
          )}
          <span className="notes-breadcrumb-repo-name">{repoName}</span>
          <svg className={`notes-breadcrumb-chevron ${open ? 'expanded' : ''}`} viewBox="0 0 16 16" aria-hidden="true">
            <path d="m4 6 4 4 4-4" />
          </svg>
        </button>
        {open && (
          <>
            <div className="notes-breadcrumb-repo-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
            <div className="notes-repository-menu notes-breadcrumb-repo-menu" role="menu" aria-label="Switch notes repository">
              <strong>Switch learning notes</strong>
            <label>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="10.5" cy="10.5" r="6.5" />
                <path d="m15.5 15.5 5 5" />
              </svg>
              <input
                type="search"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="Search repositories…"
                autoFocus
              />
            </label>
            <div className="notes-repository-menu-list">
              {visible.map(repository => {
                const isActive = repository.id === currentRepo?.id
                return (
                  <button
                    type="button"
                    role="menuitem"
                    className={`notes-repository-item ${isActive ? 'active' : ''}`}
                    key={repository.id}
                    onClick={() => choose(repository)}
                  >
                    <span className="notes-repository-option-visual">
                      <img
                        className="notes-author-avatar-img"
                        src={`https://github.com/${encodeURIComponent(repository.owner)}.png?size=96`}
                        alt={repository.owner}
                        loading="lazy"
                      />
                    </span>
                    <span className="notes-repository-option-copy">
                      <span className="notes-repository-name-row">
                        <b>{repository.name}</b>
                        <span className="notes-repository-option-author">@{repository.owner}</span>
                      </span>
                      <small>{repository.description}</small>
                    </span>
                    {isActive && (
                      <span className="notes-repository-option-check" aria-hidden="true">
                        <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor">
                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 0 1 0 1.414l-8 8a1 1 0 0 1-1.414 0l-4-4a1 1 0 0 1 1.414-1.414L8 12.586l7.293-7.293a1 1 0 0 1 1.414 0z" clipRule="evenodd" />
                        </svg>
                      </span>
                    )}
                  </button>
                )
              })}
              {!visible.length && <p>No repositories match your search.</p>}
            </div>
          </div>
        </>
        )}
      </div>

      <span aria-hidden="true">›</span>
      {directories.map((part, position) => (
        <React.Fragment key={`${position}-${part}`}>
          {position > 0 && <span aria-hidden="true">›</span>}
          <button type="button" onClick={() => onDirectory(directories.slice(0, position + 1))}>{displayName(part)}</button>
        </React.Fragment>
      ))}
      {directories.length > 0 && <span aria-hidden="true">›</span>}
      <strong>{displayName(parts.at(-1).replace(/\.(md|markdown)$/i, ''))}</strong>
    </nav>
  )
}

function TreeFolderIcon() {
  return <svg className="notes-tree-folder-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l2 2h9v9.75a1.75 1.75 0 0 1-1.75 1.75H5.25a1.75 1.75 0 0 1-1.75-1.75V6.5Z"/><path d="M3.5 9h17"/></svg>
}

function TreeNoteIcon() {
  return <svg className="notes-file-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4V20H6V3.5Z"/><path d="M14 3.5V8h4M9 12h6M9 15.5h6"/></svg>
}

function NoteTree({ node, selectedPath, activeDirectories, expanded, onToggle, onSelect, depth = 0 }) {
  const directories = [...node.directories.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  const notes = [...node.notes].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
  return <div className="notes-tree-level" style={{ '--tree-depth': depth }}>
    {directories.map(directory => {
      const isExpanded = expanded[directory.path] === true
      const isActiveDirectory = activeDirectories.has(directory.path)
      return <div className="notes-tree-directory" key={directory.path}>
        <button type="button" className={`notes-tree-folder ${isActiveDirectory ? 'active-ancestor' : ''}`} data-tree-path={directory.path} onClick={() => onToggle(directory.path)} aria-expanded={isExpanded}>
          <svg className={`notes-tree-chevron ${isExpanded ? 'expanded' : ''}`} viewBox="0 0 16 16" aria-hidden="true"><path d="m5 3 5 5-5 5"/></svg>
          <TreeFolderIcon />
          <span className="notes-tree-folder-name" title={directory.name}>{formatDirectoryName(directory.name)}</span>
          <small className="notes-count-badge">{noteCount(directory)}</small>
        </button>
        <div className={`notes-tree-children ${isExpanded ? 'expanded' : ''}`}><div><NoteTree node={directory} selectedPath={selectedPath} activeDirectories={activeDirectories} expanded={expanded} onToggle={onToggle} onSelect={onSelect} depth={depth + 1} /></div></div>
      </div>
    })}
    {notes.map(note => <button type="button" key={note.path} className={`notes-tree-note ${selectedPath === note.path ? 'active' : ''}`} onClick={() => onSelect(note.path)} title={note.path}><TreeNoteIcon/><strong>{note.title}</strong>{selectedPath === note.path && <span className="notes-current-label">Current</span>}</button>)}
  </div>
}

function TopicIcon({ topic }) {
  const value = topic.toLowerCase()
  let type = 'knowledge'
  if (/cloud|aws|azure|gcp/.test(value)) type = 'cloud'
  else if (/\b(ai|ml|llm)\b|artificial|machine.learning|generative|rag|agent/.test(value)) type = 'ai'
  else if (/database|\bdata\b|sql|storage|cache/.test(value)) type = 'database'
  else if (/security|auth|oauth|identity|crypt|jwt/.test(value)) type = 'security'
  else if (/system.design|architecture|architect|design.pattern/.test(value)) type = 'architecture'
  else if (/devops|docker|kubernetes|k8s|ci.?cd|terraform|deployment/.test(value)) type = 'devops'
  else if (/java|spring|jvm/.test(value)) type = 'java'
  else if (/python|django|flask|fastapi/.test(value)) type = 'python'
  else if (/network|http|api|protocol|gateway|microservice/.test(value)) type = 'network'

  return <span className={`notes-topic-icon topic-icon-${type}`} aria-hidden="true"><svg viewBox="0 0 24 24">
    {type === 'cloud' && <path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9a4.5 4.5 0 0 0 1 9Z"/>}
    {type === 'ai' && <><rect x="6" y="6" width="12" height="12" rx="3"/><path d="M9.5 12h5M12 9.5v5M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3"/></>}
    {type === 'database' && <><ellipse cx="12" cy="5.5" rx="7" ry="3"/><path d="M5 5.5v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6M5 11.5v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></>}
    {type === 'security' && <path d="M12 3 19 6v5c0 4.6-2.8 8.1-7 10-4.2-1.9-7-5.4-7-10V6l7-3Zm-3 9 2 2 4-5"/>}
    {type === 'architecture' && <><rect x="3" y="4" width="7" height="6" rx="1"/><rect x="14" y="4" width="7" height="6" rx="1"/><rect x="8.5" y="15" width="7" height="6" rx="1"/><path d="M6.5 10v2h11v-2M12 12v3"/></>}
    {type === 'devops' && <><path d="M8.5 8a4.5 4.5 0 0 1 7.8-1.8L19 9l-2.7 2.8A4.5 4.5 0 0 1 8.5 10M15.5 16a4.5 4.5 0 0 1-7.8 1.8L5 15l2.7-2.8a4.5 4.5 0 0 1 7.8 1.8"/><path d="M19 5v4h-4M5 19v-4h4"/></>}
    {type === 'java' && <><path d="M7 9h10v5a5 5 0 0 1-5 5 5 5 0 0 1-5-5V9Zm10 2h1.5a2.5 2.5 0 0 1 0 5H17M9 5c1.5 1 1.5 2 0 3m4-5c1.5 1 1.5 3 0 4"/></>}
    {type === 'python' && <><path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 4l-4 16"/></>}
    {type === 'network' && <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></>}
    {type === 'knowledge' && <><path d="M4 5.5c2.7-.8 5.3-.3 8 1.5 2.7-1.8 5.3-2.3 8-1.5v13c-2.7-.7-5.3-.2-8 1.5-2.7-1.7-5.3-2.2-8-1.5v-13Z"/><path d="M12 7v13"/></>}
  </svg></span>
}

function LinkBrandIcon({ type }) {
  if (type === 'youtube') return <svg viewBox="0 0 48 48" aria-hidden="true"><rect x="3" y="9" width="42" height="30" rx="10"/><path d="m20 17 12 7-12 7V17Z"/></svg>
  if (type === 'youtube-post') return <svg viewBox="0 0 48 48" aria-hidden="true"><rect x="4" y="7" width="40" height="34" rx="9"/><circle cx="15" cy="18" r="4"/><path d="M23 16h12M23 21h9M12 30h24M12 35h17"/></svg>
  if (type === 'github') return <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 4a20 20 0 0 0-6.3 39c1 .2 1.4-.4 1.4-1v-3.8c-5.7 1.2-6.9-2.4-6.9-2.4-.9-2.4-2.3-3-2.3-3-1.9-1.3.1-1.3.1-1.3 2.1.1 3.2 2.2 3.2 2.2 1.9 3.2 4.9 2.3 6.1 1.8.2-1.4.7-2.3 1.3-2.8-4.6-.5-9.4-2.3-9.4-10A7.8 7.8 0 0 1 13 18a7.3 7.3 0 0 1 .2-5.7s1.6-.5 5.9 2.2a20.3 20.3 0 0 1 10.6 0c4.1-2.7 5.8-2.2 5.8-2.2a7.3 7.3 0 0 1 .2 5.7 7.8 7.8 0 0 1 2.1 5.5c0 7.7-4.8 9.4-9.4 10 .8.7 1.4 2 1.4 3.8V42c0 .6.4 1.2 1.4 1A20 20 0 0 0 24 4Z"/></svg>
  if (type === 'chatgpt') return <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M23.9 6a10 10 0 0 1 17.2 7.4 10 10 0 0 1 1 17.9 10 10 0 0 1-16.2 9.7 10 10 0 0 1-17.2-7.4 10 10 0 0 1-1-17.9A10 10 0 0 1 23.9 6Zm-8.2 10.7 8.2-4.7 8.3 4.8v9.5l-8.3 4.8-8.2-4.8v-9.6Zm8.2-4.7v9.6l8.3 4.7m-16.5-9.6 8.2 4.9-8.2 4.7"/></svg>
  if (type === 'deepseek') return <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M5 27c7-13 20-18 38-12-3 15-14 24-28 22-5-.7-8.3-4-10-10Zm10 10c3-7 8-12 16-15M27 17c1 3 3 5 7 6"/></svg>
  if (type === 'excalidraw') return <svg viewBox="0 0 48 48" aria-hidden="true"><rect x="3" y="12" width="32" height="23" rx="3"/><path d="M8 28l5-10 5 6 5-8 5 12"/><path d="M36 4l8 8-12 12-5 1 1-5z"/><path d="M42 6l2 2"/></svg>
  if (type === 'folder') return <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M5 12h15l5 6h18v22H5V12Z"/><path d="M5 18h38M17 29h14M24 22v14"/></svg>
  if (type === 'note') return <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M8 7h23l9 9v25H8V7Z"/><path d="M30 7v10h10M15 23h18M15 29h18M15 35h12"/></svg>
  return <svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="19"/><path d="M5 24h38M24 5c6 5.3 9 11.7 9 19s-3 13.7-9 19c-6-5.3-9-11.7-9-19s3-13.7 9-19Z"/></svg>
}

function trustedIframeSource(value) {
  try {
    const parsed = new URL(value.replaceAll('&amp;', '&'))
    const hostname = parsed.hostname.toLowerCase()
    const isGoogleMaps = ['www.google.com', 'google.com', 'maps.google.com'].includes(hostname) && parsed.pathname.startsWith('/maps/') && parsed.pathname.includes('/embed')
    return parsed.protocol === 'https:' && isGoogleMaps ? parsed.toString() : ''
  } catch {
    return ''
  }
}

function markdownWithTrustedIframes(content = '') {
  return content.replace(/<iframe\b([^>]*)>(?:\s*<\/iframe>)?/gi, (iframe, attributes) => {
    const sourceMatch = attributes.match(/\bsrc\s*=\s*(["'])(.*?)\1/i)
    if (!sourceMatch) return ''
    const source = sourceMatch[2].replaceAll('&amp;', '&')
    const trustedSource = trustedIframeSource(source)
    if (trustedSource) return `\n\n\`\`\`notes-trusted-iframe\n${trustedSource}\n\`\`\`\n\n`
    return `\n\n> Embedded content is not available in the reader. [Open embedded content](<${source}>)\n\n`
  })
}

function parseSingleCodeSpec(rawSpec, srcPath) {
  let startLine = null
  let endLine = null
  let section = null
  let tabs = []

  const spec = (rawSpec || '').trim()
  if (spec) {
    const rawParts = spec.split(',').map(p => p.trim()).filter(Boolean)
    if (rawParts.length > 1) {
      tabs = rawParts.map(part => {
        const cleanPart = part.replace(/^section:+/i, '').trim()
        const rangeMatch = cleanPart.match(/^(?:(\d+|start))?(?:-(?:(\d+|end))?)?$/i)
        const isNumericRange = rangeMatch && (rangeMatch[1] != null || cleanPart.includes('-'))

        if (isNumericRange) {
          const start = rangeMatch[1]
          const end = cleanPart.includes('-') ? cleanPart.slice(cleanPart.indexOf('-') + 1).trim() : null
          const sLine = start && start.toLowerCase() !== 'start' ? parseInt(start, 10) : (start ? 1 : null)
          const eLine = end && end.toLowerCase() !== 'end' && end !== '' ? parseInt(end, 10) : null
          return {
            type: 'range',
            label: sLine && eLine ? `Lines ${sLine}–${eLine}` : (sLine ? `Line ${sLine}+` : cleanPart),
            startLine: sLine,
            endLine: eLine,
            section: null,
          }
        } else {
          return {
            type: 'section',
            label: cleanPart,
            startLine: null,
            endLine: null,
            section: cleanPart,
          }
        }
      })

      if (tabs.length > 0) {
        section = tabs[0].section
        startLine = tabs[0].startLine
        endLine = tabs[0].endLine
      }
    } else {
      const cleanSpec = spec.replace(/^section:+/i, '').trim()
      const rangeMatch = cleanSpec.match(/^(?:(\d+|start))?(?:-(?:(\d+|end))?)?$/i)
      const isNumericRange = rangeMatch && (rangeMatch[1] != null || cleanSpec.includes('-'))

      if (isNumericRange) {
        const start = rangeMatch[1]
        const end = cleanSpec.includes('-') ? cleanSpec.slice(cleanSpec.indexOf('-') + 1).trim() : null

        if (start && start.toLowerCase() !== 'start') {
          startLine = parseInt(start, 10)
        } else if (start && start.toLowerCase() === 'start') {
          startLine = 1
        }

        if (end && end.toLowerCase() !== 'end' && end !== '') {
          endLine = parseInt(end, 10)
        }
      } else {
        section = cleanSpec
      }
    }
  }

  const cleanSrc = srcPath.trim()
  const filename = (cleanSrc.split('/').at(-1) || 'file').split('?')[0].split('#')[0]

  return {
    src: cleanSrc,
    filename,
    startLine,
    endLine,
    section,
    tabs: tabs.length > 1 ? tabs : undefined,
  }
}

function markdownWithCodeEmbeds(content = '') {
  if (!content || typeof content !== 'string') return content || ''

  // Split by code blocks (```...```) and inline code (`...`) to preserve verbatim code
  const tokenRegex = /(```[\s\S]*?```|`[^`\n]+`)/g
  const parts = content.split(tokenRegex)

  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) continue // Skip code segments

    let text = parts[i]

    // Matches single or grouped code embeds, e.g.:
    // @[code:section-57,section-57-console](intervals57.py), [code:section-58](intervals58.py)
    const clusterRegex = /(?:@?\[code(?::[^\]]*)?\]\([^)]+\)[\s,]*)+/gi

    text = text.replace(clusterRegex, (clusterMatch) => {
      const itemRegex = /@?\[code(?::([^\]]+))?\]\(([^)]+)\)/gi
      const fileItems = []
      let item

      while ((item = itemRegex.exec(clusterMatch)) !== null) {
        fileItems.push(parseSingleCodeSpec(item[1], item[2]))
      }

      if (fileItems.length === 0) return clusterMatch

      let data
      if (fileItems.length === 1) {
        const single = fileItems[0]
        data = {
          src: single.src,
          startLine: single.startLine,
          endLine: single.endLine,
          section: single.section,
          tabs: single.tabs,
        }
      } else {
        data = {
          files: fileItems,
        }
      }

      return `\n\n\`\`\`notes-code-embed\n${JSON.stringify(data)}\n\`\`\`\n\n`
    })

    parts[i] = text
  }

  return parts.join('')
}

function markdownWithMath(content = '') {
  if (!content || typeof content !== 'string') return content || ''

  // Split by code blocks (```...```) and inline code (`...`) to preserve verbatim code
  const tokenRegex = /(```[\s\S]*?```|`[^`\n]+`)/g
  const parts = content.split(tokenRegex)

  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) continue // Skip code segments

    let text = parts[i]

    // 1. Transform block math: $$...$$ into ```notes-math-block
    text = text.replace(/\$\$\s*\n?([\s\S]*?)\n?\s*\$\$/g, (match, mathContent) => {
      const trimmed = mathContent.trim()
      if (!trimmed) return match
      return `\n\n\`\`\`notes-math-block\n${trimmed}\n\`\`\`\n\n`
    })

    // 2. Transform inline math: $...$
    // Matches $math$ where math doesn't start or end with space and isn't preceded by backslash
    text = text.replace(/(^|[^\\])\$([^\s\$](?:[^\$]*?[^\s\$])?)\$/g, (match, prefix, mathContent) => {
      // Ignore if it's plain currency like $100 or $5.99
      if (/^\d+(?:\.\d+)?$/.test(mathContent)) {
        return match
      }
      return `${prefix}\`notes-math-inline:${encodeURIComponent(mathContent)}\``
    })

    parts[i] = text
  }

  return parts.join('')
}

function MathInline({ math }) {
  const html = React.useMemo(() => {
    try {
      return katex.renderToString(math, {
        displayMode: false,
        throwOnError: false,
        output: 'html',
      })
    } catch {
      return math
    }
  }, [math])

  return (
    <span
      className="notes-math-inline"
      dangerouslySetInnerHTML={{ __html: html }}
      title={`LaTeX: ${math}`}
    />
  )
}

function MathBlock({ math }) {
  const [copied, setCopied] = React.useState(false)

  const html = React.useMemo(() => {
    try {
      return katex.renderToString(math, {
        displayMode: true,
        throwOnError: false,
        output: 'html',
      })
    } catch {
      return math
    }
  }, [math])

  const copyFormula = async () => {
    try {
      await navigator.clipboard.writeText(math)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {}
  }

  return (
    <div className="notes-math-block-card">
      <div className="notes-math-block-header">
        <span className="notes-math-badge">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M4 19L10 5l4 14 6-10"/>
          </svg>
          <span>LaTeX Formula</span>
        </span>
        <button
          type="button"
          className="notes-math-copy-btn"
          onClick={copyFormula}
          title="Copy LaTeX formula"
          aria-label="Copy formula"
        >
          {copied ? 'Copied ✓' : 'Copy LaTeX'}
        </button>
      </div>
      <div
        className="notes-math-block-content"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}

function extractReferenceGroups(sectionText, note, index) {
  const groups = []
  let currentGroup = { name: 'General', items: [] }
  const seenUrls = new Set()
  const lines = sectionText.split(/\r?\n/)

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    // Check if this line is a sub-group header (e.g. "### Main", "**Drawing**", "main:", "drawing", "videos")
    const isGroupHeader = /^(?:#{3,5}\s*|\*{2}|_{2})?([a-zA-Z0-9_\s&-]+?)(?:\*{2}|_{2})?:?$/i.exec(line)
    const isBulletOrUrl = /^[-*+]|\d+\.|^https?:\/\//i.test(line)

    if (isGroupHeader && !isBulletOrUrl && isGroupHeader[1].trim().length < 40) {
      const rawName = isGroupHeader[1].trim()
      const formattedName = rawName.charAt(0).toUpperCase() + rawName.slice(1)
      if (currentGroup.items.length > 0) {
        groups.push(currentGroup)
      }
      currentGroup = { name: formattedName, items: [] }
      continue
    }

    // 1. Check for markdown link [Label](url) with optional trailing "| Label" or text
    const mdLinkMatch = /^\s*(?:[-*+]|\d+\.)?\s*\[([^\]]+)\]\((https?:\/\/[^\s)]+|\.?\.?\/[^\s)]+)\)(?:\s*\|\s*(.+))?/i.exec(line)
    if (mdLinkMatch) {
      const label = (mdLinkMatch[3]?.trim() || mdLinkMatch[1]?.trim() || '').replace(/^["']|["']$/g, '')
      const href = mdLinkMatch[2].trim()
      if (!seenUrls.has(href)) {
        seenUrls.add(href)
        const descriptor = linkDescriptor(href, note, index, label)
        currentGroup.items.push({
          title: label || descriptor.title || href,
          url: descriptor.url || href,
          hostname: descriptor.hostname || '',
          descriptor,
        })
      }
      continue
    }

    // 2. Check for URL with pipe "| Label" (e.g., "- https://... | \"Six Little Lines of Fail\"" or "- https://excalidraw.com/... | naive sol")
    const pipeUrlMatch = /^\s*(?:[-*+]|\d+\.)?\s*(https?:\/\/[^\s|]+)\s*\|\s*(.+)$/i.exec(line)
    if (pipeUrlMatch) {
      const rawUrl = pipeUrlMatch[1].trim()
      const label = pipeUrlMatch[2].trim().replace(/^["']|["']$/g, '')
      if (!seenUrls.has(rawUrl)) {
        seenUrls.add(rawUrl)
        const descriptor = linkDescriptor(rawUrl, note, index, label)
        currentGroup.items.push({
          title: label || descriptor.title || rawUrl,
          url: descriptor.url || rawUrl,
          hostname: descriptor.hostname || '',
          descriptor,
        })
      }
      continue
    }

    // 3. Check for standalone URL (e.g., "- https://..." or "1. https://...")
    const plainUrlMatch = /^\s*(?:[-*+]|\d+\.)?\s*(https?:\/\/[^\s]+)$/i.exec(line)
    if (plainUrlMatch) {
      const rawUrl = plainUrlMatch[1].trim().replace(/[.,;:)\]]+$/, '')
      if (!seenUrls.has(rawUrl)) {
        seenUrls.add(rawUrl)
        const descriptor = linkDescriptor(rawUrl, note, index)
        currentGroup.items.push({
          title: descriptor.title || descriptor.hostname || rawUrl,
          url: descriptor.url || rawUrl,
          hostname: descriptor.hostname || '',
          descriptor,
        })
      }
      continue
    }

    // 4. Fallback: extract any markdown links or bare URLs in the line
    const fallbackMdLinks = [...line.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\.?\.?\/[^\s)]+)\)/g)]
    for (const match of fallbackMdLinks) {
      const label = match[1].trim()
      const href = match[2].trim()
      if (!seenUrls.has(href)) {
        seenUrls.add(href)
        const descriptor = linkDescriptor(href, note, index, label)
        currentGroup.items.push({
          title: label || descriptor.title || href,
          url: descriptor.url || href,
          hostname: descriptor.hostname || '',
          descriptor,
        })
      }
    }

    const fallbackBareUrls = [...line.matchAll(/(https?:\/\/[^\s<>)"']+)/g)]
    for (const match of fallbackBareUrls) {
      const rawUrl = match[1].trim().replace(/[.,;:)\]]+$/, '')
      if (!seenUrls.has(rawUrl)) {
        seenUrls.add(rawUrl)
        const descriptor = linkDescriptor(rawUrl, note, index)
        currentGroup.items.push({
          title: descriptor.title || descriptor.hostname || rawUrl,
          url: descriptor.url || rawUrl,
          hostname: descriptor.hostname || '',
          descriptor,
        })
      }
    }
  }

  if (currentGroup.items.length > 0) {
    groups.push(currentGroup)
  }

  return groups
}

function markdownWithReferences(content = '', note, index) {
  if (!content) return ''
  const refHeaderRegex = /(?:^|\n)(#{1,4}\s*(?:📚|🔗)?\s*(?:references?|reference\s+links?|references?\s*(?:&|and)\s*resources?|sources?|further\s+reading)\b[^\n]*)\n([\s\S]*?)(?=(?:\n#{1,4}\s+[^\n]+)|$)/gi

  return content.replace(refHeaderRegex, (fullMatch, headingLine, sectionBody) => {
    const titleMatch = headingLine.replace(/^#+\s*/, '').trim()
    const titleSlug = slug(cleanHeading(titleMatch)) || 'references'
    const groups = extractReferenceGroups(sectionBody, note, index)
    if (groups.length === 0) {
      return fullMatch
    }
    const payload = JSON.stringify({
      title: titleMatch,
      id: titleSlug,
      groups,
    })
    return `\n\n\`\`\`notes-references-section\n${payload}\n\`\`\`\n\n`
  })
}

function TrustedIframeEmbed({ source }) {
  const trustedSource = trustedIframeSource(source)
  if (!trustedSource) return null
  return <figure className="notes-trusted-embed"><iframe src={trustedSource} title="Embedded Google Map" loading="lazy" referrerPolicy="strict-origin-when-cross-origin" allowFullScreen/><figcaption><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-6.1 7-12a7 7 0 1 0-14 0c0 5.9 7 12 7 12Z"/><circle cx="12" cy="9" r="2.5"/></svg>Google Maps</figcaption></figure>
}

function staticReaderDocument(html, sourceUrl) {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  parsed.querySelectorAll('script, iframe, frame, object, embed, form, input, button, textarea, select, template, noscript, meta, base').forEach(element => element.remove())
  const content = parsed.querySelector('main, article, [role="main"]') || parsed.body
  if (!content) throw new Error('This page did not contain readable HTML content.')

  content.querySelectorAll('*').forEach(element => {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name) || attribute.name === 'srcdoc') element.removeAttribute(attribute.name)
    }
    for (const attributeName of ['href', 'src', 'poster']) {
      const value = element.getAttribute(attributeName)
      if (!value) continue
      try {
        const absolute = new URL(value, sourceUrl)
        if (!['http:', 'https:'].includes(absolute.protocol)) element.removeAttribute(attributeName)
        else element.setAttribute(attributeName, absolute.toString())
      } catch { element.removeAttribute(attributeName) }
    }
    const srcset = element.getAttribute('srcset')
    if (srcset) {
      const rewritten = srcset.split(',').map(candidate => {
        const [value, ...descriptor] = candidate.trim().split(/\s+/)
        try { return [new URL(value, sourceUrl).toString(), ...descriptor].join(' ') } catch { return '' }
      }).filter(Boolean).join(', ')
      if (rewritten) element.setAttribute('srcset', rewritten)
      else element.removeAttribute('srcset')
    }
  })
  content.querySelectorAll('a[href]').forEach(link => { link.target = '_blank'; link.rel = 'noreferrer noopener' })

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    :root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.65}
    *{box-sizing:border-box}body{max-width:900px;margin:0 auto;padding:clamp(20px,5vw,54px);color:#253047;background:#fff;overflow-wrap:anywhere}
    img,video,picture,svg{max-width:100%;height:auto}pre{max-width:100%;padding:16px;overflow:auto;background:#111827;color:#e5e7eb;border-radius:10px}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
    a{color:#4f46e5}h1,h2,h3{line-height:1.25;color:#111827}table{display:block;max-width:100%;overflow:auto;border-collapse:collapse}th,td{padding:8px;border:1px solid #dbe2ea}
    nav,aside[aria-label*="breadcrumb" i]{display:none!important}@media(prefers-color-scheme:dark){body{color:#cbd5e1;background:#0f172a}h1,h2,h3{color:#f8fafc}a{color:#93c5fd}}
  </style></head><body>${content.outerHTML}</body></html>`
}

function ExternalReaderPreview({ preview }) {
  const [documentHtml, setDocumentHtml] = React.useState('')
  const [error, setError] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [showLiveWebsite, setShowLiveWebsite] = React.useState(false)

  React.useEffect(() => {
    const controller = new AbortController()
    setDocumentHtml(''); setError(''); setLoading(true); setShowLiveWebsite(false)
    fetch(preview.url, { mode: 'cors', credentials: 'omit', headers: { Accept: 'text/html' }, signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`The site returned HTTP ${response.status}.`)
        const contentType = response.headers.get('content-type') || ''
        if (!contentType.includes('text/html')) throw new Error('This resource is not an HTML page.')
        const html = await response.text()
        if (html.length > 3_000_000) throw new Error('This page is too large for the reader preview.')
        return staticReaderDocument(html, preview.url)
      })
      .then(value => setDocumentHtml(value))
      .catch(fetchError => { if (fetchError.name !== 'AbortError') setError(fetchError.message || 'The site blocked the reader preview.') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [preview.url])

  if (showLiveWebsite) return <div className="notes-live-website-preview"><div className="notes-live-preview-bar"><span><strong>Live website</strong><small>The website may still refuse browser embedding.</small></span><button type="button" onClick={() => setShowLiveWebsite(false)}>Reader view</button></div><iframe className="notes-external-frame" src={preview.url} title={`Live website preview: ${preview.title || preview.hostname}`} loading="eager" referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-presentation allow-same-origin allow-scripts"/></div>
  if (loading) return <div className="notes-external-reader-status"><span className="spinner"/><strong>Preparing reader preview…</strong><small>Loading public page content without running its scripts.</small></div>
  if (error) return <div className="notes-external-reader-status is-blocked"><span className="notes-reader-blocked-icon">↗</span><strong>Reader preview blocked</strong><p>{error}</p><small>A live preview may work if the website permits iframe embedding.</small><button type="button" className="btn btn-primary notes-try-live-button" onClick={() => setShowLiveWebsite(true)}>Try live website</button></div>
  return <iframe className="notes-external-frame" srcDoc={documentHtml} title={`Reader preview: ${preview.title || preview.hostname}`} sandbox="allow-popups allow-popups-to-escape-sandbox" />
}

function FolderPreviewTree({ node, landingPath, selectedPath, onSelect, expanded, onToggle, depth = 0 }) {
  const directories = [...node.directories.values()].sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }))
  const notes = [...node.notes].sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }))

  return (
    <div className="notes-tree-level" style={{ '--tree-depth': depth }}>
      {directories.map(directory => {
        const isExpanded = expanded ? expanded[directory.path] !== false : true
        return (
          <div className="notes-tree-directory" key={directory.path}>
            <button
              type="button"
              className="notes-tree-folder"
              data-tree-path={directory.path}
              onClick={() => onToggle?.(directory.path)}
              aria-expanded={isExpanded}
            >
              <svg className={`notes-tree-chevron ${isExpanded ? 'expanded' : ''}`} viewBox="0 0 16 16" aria-hidden="true">
                <path d="m5 3 5 5-5 5" />
              </svg>
              <TreeFolderIcon />
              <span className="notes-tree-folder-name" title={directory.name}>
                {formatDirectoryName(directory.name)}
              </span>
              <small className="notes-count-badge">{noteCount(directory)}</small>
            </button>
            <div className={`notes-tree-children ${isExpanded ? 'expanded' : ''}`}>
              <div>
                <FolderPreviewTree
                  node={directory}
                  landingPath={landingPath}
                  selectedPath={selectedPath}
                  onSelect={onSelect}
                  expanded={expanded}
                  onToggle={onToggle}
                  depth={depth + 1}
                />
              </div>
            </div>
          </div>
        )
      })}
      {notes.map(folderNote => {
        const isSelected = folderNote.path === selectedPath
        const isLanding = folderNote.path === landingPath
        return (
          <button
            type="button"
            key={folderNote.path}
            className={`notes-tree-note ${isSelected ? 'active' : ''}`}
            onClick={() => onSelect(folderNote.path)}
            title={folderNote.path}
          >
            <TreeNoteIcon />
            <strong className="notes-tree-note-title">{folderNote.title}</strong>
            {isLanding && !isSelected && <span className="notes-landing-pill">Landing</span>}
            {isSelected && <span className="notes-current-label">Current</span>}
          </button>
        )
      })}
    </div>
  )
}

function PreviewOnThisPage({ note, headings, headingIdPrefix, scrollContainerRef }) {
  const [query, setQuery] = React.useState('')
  const activeId = useHeadingScrollspy(headings, scrollContainerRef, headingIdPrefix)
  React.useEffect(() => setQuery(''), [note?.path])
  const normalizedQuery = query.trim().toLowerCase()
  const visibleHeadingTree = filterHeadingTree(headingTree(headings), normalizedQuery)
  const selectHeading = heading => document.getElementById(`${headingIdPrefix}${heading.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return <aside className="notes-preview-outline" aria-label="On this page">
    <div className="notes-preview-outline-header"><span>On this page</span><strong>{note?.title || 'Note outline'}</strong></div>
    <label className="notes-outline-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a heading…" aria-label="Search headings in this preview"/></label>
    {visibleHeadingTree.length ? <nav><OutlineHeadingTree nodes={visibleHeadingTree} activeId={activeId} onSelectHeading={selectHeading}/></nav> : <p>{headings.length ? 'No headings match your search.' : 'No headings in this note.'}</p>}
  </aside>
}

function PreviewMarkdownLayout({ note, headings, targetHash, index, onOpenLink, onOpenCodeModal }) {
  const headingIdPrefix = 'notes-link-preview-heading-'
  const contentContainerRef = React.useRef(null)

  React.useEffect(() => {
    if (!targetHash) {
      contentContainerRef.current?.scrollTo({ top: 0 })
      return undefined
    }

    const clean = decodeURIComponent(targetHash).replace(/^#/, '').trim()
    const match = findTargetHeading(headings, clean)
    const targetId = match ? `${headingIdPrefix}${match.id}` : `${headingIdPrefix}${clean}`

    const attemptScroll = (retries = 8) => {
      const el = document.getElementById(targetId) ||
                 document.getElementById(`${headingIdPrefix}${slug(clean)}`) ||
                 document.getElementById(clean) ||
                 contentContainerRef.current?.querySelector(`[id*="${clean}"]`)

      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        el.classList.add('notes-target-heading-highlight')
        setTimeout(() => el.classList.remove('notes-target-heading-highlight'), 2400)
      } else if (retries > 0) {
        setTimeout(() => attemptScroll(retries - 1), 60)
      }
    }

    const timer = setTimeout(() => attemptScroll(8), 60)
    return () => clearTimeout(timer)
  }, [note?.path, targetHash, headings])

  return <div className="notes-preview-markdown-layout">
    <div className="notes-preview-markdown-content" ref={contentContainerRef}>
      <article className="markdown-body notes-link-note-preview">
        <MarkdownContent note={note} headings={headings} headingIdPrefix={headingIdPrefix} index={index} onOpenLink={onOpenLink} onOpenCodeModal={onOpenCodeModal}/>
      </article>
    </div>
    <PreviewOnThisPage note={note} headings={headings} headingIdPrefix={headingIdPrefix} scrollContainerRef={contentContainerRef}/>
  </div>
}

function LinkPreviewDrawer({ preview, repositoryId, source, index, onClose, onNavigate, onPreviewLink, canGoBack, onBack }) {
  const [previewNote, setPreviewNote] = React.useState(null)
  const [folderSelectedPath, setFolderSelectedPath] = React.useState('')
  const [folderExpanded, setFolderExpanded] = React.useState({})
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')

  const toggleFolder = path => setFolderExpanded(current => ({ ...current, [path]: current[path] === false ? true : false }))

  React.useEffect(() => {
    if (!preview) return undefined
    const close = event => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [preview, onClose])

  React.useEffect(() => setFolderSelectedPath(preview?.type === 'folder' ? preview.path : ''), [preview])

  React.useEffect(() => {
    setPreviewNote(null); setError('')
    const contentPath = preview?.type === 'note' ? preview.path : preview?.type === 'folder' ? (folderSelectedPath || preview.path) : ''
    if (!contentPath) { setLoading(false); return undefined }
    let active = true
    setLoading(true)
    getNoteContent(repositoryId, contentPath, source).then(data => active && setPreviewNote(data)).catch(fetchError => active && setError(fetchError.message || 'Unable to preview this note.')).finally(() => active && setLoading(false))
    return () => { active = false }
  }, [preview, repositoryId, source, folderSelectedPath])

  if (!preview) return null
  const labels = { note: 'Linked learning note', folder: 'Linked notes folder', youtube: 'YouTube video', 'youtube-post': 'YouTube post', github: 'GitHub resource', chatgpt: 'ChatGPT link', deepseek: 'DeepSeek link', excalidraw: 'Excalidraw drawing', external: 'External resource' }
  const description = ['note', 'folder'].includes(preview.type)
    ? (preview.folderPath || preview.path)
    : (() => { try { const value = new URL(preview.url); return `${value.hostname}${decodeURIComponent(value.pathname)}` } catch { return preview.url } })()
  const previewHeadings = previewNote ? extractHeadings(previewNote.content) : []
  const pool = index?.allNotes || index?.notes || []
  const folderPrefix = preview.type === 'folder' && preview.folderPath ? `${preview.folderPath.toLowerCase().replace(/\/$/, '')}/` : ''
  const folderNotes = preview.type === 'folder' ? pool.filter(item => item.path.toLowerCase().startsWith(folderPrefix)) : []
  const folderTree = preview.type === 'folder' && folderNotes.length > 0 ? buildTree(folderNotes, preview.folderPath) : null

  return <div className="notes-link-drawer-layer" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <aside className={`notes-link-drawer link-type-${preview.type}`} role="dialog" aria-modal="true" aria-labelledby="notes-link-preview-title">
      <header className="notes-link-drawer-header">
        <button type="button" className="notes-link-back" onClick={onBack} disabled={!canGoBack} aria-label="Back to previous preview" title="Back to previous preview">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5-7 7 7 7M8 12h10"/></svg>
        </button>
        <div className="notes-link-drawer-title">
          <span className="notes-link-title-icon"><LinkBrandIcon type={preview.type}/></span>
          <strong id="notes-link-preview-title">{preview.title || preview.hostname || 'Link preview'}</strong>
          <small title={description}>{description}</small>
        </div>
        <button type="button" className="notes-link-close" onClick={onClose} aria-label="Close link preview">×</button>
      </header>
      <div className="notes-link-drawer-body">
        {preview.type === 'note' && (loading ? <div className="note-reader-status"><span className="spinner" /> Loading linked note…</div> : error ? <DismissibleError message={error}/> : previewNote ? <PreviewMarkdownLayout note={previewNote} headings={previewHeadings} targetHash={preview.hash} index={index} onOpenLink={onPreviewLink}/> : null)}
        {preview.type === 'folder' && (
          folderNotes.length > 0 ? (
            <div className="notes-folder-master-detail">
              <aside className="notes-folder-master">
                <div className="notes-folder-master-tree">
                  {folderTree && <FolderPreviewTree node={folderTree} landingPath={preview.path} selectedPath={folderSelectedPath} onSelect={setFolderSelectedPath} expanded={folderExpanded} onToggle={toggleFolder}/>}
                </div>
              </aside>
              <section className="notes-folder-detail">
                <div className="notes-folder-detail-content">
                  {loading ? <div className="note-reader-status"><span className="spinner" /> Loading note…</div> : error ? <DismissibleError message={error}/> : previewNote ? <PreviewMarkdownLayout note={previewNote} headings={previewHeadings} targetHash={folderSelectedPath === preview.path ? preview.hash : ''} index={index} onOpenLink={onPreviewLink}/> : <div className="note-reader-status">Select a note from the folder tree.</div>}
                </div>
              </section>
            </div>
          ) : (
            loading ? <div className="note-reader-status"><span className="spinner" /> Loading folder preview…</div> : error ? <DismissibleError message={error}/> : previewNote ? <PreviewMarkdownLayout note={previewNote} headings={previewHeadings} targetHash={preview.hash} index={index} onOpenLink={onPreviewLink}/> : null
          )
        )}
        {preview.type === 'youtube-post' && <div className="notes-youtube-post-preview"><span><LinkBrandIcon type="youtube-post"/></span><h2>Community post</h2><p>YouTube does not provide a video-player embed for Community posts. Open the post on YouTube to view its text, images, poll, and discussion.</p></div>}
        {preview.type === 'youtube' && <div className="notes-external-preview"><iframe key={preview.url} className="notes-external-frame" src={youtubeEmbedUrl(preview.videoId)} title={`${labels.youtube}: ${preview.title || preview.hostname}`} loading="eager" referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-presentation allow-same-origin allow-scripts" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen/></div>}
        {preview.type === 'excalidraw' && <div className="notes-excalidraw-preview"><React.Suspense fallback={<div className="excalidraw-embed-status"><span className="spinner"/><strong>Preparing canvas…</strong></div>}><ExcalidrawViewer url={preview.url} onFallback={() => { window.open(preview.url, '_blank', 'noopener,noreferrer'); onClose() }}/></React.Suspense></div>}
        {!['note', 'folder', 'youtube', 'youtube-post', 'excalidraw'].includes(preview.type) && <div className="notes-external-preview"><ExternalReaderPreview preview={preview}/></div>}
      </div>
      <footer className="notes-link-drawer-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>Close preview</button>
        {preview.type === 'note' && <button type="button" className="btn btn-primary" onClick={() => onNavigate(preview.path, preview.hash)}>Jump to note</button>}
        {preview.type === 'folder' && <button type="button" className="btn btn-primary" onClick={() => onNavigate(folderSelectedPath || preview.path, (folderSelectedPath === preview.path || !folderSelectedPath) ? preview.hash : '')}>Jump to note</button>}
        {preview.url && <a className="btn btn-secondary notes-link-open" href={preview.url} target="_blank" rel="noreferrer">Open in new tab ↗</a>}
      </footer>
    </aside>
  </div>
}

function toggleH2Section(headingElement) {
  if (!headingElement) return
  const isCollapsed = headingElement.classList.toggle('is-collapsed')
  headingElement.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true')

  let nextEl = headingElement.nextElementSibling
  while (nextEl) {
    const tagName = nextEl.tagName?.toLowerCase()
    if (
      tagName === 'h1' ||
      tagName === 'h2' ||
      nextEl.classList?.contains('notes-title-navigation') ||
      nextEl.classList?.contains('notes-references-card') ||
      nextEl.id === 'references'
    ) {
      break
    }
    if (isCollapsed) {
      nextEl.setAttribute('data-h2-hidden', 'true')
    } else {
      nextEl.removeAttribute('data-h2-hidden')
    }
    nextEl = nextEl.nextElementSibling
  }
}

function uncollapseTargetIfNeeded(el) {
  if (!el) return
  if (el.classList?.contains('notes-collapsible-h2') && el.classList?.contains('is-collapsed')) {
    toggleH2Section(el)
    return
  }
  let prev = el.previousElementSibling
  while (prev) {
    if (prev.classList?.contains('notes-collapsible-h2')) {
      if (prev.classList?.contains('is-collapsed')) {
        toggleH2Section(prev)
      }
      break
    }
    if (prev.tagName?.toLowerCase() === 'h1') break
    prev = prev.previousElementSibling
  }
}

function getNodeText(node) {
  if (!node) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(getNodeText).join('')
  if (node?.props?.children) return getNodeText(node.props.children)
  return ''
}

const MarkdownContent = React.memo(function MarkdownContent({ note, headings = [], headingIdPrefix = '', index, onOpenLink, onOpenCodeModal, titleNavigation }) {
  let titleNavigationRendered = false
  const headingCounts = React.useRef({})
  headingCounts.current = {}

  const headingsByBase = React.useMemo(() => {
    const map = new Map()
    for (const h of headings) {
      const base = slug(h.title)
      if (!map.has(base)) map.set(base, [])
      map.get(base).push(h)
    }
    return map
  }, [headings])

  const resolveHeadingId = (children) => {
    const text = getNodeText(children)
    const title = cleanHeading(text)
    const base = slug(title)

    headingCounts.current[base] = (headingCounts.current[base] || 0) + 1
    const occurrence = headingCounts.current[base]

    const matches = headingsByBase.get(base)
    if (matches && matches[occurrence - 1]) {
      return `${headingIdPrefix}${matches[occurrence - 1].id}`
    }

    const fallbackId = occurrence === 1 ? base : `${base}-${occurrence}`
    return `${headingIdPrefix}${fallbackId}`
  }

  const heading = level => ({ children, ...props }) => {
    const Tag = `h${level}`
    const id = resolveHeadingId(children)
    if (level === 1 && titleNavigation && !titleNavigationRendered) {
      titleNavigationRendered = true
      const { previousNote, nextNote, onNavigate } = titleNavigation
      const previousTitle = previousNote?.title || (previousNote ? displayName(previousNote.path.split('/').at(-1)) : '')
      const nextTitle = nextNote?.title || (nextNote ? displayName(nextNote.path.split('/').at(-1)) : '')
      return <div className="notes-title-navigation">
        <button type="button" disabled={!previousNote} onClick={() => previousNote && onNavigate(previousNote.path)} title={previousNote ? `Previous: ${previousTitle}` : 'No previous note'} aria-label={previousNote ? `Previous note: ${previousTitle}` : 'No previous note'}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="notes-title-chevron-previous" x1="4" y1="4" x2="20" y2="20" gradientUnits="userSpaceOnUse"><stop stopColor="var(--notes-accent)"/><stop offset="1" stopColor="var(--notes-accent-2)"/></linearGradient></defs><path d="m14 6-6 6 6 6" stroke="url(#notes-title-chevron-previous)"/></svg>
        </button>
        <Tag id={id} {...props}>{children}</Tag>
        <button type="button" disabled={!nextNote} onClick={() => nextNote && onNavigate(nextNote.path)} title={nextNote ? `Next: ${nextTitle}` : 'No next note'} aria-label={nextNote ? `Next note: ${nextTitle}` : 'No next note'}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="notes-title-chevron-next" x1="4" y1="4" x2="20" y2="20" gradientUnits="userSpaceOnUse"><stop stopColor="var(--notes-accent)"/><stop offset="1" stopColor="var(--notes-accent-2)"/></linearGradient></defs><path d="m10 6 6 6-6 6" stroke="url(#notes-title-chevron-next)"/></svg>
        </button>
      </div>
    }
    if (level === 2) {
      return (
        <h2
          id={id}
          className="notes-collapsible-h2"
          onClick={(e) => {
            if (e.target.closest('a')) return
            toggleH2Section(e.currentTarget)
          }}
          tabIndex={0}
          role="button"
          aria-expanded="true"
          title="Click to collapse or expand section"
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              toggleH2Section(e.currentTarget)
            }
          }}
          {...props}
        >
          <span className="notes-h2-content-text">{children}</span>
          <span className="notes-h2-toggle-chevron" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 9 6 6 6-6"/>
            </svg>
          </span>
        </h2>
      )
    }
    return <Tag id={id} {...props}>{children}</Tag>
  }
  const components = {
    a: ({ href, children, className, ...props }) => {
      const resolved = relativeUrl(href, note.raw_url)
      if (href?.startsWith('#')) {
        return <a href={href} className={className} onClick={event => {
          event.preventDefault()
          const clean = decodeURIComponent(href).replace(/^#/, '').trim()
          const match = findTargetHeading(headings, clean)
          const targetId = match ? `${headingIdPrefix}${match.id}` : `${headingIdPrefix}${clean}`
          const el = document.getElementById(targetId) || document.getElementById(clean) || document.getElementById(slug(clean)) || document.querySelector(`[id*="${clean}"]`)
          if (el) {
            uncollapseTargetIfNeeded(el)
            el.scrollIntoView({ behavior: 'smooth', block: 'start' })
            el.classList.add('notes-target-heading-highlight')
            setTimeout(() => el.classList.remove('notes-target-heading-highlight'), 2400)
          }
        }} {...props}>{children}</a>
      }
      const label = React.Children.toArray(children).join('')
      const descriptor = linkDescriptor(href, note, index, label)

      const isLocalExcalidrawFile = descriptor.type === 'excalidraw' && (
        (href && /\.excalidraw(\?.*)?(#.*)?$/i.test(href)) ||
        (resolved && /\.excalidraw(\?.*)?(#.*)?$/i.test(resolved))
      )
      if (isLocalExcalidrawFile) {
        return (
          <React.Suspense fallback={<div className="notes-excalidraw-fallback-link"><span className="spinner"/> Loading drawing…</div>}>
            <ExcalidrawThumbnail
              url={resolved}
              descriptor={descriptor}
              label={label}
              onOpen={onOpenLink}
            />
          </React.Suspense>
        )
      }

      const linkClassName = ['notes-rich-link', `link-type-${descriptor.type}`, className].filter(Boolean).join(' ')
      return <a href={resolved} className={linkClassName} onClick={event => { event.preventDefault(); onOpenLink?.(descriptor) }} {...props}><span className="notes-rich-link-icon"><LinkBrandIcon type={descriptor.type}/></span>{children}</a>
    },
    img: ({ src, alt, ...props }) => {
      const resolved = relativeUrl(src, note.raw_url)
      const isExcalidraw = (
        (src && /\.excalidraw(\?.*)?(#.*)?$/i.test(src)) ||
        (resolved && /\.excalidraw(\?.*)?(#.*)?$/i.test(resolved))
      )
      if (isExcalidraw) {
        const descriptor = linkDescriptor(src, note, index, alt)
        return (
          <React.Suspense fallback={<div className="notes-excalidraw-fallback-link"><span className="spinner"/> Loading drawing…</div>}>
            <ExcalidrawThumbnail
              url={resolved}
              descriptor={descriptor}
              label={alt}
              onOpen={onOpenLink}
            />
          </React.Suspense>
        )
      }
      return <ClickableImage src={resolved} alt={alt} {...props} />
    },
    table: ({ children, ...props }) => <ClickableTable {...props}>{children}</ClickableTable>,
    h1: heading(1), h2: heading(2), h3: heading(3), h4: heading(4), h5: heading(5), h6: heading(6),
    code: ({ inline, className, children, ...props }) => {
      const text = String(children || '')
      if (text.startsWith('notes-math-inline:')) {
        const mathContent = decodeURIComponent(text.slice('notes-math-inline:'.length))
        return <MathInline math={mathContent} />
      }
      return <code className={className} {...props}>{children}</code>
    },
    pre: ({ children, ...props }) => {
      const codeElement = React.Children.count(children) === 1 ? React.Children.only(children) : null
      const language = /language-([^\s]+)/.exec(codeElement?.props?.className || '')?.[1]?.toLowerCase()
      if (language === 'notes-code-embed') {
        try {
          const embedData = JSON.parse(String(codeElement.props.children).trim())
          return (
            <CodeEmbedCard
              files={embedData.files}
              src={embedData.src}
              startLine={embedData.startLine}
              endLine={embedData.endLine}
              section={embedData.section}
              tabs={embedData.tabs}
              note={note}
              onOpenCodeModal={onOpenCodeModal}
            />
          )
        } catch {
          return null
        }
      }
      if (language === 'notes-math-block') {
        const codeContent = codeElement ? codeElement.props.children : children
        return <MathBlock math={String(codeContent).trim()} />
      }
      if (language === 'mermaid') return <MermaidDiagram source={String(codeElement.props.children).replace(/\n$/, '')} />
      if (language === 'notes-trusted-iframe') return <TrustedIframeEmbed source={String(codeElement.props.children).trim()} />
      if (language === 'notes-references-section') {
        try {
          const data = JSON.parse(String(codeElement.props.children).trim())
          return (
            <ReferencesSection
              headingTitle={data.title}
              headingId={data.id}
              groups={data.groups}
              items={data.items}
              onOpenLink={onOpenLink}
            />
          )
        } catch {
          return null
        }
      }
      const codeContent = codeElement ? codeElement.props.children : children
      return <CodeBlock language={language} code={codeContent} />
    },
  }
  const transformed = markdownWithMath(markdownWithCodeEmbeds(markdownWithReferences(markdownWithTrustedIframes(note.content), note, index)))
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{transformed}</ReactMarkdown>
})

function NotePageNavigation({ previousNote, nextNote, rootPath, onNavigate }) {
  const context = item => {
    if (!item) return ''
    const parts = relativeParts(item.path, rootPath).slice(0, -1).map(displayName)
    return parts.join(' / ')
  }
  const destination = (item, direction) => {
    if (!item) return null
    const title = item.title || displayName(item.path.split('/').at(-1))
    return <button type="button" className={`notes-page-nav-link is-${direction}`} onClick={() => onNavigate(item.path)} aria-label={`${direction === 'previous' ? 'Previous' : 'Next'} note: ${title}`}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d={direction === 'previous' ? 'm14 6-6 6 6 6M8 12h10' : 'm10 6 6 6-6 6M6 12h10'}/></svg>
      <span><strong>{title}</strong>{context(item) && <small>{context(item)}</small>}</span>
    </button>
  }
  return <nav className="notes-page-navigation" aria-label="Previous and next notes">{destination(previousNote, 'previous')}{destination(nextNote, 'next')}</nav>
}

function headingTree(headings) {
  const roots = []
  const stack = []
  for (const heading of headings) {
    const node = { ...heading, children: [] }
    while (stack.length && stack.at(-1).level >= node.level) stack.pop()
    if (stack.length) stack.at(-1).children.push(node)
    else roots.push(node)
    stack.push(node)
  }
  return roots
}

function useHeadingScrollspy(headings, scrollContainerRef, headingIdPrefix = '') {
  const [activeId, setActiveId] = React.useState('')

  React.useEffect(() => {
    if (!headings || !headings.length) {
      setActiveId('')
      return
    }

    const getContainer = () => scrollContainerRef?.current || document.querySelector('.note-reader')

    const updateActiveHeading = () => {
      const container = getContainer()
      if (!container) return

      const containerRect = container.getBoundingClientRect()
      const threshold = containerRect.top + 140

      let matchedId = headings[0]?.id || ''

      for (let i = 0; i < headings.length; i++) {
        const heading = headings[i]
        const targetId = headingIdPrefix ? `${headingIdPrefix}${heading.id}` : heading.id
        const el = document.getElementById(targetId)
        if (!el) continue

        const rect = el.getBoundingClientRect()
        if (rect.top <= threshold) {
          matchedId = heading.id
        } else {
          break
        }
      }

      setActiveId(matchedId)
    }

    const container = getContainer()
    if (container) {
      container.addEventListener('scroll', updateActiveHeading, { passive: true })
    }

    const timer = setTimeout(updateActiveHeading, 120)

    return () => {
      if (container) container.removeEventListener('scroll', updateActiveHeading)
      clearTimeout(timer)
    }
  }, [headings, scrollContainerRef, headingIdPrefix])

  return activeId
}

function filterHeadingTree(nodes, query) {
  if (!query) return nodes
  return nodes.flatMap(node => {
    const children = filterHeadingTree(node.children, query)
    return node.title.toLowerCase().includes(query) || children.length ? [{ ...node, children }] : []
  })
}

function OutlineHeadingTree({ nodes, depth = 0, onNavigate, onSelectHeading, activeId }) {
  return <ol className={depth === 0 ? 'notes-outline-tree' : 'notes-outline-branch'}>{nodes.map(node => {
    const isActive = node.id === activeId
    return <li key={node.id}>
      <button
        type="button"
        data-heading-id={node.id}
        className={`outline-heading-level-${node.level} ${isActive ? 'is-active-heading' : ''}`}
        aria-current={isActive ? 'location' : undefined}
        onClick={() => {
          if (onSelectHeading) {
            onSelectHeading(node)
          } else {
            const el = document.getElementById(node.id)
            if (el) {
              uncollapseTargetIfNeeded(el)
              el.scrollIntoView({ behavior: 'smooth', block: 'start' })
              el.classList.add('notes-target-heading-highlight')
              setTimeout(() => el.classList.remove('notes-target-heading-highlight'), 2400)
            }
          }
          onNavigate?.()
        }}
        title={node.title}
      >
        <span className="notes-outline-heading-title">{node.title}</span>
      </button>
      {node.children.length > 0 && (
        <OutlineHeadingTree
          nodes={node.children}
          depth={depth + 1}
          onNavigate={onNavigate}
          onSelectHeading={onSelectHeading}
          activeId={activeId}
        />
      )}
    </li>
  })}</ol>
}

function useResizablePanel({ initialWidth, minWidth = 220, maxWidth = 600, storageKey, direction = 'left' }) {
  const [width, setWidth] = React.useState(() => {
    try {
      const saved = localStorage.getItem(storageKey)
      if (saved) {
        const parsed = Number(saved)
        if (!isNaN(parsed) && parsed >= minWidth && parsed <= maxWidth) return parsed
      }
    } catch {}
    return initialWidth
  })

  const [isResizing, setIsResizing] = React.useState(false)

  const handlePointerDown = React.useCallback(event => {
    event.preventDefault()
    setIsResizing(true)
    const startX = event.clientX
    const startWidth = width

    const onPointerMove = moveEvent => {
      const deltaX = moveEvent.clientX - startX
      const newWidth = direction === 'left'
        ? Math.min(maxWidth, Math.max(minWidth, Math.round(startWidth + deltaX)))
        : Math.min(maxWidth, Math.max(minWidth, Math.round(startWidth - deltaX)))
      setWidth(newWidth)
    }

    const onPointerUp = () => {
      setIsResizing(false)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
  }, [width, minWidth, maxWidth, direction])

  const handleDoubleClick = React.useCallback(() => {
    setWidth(initialWidth)
    try { localStorage.removeItem(storageKey) } catch {}
  }, [initialWidth, storageKey])

  React.useEffect(() => {
    if (!isResizing) {
      try { localStorage.setItem(storageKey, String(width)) } catch {}
    }
  }, [width, isResizing, storageKey])

  return { width, setWidth, isResizing, handlePointerDown, handleDoubleClick }
}

function PanelSplitter({ direction = 'left', onPointerDown, onDoubleClick, isResizing, label = 'Drag to resize (Double-click to reset)' }) {
  return (
    <div
      className={`notes-panel-splitter is-${direction} ${isResizing ? 'is-active' : ''}`}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      role="separator"
      aria-orientation="vertical"
      tabIndex={0}
      title={label}
      aria-label={label}
    >
      <div className="notes-splitter-handle" aria-hidden="true" />
    </div>
  )
}

function calculateReadingStats(content = '') {
  if (!content) return { words: 0, minutes: 1, text: '1 min read', technicalCount: 0 }

  const stripped = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[.*?\]\(.*?\)/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#*`_~>[\]]/g, ' ')

  const words = stripped.trim().split(/\s+/).filter(Boolean).length
  const codeBlockCount = (content.match(/```[a-z0-9_-]*/gi) || []).length / 2
  const diagramCount = (content.match(/```mermaid/gi) || []).length + (content.match(/\.excalidraw/gi) || []).length
  const technicalTimeSec = (codeBlockCount * 15) + (diagramCount * 20)
  const readingMinutes = Math.max(1, Math.ceil((words / 200) + (technicalTimeSec / 60)))

  return {
    words,
    minutes: readingMinutes,
    text: `${readingMinutes} min read`,
    technicalCount: Math.round(codeBlockCount + diagramCount)
  }
}

function extractTabsFromSlideContent(slideLines) {
  const tabs = []
  let inCode = false
  let currentTab = null
  let introLines = []
  let inTabIntro = true

  for (let i = 0; i < slideLines.length; i++) {
    const line = slideLines[i]
    const trimmed = line.trim()

    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inCode = !inCode
    }

    const h3Match = !inCode && line.match(/^###\s+(.+?)\s*#*\s*$/)

    if (h3Match) {
      if (inTabIntro) {
        inTabIntro = false
        const introText = introLines.join('\n').trim()
        if (introText) {
          tabs.push({
            id: 'tab-0-overview',
            label: 'Overview',
            content: introText,
          })
        }
      } else if (currentTab) {
        currentTab.content = currentTab.lines.join('\n').trim()
        delete currentTab.lines
        tabs.push(currentTab)
      }

      const rawTitle = cleanHeading(h3Match[1])
      currentTab = {
        id: `tab-${tabs.length + 1}-${slug(rawTitle)}`,
        label: rawTitle,
        lines: [line],
      }
    } else {
      if (inTabIntro) {
        introLines.push(line)
      } else if (currentTab) {
        currentTab.lines.push(line)
      }
    }
  }

  if (inTabIntro) {
    // No H3 found in this slide
    return []
  } else if (currentTab) {
    currentTab.content = currentTab.lines.join('\n').trim()
    delete currentTab.lines
    tabs.push(currentTab)
  }

  return tabs.length > 1 ? tabs : []
}

function extractSlidesFromMarkdown(content, note) {
  if (!content) return []

  const normalizedContent = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalizedContent.split('\n')
  const slides = []
  let currentSlide = null
  let introLines = []
  let inIntro = true
  let inCodeBlock = false
  let slideIndex = 0

  const finishSlide = (slide) => {
    if (!slide) return
    const rawContent = slide.lines.join('\n').trim()
    const tabs = extractTabsFromSlideContent(slide.lines)
    slides.push({
      id: slide.id,
      slideNumber: slide.slideNumber,
      type: slide.type,
      title: slide.title,
      content: rawContent,
      tabs: tabs.length > 0 ? tabs : null,
    })
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inCodeBlock = !inCodeBlock
    }

    const h2Match = !inCodeBlock && line.match(/^##\s+(.+?)\s*#*\s*$/)

    if (h2Match) {
      if (inIntro) {
        inIntro = false
        const introMarkdown = introLines.join('\n').trim()
        const introTabs = extractTabsFromSlideContent(introLines)
        slides.push({
          id: 'slide-0-intro',
          slideNumber: slideIndex++,
          type: 'intro',
          title: note?.title || 'Overview',
          content: introMarkdown,
          tabs: introTabs.length > 0 ? introTabs : null,
        })
      } else if (currentSlide) {
        finishSlide(currentSlide)
      }

      const rawTitle = cleanHeading(h2Match[1])
      const isRef = /^references?$/i.test(rawTitle)

      if (isRef) {
        currentSlide = null
      } else {
        currentSlide = {
          id: `slide-${slideIndex}-${slug(rawTitle)}`,
          slideNumber: slideIndex++,
          type: 'h2',
          title: rawTitle,
          lines: [line],
        }
      }
    } else {
      if (inIntro) {
        introLines.push(line)
      } else if (currentSlide) {
        currentSlide.lines.push(line)
      }
    }
  }

  if (inIntro) {
    const introMarkdown = introLines.join('\n').trim()
    const introTabs = extractTabsFromSlideContent(introLines)
    slides.push({
      id: 'slide-0-intro',
      slideNumber: 0,
      type: 'intro',
      title: note?.title || 'Overview',
      content: introMarkdown,
      tabs: introTabs.length > 0 ? introTabs : null,
    })
  } else if (currentSlide) {
    finishSlide(currentSlide)
  }

  return slides
}

function NotePresentationMode({ note, index, repository, onOpenLink, onClose }) {
  const slides = React.useMemo(() => extractSlidesFromMarkdown(note?.content, note), [note?.content, note?.title])
  const [currentIndex, setCurrentIndex] = React.useState(0)
  const [currentTabIdx, setCurrentTabIdx] = React.useState(0)
  const [direction, setDirection] = React.useState('next')
  const [showOverview, setShowOverview] = React.useState(false)
  const [isFullscreen, setIsFullscreen] = React.useState(Boolean(document.fullscreenElement))
  const [stepMode, setStepMode] = React.useState(false)
  const [currentStep, setCurrentStep] = React.useState(0)
  const [fragmentCount, setFragmentCount] = React.useState(0)
  const [laserPointer, setLaserPointer] = React.useState(false)
  const [altPressed, setAltPressed] = React.useState(false)
  const [laserPos, setLaserPos] = React.useState({ x: 0, y: 0, visible: false })
  const slideCardRef = React.useRef(null)

  const totalSlides = slides.length
  const currentSlide = slides[currentIndex] || slides[0]
  const hasTabs = Boolean(currentSlide?.tabs && currentSlide.tabs.length > 1)
  const activeContent = hasTabs ? (currentSlide.tabs[currentTabIdx]?.content || currentSlide.content) : currentSlide?.content
  const slideHeadings = React.useMemo(() => extractHeadings(activeContent), [activeContent])
  const slideNote = React.useMemo(() => (note && currentSlide ? { ...note, content: activeContent } : note), [note, activeContent])

  const goToSlide = React.useCallback((targetIndex, dir, targetTab = 0) => {
    if (targetIndex < 0 || targetIndex >= totalSlides) return
    setDirection(dir || (targetIndex >= currentIndex ? 'next' : 'prev'))
    setCurrentIndex(targetIndex)
    setCurrentTabIdx(targetTab)
    setCurrentStep(0)
    setShowOverview(false)
  }, [currentIndex, totalSlides])

  React.useEffect(() => {
    if (slideCardRef.current) {
      slideCardRef.current.scrollTo({ top: 0 })
    }
  }, [currentIndex, currentTabIdx])

  // Track and update fragment elements for step-by-step reveal
  React.useLayoutEffect(() => {
    if (!slideCardRef.current) return
    const container = slideCardRef.current.querySelector('.notes-slide-body')
    if (!container) {
      setFragmentCount(0)
      return
    }

    const items = [...container.querySelectorAll(':scope > p, :scope > blockquote, :scope > pre, :scope > .notes-code-block-card, :scope > .notes-code-embed-card, :scope > .notes-math-block-card, :scope > .notes-table-container, :scope > table, :scope > .notes-mermaid-container, :scope > .mermaid-preview-card, :scope > .notes-image-container, :scope > img, :scope > .notes-trusted-iframe-wrapper, :scope > hr, :scope ul > li, :scope ol > li')]
    setFragmentCount(items.length)

    items.forEach((item, idx) => {
      if (stepMode) {
        item.classList.add('notes-reveal-item')
        if (idx <= currentStep) {
          item.classList.add('is-revealed')
          item.classList.remove('is-pending')
        } else {
          item.classList.remove('is-revealed')
          item.classList.add('is-pending')
        }
      } else {
        item.classList.remove('notes-reveal-item', 'is-revealed', 'is-pending')
      }
    })

    if (stepMode && items[currentStep] && currentStep > 0) {
      items[currentStep].scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    } else if (stepMode && currentStep === 0) {
      slideCardRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }, [currentIndex, currentSlide, activeContent, stepMode, currentStep])

  const nextSlide = React.useCallback(() => {
    if (stepMode && fragmentCount > 0 && currentStep < fragmentCount - 1) {
      setCurrentStep(step => step + 1)
      return
    }
    if (hasTabs && currentTabIdx < currentSlide.tabs.length - 1) {
      setCurrentTabIdx(t => t + 1)
      setCurrentStep(0)
      if (slideCardRef.current) slideCardRef.current.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    if (currentIndex < totalSlides - 1) {
      goToSlide(currentIndex + 1, 'next', 0)
    }
  }, [stepMode, fragmentCount, currentStep, hasTabs, currentTabIdx, currentSlide, currentIndex, totalSlides, goToSlide])

  const prevSlide = React.useCallback(() => {
    if (stepMode && currentStep > 0) {
      setCurrentStep(step => step - 1)
      return
    }
    if (hasTabs && currentTabIdx > 0) {
      setCurrentTabIdx(t => t - 1)
      setCurrentStep(0)
      if (slideCardRef.current) slideCardRef.current.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    if (currentIndex > 0) {
      const prevSlideItem = slides[currentIndex - 1]
      const prevTabCount = prevSlideItem?.tabs?.length || 0
      const lastTab = prevTabCount > 1 ? prevTabCount - 1 : 0
      goToSlide(currentIndex - 1, 'prev', lastTab)
    }
  }, [stepMode, currentStep, hasTabs, currentTabIdx, currentIndex, slides, goToSlide])

  const toggleFullscreen = React.useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {})
      setIsFullscreen(true)
    } else {
      document.exitFullscreen?.().catch(() => {})
      setIsFullscreen(false)
    }
  }, [])

  React.useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  React.useEffect(() => {
    const handleKeyDown = event => {
      if (event.key === 'Alt') setAltPressed(true)
      if (['INPUT', 'TEXTAREA'].includes(event.target.tagName)) return

      if (event.key === 'Escape') {
        if (showOverview) setShowOverview(false)
        else onClose()
      } else if (event.key === 'ArrowRight' || event.key === ' ' || event.key === 'PageDown' || event.key === 'l' || event.key === 'L') {
        event.preventDefault()
        nextSlide()
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp' || event.key === 'h' || event.key === 'H' || event.key === 'Backspace') {
        event.preventDefault()
        prevSlide()
      } else if (event.key === 'Tab' && hasTabs) {
        event.preventDefault()
        if (event.shiftKey) {
          setCurrentTabIdx(prev => (prev > 0 ? prev - 1 : currentSlide.tabs.length - 1))
        } else {
          setCurrentTabIdx(prev => (prev < currentSlide.tabs.length - 1 ? prev + 1 : 0))
        }
        setCurrentStep(0)
        if (slideCardRef.current) slideCardRef.current.scrollTo({ top: 0, behavior: 'smooth' })
      } else if (event.key >= '1' && event.key <= '9' && hasTabs) {
        const targetTab = parseInt(event.key, 10) - 1
        if (targetTab < currentSlide.tabs.length) {
          event.preventDefault()
          setCurrentTabIdx(targetTab)
          setCurrentStep(0)
          if (slideCardRef.current) slideCardRef.current.scrollTo({ top: 0, behavior: 'smooth' })
        }
      } else if (event.key === 'Home') {
        event.preventDefault()
        goToSlide(0, 'prev', 0)
      } else if (event.key === 'End') {
        event.preventDefault()
        goToSlide(totalSlides - 1, 'next', 0)
      } else if (event.key === 'f' || event.key === 'F') {
        event.preventDefault()
        toggleFullscreen()
      } else if (event.key === 'g' || event.key === 'G' || event.key === 'o' || event.key === 'O') {
        event.preventDefault()
        setShowOverview(value => !value)
      } else if (event.key === 'r' || event.key === 'R') {
        event.preventDefault()
        setStepMode(value => !value)
      } else if (event.key === 'p' || event.key === 'P') {
        event.preventDefault()
        setLaserPointer(value => !value)
      }
    }

    const handleKeyUp = event => {
      if (event.key === 'Alt') setAltPressed(false)
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [nextSlide, prevSlide, goToSlide, showOverview, onClose, totalSlides, toggleFullscreen, hasTabs, currentSlide])

  const isLaserActive = laserPointer || altPressed

  const handlePointerMove = event => {
    if (isLaserActive) {
      setLaserPos({ x: event.clientX, y: event.clientY, visible: true })
    }
  }

  const handlePointerLeave = () => {
    setLaserPos(pos => ({ ...pos, visible: false }))
  }

  const progressPercent = totalSlides > 0 ? ((currentIndex + 1) / totalSlides) * 100 : 100

  return (
    <div
      className={`notes-presentation-overlay ${isLaserActive ? 'is-laser-active' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={`Slide presentation: ${note?.title}`}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    >
      {/* Top Header & Progress Bar */}
      <div className="notes-presentation-topbar">
        <div className="notes-presentation-progress-track">
          <div className="notes-presentation-progress-fill" style={{ width: `${progressPercent}%` }} />
        </div>
        <div className="notes-presentation-topbar-content">
          <div className="notes-presentation-title-info">
            <span className="notes-presentation-slide-badge">Slide {currentIndex + 1} of {totalSlides}</span>
            <strong className="notes-presentation-note-title" title={note?.title}>{note?.title}</strong>
          </div>
          <div className="notes-presentation-top-actions">
            {/* Step-by-Step Reveal Mode Toggle */}
            <button
              type="button"
              className={`notes-presentation-btn ${stepMode ? 'is-active' : ''}`}
              onClick={() => setStepMode(value => !value)}
              title="Toggle Step-by-Step Reveal Mode (R)"
              aria-label="Toggle step-by-step reveal mode"
              aria-pressed={stepMode}
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 6h16M4 12h10M4 18h6" />
                <path d="m15 15 3 3 5-5" />
              </svg>
              <span>{stepMode ? (fragmentCount > 0 ? `Step ${Math.min(currentStep + 1, fragmentCount)}/${fragmentCount}` : 'Step Mode') : 'Reveal'}</span>
            </button>

            {/* Virtual Laser Pointer Toggle */}
            <button
              type="button"
              className={`notes-presentation-btn ${isLaserActive ? 'is-laser-btn-active' : ''}`}
              onClick={() => setLaserPointer(value => !value)}
              title="Toggle Laser Pointer (P or hold Alt)"
              aria-label="Toggle laser pointer"
              aria-pressed={isLaserActive}
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
                <path d="M12 2v3m0 14v3M2 12h3m14 0h3" />
              </svg>
              <span>Laser</span>
            </button>

            {/* Slide Grid Overview */}
            <button
              type="button"
              className={`notes-presentation-btn ${showOverview ? 'is-active' : ''}`}
              onClick={() => setShowOverview(value => !value)}
              title="Slide Overview Grid (G)"
              aria-label="Slide overview grid"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="3" y="14" width="7" height="7" rx="1.5" />
                <rect x="14" y="14" width="7" height="7" rx="1.5" />
              </svg>
              <span>Grid</span>
            </button>

            {/* Fullscreen Toggle */}
            <button
              type="button"
              className="notes-presentation-btn"
              onClick={toggleFullscreen}
              title="Toggle Fullscreen (F)"
              aria-label="Toggle fullscreen"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {isFullscreen ? (
                  <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>
                ) : (
                  <path d="M8 3H3v5m13-5h5v5M8 21H3v-5m13 5h5v-5"/>
                )}
              </svg>
            </button>

            {/* Exit Button */}
            <button
              type="button"
              className="notes-presentation-btn is-close"
              onClick={onClose}
              title="Exit Presentation (Esc)"
              aria-label="Exit presentation"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12"/>
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Main Slide Stage */}
      <div className="notes-presentation-stage">
        {currentSlide && (
          <div
            ref={slideCardRef}
            key={`${currentSlide.id}-${currentIndex}-${currentTabIdx}`}
            className={`notes-slide-card is-${direction} ${currentSlide.type === 'intro' ? 'is-intro-slide' : ''} ${stepMode ? 'is-step-mode' : ''}`}
          >
            {currentSlide.type === 'intro' && (
              <div className="notes-slide-hero">
                <div className="notes-slide-eyebrow">
                  {repository && <span className="notes-slide-repo-tag">@{repository.owner}/{repository.name}</span>}
                  <span className="notes-slide-count-tag">{totalSlides} Interactive Slides</span>
                </div>
                <h1 className="notes-slide-hero-title">{note?.title}</h1>
              </div>
            )}

            {/* In-Slide Sub-Topic Tabs (Option 3) */}
            {hasTabs && (
              <div className="notes-slide-tabs-bar" role="tablist" aria-label="Slide sub-topics">
                {currentSlide.tabs.map((tab, idx) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={currentTabIdx === idx}
                    className={`notes-slide-tab-pill ${currentTabIdx === idx ? 'is-active' : ''}`}
                    onClick={() => {
                      setCurrentTabIdx(idx)
                      setCurrentStep(0)
                      if (slideCardRef.current) slideCardRef.current.scrollTo({ top: 0, behavior: 'smooth' })
                    }}
                    title={`Sub-topic ${idx + 1}: ${tab.label} (Press ${idx + 1})`}
                  >
                    <span className="notes-slide-tab-num">{idx + 1}</span>
                    <span className="notes-slide-tab-label">{tab.label}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="notes-slide-body markdown-body">
              <MarkdownContent
                note={slideNote}
                headings={slideHeadings}
                index={index}
                onOpenLink={onOpenLink}
                headingIdPrefix={`slide-${currentIndex}-${currentTabIdx}-`}
              />
            </div>
          </div>
        )}
      </div>

      {/* Virtual Laser Pointer Dot */}
      {isLaserActive && laserPos.visible && (
        <div
          className="notes-presentation-laser-dot"
          style={{
            left: `${laserPos.x}px`,
            top: `${laserPos.y}px`,
          }}
          aria-hidden="true"
        />
      )}

      {/* Bottom Floating Control Dock */}
      <div className="notes-presentation-dock">
        <button
          type="button"
          className="notes-dock-nav-btn is-prev"
          disabled={currentIndex === 0 && currentTabIdx === 0 && (!stepMode || currentStep === 0)}
          onClick={prevSlide}
          title="Previous (← / ArrowLeft / Backspace)"
          aria-label="Previous step or slide"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m15 18-6-6 6-6"/>
          </svg>
        </button>

        <div className="notes-dock-slide-counter">
          <span className="current-num">{currentIndex + 1}</span>
          <span className="divider">/</span>
          <span className="total-num">{totalSlides}</span>
          {hasTabs && (
            <span className="notes-dock-tab-badge" title="Active sub-topic tab">
              Tab {currentTabIdx + 1}/{currentSlide.tabs.length}
            </span>
          )}
          {stepMode && fragmentCount > 0 && (
            <span className="notes-dock-step-badge">
              Step {Math.min(currentStep + 1, fragmentCount)}/{fragmentCount}
            </span>
          )}
        </div>

        <button
          type="button"
          className="notes-dock-nav-btn is-next"
          disabled={currentIndex === totalSlides - 1 && (!hasTabs || currentTabIdx === currentSlide.tabs.length - 1) && (!stepMode || currentStep === fragmentCount - 1)}
          onClick={nextSlide}
          title="Next (→ / Space / ArrowRight)"
          aria-label="Next step or slide"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m9 18 6-6-6-6"/>
          </svg>
        </button>

        <div className="notes-dock-shortcuts-hint" aria-hidden="true">
          <kbd>Space</kbd> Next {hasTabs && <>· <kbd>1-{currentSlide.tabs.length}</kbd> / <kbd>Tab</kbd> Sub-topic </>}· <kbd>R</kbd> Reveal · <kbd>P</kbd> Laser · <kbd>G</kbd> Grid · <kbd>F</kbd> Fullscreen · <kbd>Esc</kbd> Exit
        </div>
      </div>

      {/* Slide Overview Grid Modal */}
      {showOverview && (
        <div className="notes-slide-grid-modal-backdrop" onClick={() => setShowOverview(false)}>
          <div className="notes-slide-grid-modal" onClick={e => e.stopPropagation()}>
            <div className="notes-slide-grid-header">
              <div>
                <h2>Slide Overview</h2>
                <p>Click any slide to jump directly to it</p>
              </div>
              <button
                type="button"
                className="notes-slide-grid-close"
                onClick={() => setShowOverview(false)}
                title="Close Overview (Esc / G)"
              >
                ×
              </button>
            </div>
            <div className="notes-slide-grid-cards">
              {slides.map((s, idx) => (
                <button
                  type="button"
                  key={s.id}
                  className={`notes-slide-grid-card ${idx === currentIndex ? 'is-current' : ''}`}
                  onClick={() => goToSlide(idx)}
                >
                  <div className="notes-slide-grid-card-header">
                    <span className="notes-slide-grid-num">#{idx + 1}</span>
                    <span className="notes-slide-grid-type">{s.type === 'intro' ? 'Overview' : 'Section'}</span>
                    {s.tabs && s.tabs.length > 1 && (
                      <span className="notes-slide-grid-tabs-badge">{s.tabs.length} Tabs</span>
                    )}
                  </div>
                  <strong className="notes-slide-grid-title">{s.title}</strong>
                  <p className="notes-slide-grid-snippet">
                    {s.content.replace(/^#+.*$/gm, '').replace(/```[\s\S]*?```/g, '[Code]').replace(/!\[.*?\]\(.*?\)/g, '[Image]').slice(0, 100).trim() || 'No preview text'}
                  </p>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function toggleAllH2Sections(collapse) {
  const headings = document.querySelectorAll('.notes-collapsible-h2')
  headings.forEach(heading => {
    const isCurrentlyCollapsed = heading.classList.contains('is-collapsed')
    if (collapse && !isCurrentlyCollapsed) {
      toggleH2Section(heading)
    } else if (!collapse && isCurrentlyCollapsed) {
      toggleH2Section(heading)
    }
  })
}

function OnThisPage({ note, headings, readingStats, scrollContainerRef, mobileOpen = false, isMobile = false, onMobileClose, onPresent, splitter }) {
  const [query, setQuery] = React.useState('')
  const [allCollapsed, setAllCollapsed] = React.useState(false)
  const activeId = useHeadingScrollspy(headings, scrollContainerRef)

  React.useEffect(() => {
    setQuery('')
    setAllCollapsed(false)
  }, [note?.path])

  const handleToggleAll = () => {
    const nextState = !allCollapsed
    setAllCollapsed(nextState)
    toggleAllH2Sections(nextState)
  }

  const normalizedQuery = query.trim().toLowerCase()
  const visibleHeadingTree = filterHeadingTree(headingTree(headings), normalizedQuery)
  return <aside className={`notes-outline ${mobileOpen ? 'mobile-open' : ''}`} aria-label="On this page" aria-hidden={isMobile && !mobileOpen}>
    {splitter}
    <div className="notes-outline-sticky">
      <div className="notes-outline-header-row">
        <div className="notes-outline-header-title">
          <span>On this page</span>
          {readingStats && <span className="notes-outline-reading-tag">{readingStats.text}</span>}
        </div>
        <div className="notes-outline-actions">
          {note && (
            <button
              type="button"
              className="notes-outline-action-btn notes-outline-present"
              onClick={onPresent}
              title="Present note as interactive slides (H2 sections)"
              aria-label="Present note as interactive slides"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M2 3h20v14H2z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M8 21h8M12 17v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                <path d="m10 7.5 5 3.5-5 3.5V7.5z" fill="currentColor"/>
              </svg>
            </button>
          )}
          <button
            type="button"
            className="notes-outline-action-btn"
            onClick={handleToggleAll}
            title={allCollapsed ? 'Expand all sections' : 'Collapse all sections'}
            aria-label={allCollapsed ? 'Expand all sections' : 'Collapse all sections'}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              {allCollapsed ? (
                <path d="M8 3H3v5m13-5h5v5M8 21H3v-5m13 5h5v-5M3 8l5-5m13 5-5-5M3 16l5 5m13-5-5 5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
              ) : (
                <path d="M9 9H4V4m11 5h5V4M9 15H4v5m11-5h5v5M4 9l5-5m11 5-5-5M4 15l5 5m11-5-5 5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
              )}
            </svg>
          </button>
          {note?.github_url && (
            <a className="notes-outline-action-btn notes-outline-source" href={note.github_url} target="_blank" rel="noreferrer" title="Edit / view on GitHub" aria-label="Edit or view this note on GitHub">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 0 0-3 17.5c.5.1.7-.2.7-.5v-1.8c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 0 1.6 1.1 1.6 1.1.9 1.6 2.4 1.1 2.9.9.1-.7.4-1.1.7-1.4-2.2-.3-4.6-1.1-4.6-5A3.9 3.9 0 0 1 7 7.8 3.6 3.6 0 0 1 7.1 5s.8-.3 2.9 1.1a10 10 0 0 1 5.2 0C17.2 4.7 18 5 18 5a3.6 3.6 0 0 1 .1 2.8 3.9 3.9 0 0 1 1 2.7c0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.8V20c0 .3.2.6.7.5A9 9 0 0 0 12 3Z"/></svg>
            </a>
          )}
          {isMobile && (
            <button
              type="button"
              className="notes-outline-action-btn notes-outline-close-mobile"
              onClick={onMobileClose}
              aria-label="Close page outline"
              title="Close outline"
            >
              ×
            </button>
          )}
        </div>
      </div>
      <strong>{note?.title || 'Note outline'}</strong>
      <label className="notes-outline-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a heading…" aria-label="Search headings in this note"/></label>
      {visibleHeadingTree.length ? <nav><OutlineHeadingTree nodes={visibleHeadingTree} activeId={activeId} onNavigate={onMobileClose}/></nav> : <p>{headings.length ? 'No headings match your search.' : 'No headings in this note.'}</p>}
    </div>
  </aside>
}

const REPOSITORY_COLORS = {
  'senior-system-engineer': ['#7c3aed', '#ec4899'],
  'ai-engineer': ['#0891b2', '#6366f1'],
  'microservice-java': ['#ea580c', '#ef4444'],
  'microservice-python': ['#0284c7', '#eab308'],
  'cloud-engineering': ['#2563eb', '#06b6d4'],
}

function repositoryStyle(repositoryOrId) {
  let colors = null
  if (repositoryOrId && typeof repositoryOrId === 'object') {
    colors = repositoryOrId.repositoryStyle || repositoryOrId.colors
  }
  const repositoryId = typeof repositoryOrId === 'string' ? repositoryOrId : repositoryOrId?.id

  if (!colors && repositoryId) {
    const configured = NOTE_REPOSITORIES.find(r => r.id === repositoryId)
    colors = configured?.repositoryStyle || configured?.colors
  }

  const [accent, secondary] = colors || REPOSITORY_COLORS[repositoryId] || ['#73553f', '#d97706']
  return { '--notes-accent': accent, '--notes-accent-2': secondary, '--notes-glow': `${accent}2e` }
}

function RepositoryMark({ repositoryId, className = '' }) {
  const gradientId = React.useId().replace(/[^a-zA-Z0-9_-]/g, '')
  return <svg className={`notes-repository-mark ${className}`} viewBox="0 0 64 64" aria-hidden="true">
    <defs><linearGradient id={gradientId} x1="8" y1="7" x2="57" y2="58" gradientUnits="userSpaceOnUse"><stop stopColor="var(--notes-accent)"/><stop offset="1" stopColor="var(--notes-accent-2)"/></linearGradient></defs>
    <rect x="3" y="3" width="58" height="58" rx="17" fill={`url(#${gradientId})`}/>
    <path d="M17 17h22a8 8 0 0 1 8 8v24H23a6 6 0 0 1-6-6V17Z" fill="none" stroke="white" strokeWidth="2.8" strokeLinejoin="round"/>
    <path d="M23 17v26a6 6 0 0 0-6-6m12-11h11M29 33h11M29 40h7" fill="none" stroke="white" strokeWidth="2.8" strokeLinecap="round"/>
    {repositoryId === 'ai-engineer' && <><circle cx="45" cy="18" r="5" fill="#fff"/><path d="m41.5 21.5-5 5" stroke="#fff" strokeWidth="2.5"/></>}
    {repositoryId === 'microservice-java' && <path d="M43 45c5 0 7-3 7-6-3 0-5 1-7 3" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round"/>}
    {repositoryId === 'microservice-python' && <path d="m39 21 5 4-5 4" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/>}
  </svg>
}

function RepositoryAuthor({ repository, compact = false }) {
  const owner = repository?.owner || 'GitHub'
  const avatarUrl = repository?.owner ? `https://github.com/${encodeURIComponent(repository.owner)}.png?size=96` : ''
  return <span className={`notes-repository-author ${compact ? 'compact' : ''}`}>
    {avatarUrl && <img className="notes-author-avatar-img" src={avatarUrl} alt={owner} loading="lazy"/>}
    <span><small>Repository author</small><strong>@{owner}</strong></span>
  </span>
}

function RepositoryDropdown({ repositories, selected, onSelect }) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const pickerRef = React.useRef(null)
  React.useEffect(() => {
    const close = event => { if (!pickerRef.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [])
  const visible = repositories.filter(repository => `${repository.name} ${repository.description}`.toLowerCase().includes(query.trim().toLowerCase()))
  const choose = repository => { onSelect(repository.id); setOpen(false); setQuery('') }
  return <div className="notes-repository-picker" ref={pickerRef}>
    <button type="button" className="notes-repository-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <RepositoryMark repositoryId={selected?.id}/><span><b>{selected?.name || 'Choose repository'}</b>{selected ? <RepositoryAuthor repository={selected} compact/> : <small>Select a learning-notes repository</small>}</span><svg className="notes-picker-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
    </button>
    {open && <div className="notes-repository-menu" role="menu" aria-label="Switch notes repository">
      <strong>Switch learning notes</strong>
      <label><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search repositories…"/></label>
      <div className="notes-repository-menu-list">{visible.map(repository => <button type="button" role="menuitem" className={`notes-repository-item ${repository.id === selected?.id ? 'active' : ''}`} key={repository.id} onClick={() => choose(repository)}><span className="notes-repository-option-visual"><img className="notes-author-avatar-img" src={`https://github.com/${encodeURIComponent(repository.owner)}.png?size=96`} alt={repository.owner} loading="lazy"/></span><span className="notes-repository-option-copy"><span className="notes-repository-name-row"><b>{repository.name}</b><span className="notes-repository-option-author">@{repository.owner}</span></span><small>{repository.description}</small></span>{repository.id === selected?.id && <span className="notes-repository-option-check" aria-hidden="true"><svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 0 1 0 1.414l-8 8a1 1 0 0 1-1.414 0l-4-4a1 1 0 0 1 1.414-1.414L8 12.586l7.293-7.293a1 1 0 0 1 1.414 0z" clipRule="evenodd" /></svg></span>}</button>)}{!visible.length && <p>No repositories match your search.</p>}</div>
    </div>}
  </div>
}

function YearDropdown({ options, selectedYear, onSelect }) {
  const [open, setOpen] = React.useState(false)
  const pickerRef = React.useRef(null)
  React.useEffect(() => {
    const close = event => { if (!pickerRef.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [])
  const selected = options.find(option => option.value === selectedYear) || options[0]
  return <div className="notes-year-picker" ref={pickerRef}>
    <button type="button" className="notes-year-trigger" onClick={() => setOpen(value => !value)} aria-haspopup="listbox" aria-expanded={open} title="Select notes year">
      <svg className="notes-year-calendar" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4m8-4v4M3 10h18"/></svg>
      <span><b>{selected?.label || 'Year'}</b></span>
      <svg className="notes-year-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
    </button>
    {open && <div className="notes-year-menu" role="listbox" aria-label="Notes year">{options.map(option => <button type="button" role="option" aria-selected={option.value === selectedYear} className={option.value === selectedYear ? 'active' : ''} key={option.value} onClick={() => { onSelect(option.value); setOpen(false) }}><span><b>{option.label}</b></span>{option.value === selectedYear && <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 4 4 8-8"/></svg>}</button>)}</div>}
  </div>
}

function TopicDropdown({ options, selectedTopic, onSelect }) {
  const [open, setOpen] = React.useState(false)
  const pickerRef = React.useRef(null)
  React.useEffect(() => {
    const close = event => { if (!pickerRef.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [])
  const selected = options.find(option => option.value === selectedTopic) || options[0]
  return <div className="notes-topic-picker" ref={pickerRef}>
    <button type="button" className="notes-topic-trigger" onClick={() => setOpen(value => !value)} aria-haspopup="listbox" aria-expanded={open} title="Select notes topic">
      <TopicIcon topic={selected?.value || 'knowledge'}/>
      <span><b>{selected?.label || 'Topic'}</b></span>
      <svg className="notes-topic-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
    </button>
    {open && <div className="notes-topic-menu" role="listbox" aria-label="Notes topic">{options.map(option => <button type="button" role="option" aria-selected={option.value === selectedTopic} className={option.value === selectedTopic ? 'active' : ''} key={option.value} onClick={() => { onSelect(option.value); setOpen(false) }}><TopicIcon topic={option.value}/><span><b>{option.label}</b></span>{option.value === selectedTopic && <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 4 4 8-8"/></svg>}</button>)}</div>}
  </div>
}

function NoteSourceToggle({ source, onChange }) {
  return (
    <div className="notes-source-toggle" role="group" aria-label="Notes source (Remote vs Local)">
      <button
        type="button"
        className={`notes-source-icon-btn ${source === 'remote' ? 'active' : ''}`}
        aria-pressed={source === 'remote'}
        onClick={() => onChange('remote')}
        title="Remote (GitHub live)"
        aria-label="Read published notes from GitHub"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9a4.5 4.5 0 0 0 1 9Z"/>
        </svg>
      </button>
      <button
        type="button"
        className={`notes-source-icon-btn ${source === 'local' ? 'active' : ''}`}
        aria-pressed={source === 'local'}
        onClick={() => onChange('local')}
        title="Local (Local checkout)"
        aria-label="Read notes from local checkout"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="14" rx="2"/>
          <path d="M8 21h8M12 18v3"/>
        </svg>
      </button>
    </div>
  )
}

function NoteSourceStatus({ source, onRefresh }) {
  const local = source === 'local'
  return <div className={`notes-source-status ${local ? 'local' : 'remote'}`} title={local ? 'Reading files from your local checkout' : 'Reading published files from GitHub'}>
    <span className="notes-source-status-dot" aria-hidden="true" />
    <span>{local ? 'Local checkout' : 'GitHub live'}</span>
    {local && <button type="button" onClick={onRefresh} title="Reload local files" aria-label="Reload local notes">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v5h-5M4 18v-5h5M18.5 9A7 7 0 0 0 6.7 6.7L4 9m16 6-2.7 2.3A7 7 0 0 1 5.5 15"/></svg>
    </button>}
  </div>
}

function RepositoryCards({ repositories, loading, onOpen }) {
  return <div className="notes-catalog"><header className="notes-page-header"><div><span className="notes-eyebrow">Your knowledge library</span><h1>Learning notes</h1><p>Choose a configured GitHub repository to explore its topics and notes.</p></div></header>{loading ? <div className="note-reader-status"><span className="spinner" /> Loading repositories…</div> : <div className="notes-repository-grid">{repositories.map(repository => <button type="button" style={repositoryStyle(repository.id)} className="notes-repository-card" key={repository.id} onClick={() => !repository.error && onOpen(repository.id)} disabled={Boolean(repository.error)}><RepositoryMark repositoryId={repository.id}/><span className="notes-repository-copy"><strong>{repository.name}</strong><RepositoryAuthor repository={repository}/><span>{repository.description}</span><small>{repository.error || `${repository.note_count} notes · ${repository.branch} / ${repository.root_path}`}</small></span><span className="notes-card-arrow">›</span></button>)}</div>}</div>
}

function getLastOpenPath(repoId, topic = '') {
  if (!repoId) return ''
  try {
    if (topic) {
      return localStorage.getItem(`learning-notes-last-path:${repoId}:${topic}`) || ''
    }
    return localStorage.getItem(`learning-notes-last-path:${repoId}`) || ''
  } catch {
    return ''
  }
}

function setLastOpenPath(repoId, path, rootPath = '') {
  if (!repoId || !path) return
  try {
    localStorage.setItem(`learning-notes-last-path:${repoId}`, path)
    if (rootPath) {
      const tax = taxonomy({ path }, rootPath)
      if (tax?.topic) {
        localStorage.setItem(`learning-notes-last-path:${repoId}:${tax.topic}`, path)
      }
      if (tax?.year) {
        localStorage.setItem(`learning-notes-last-path:${repoId}:year:${tax.year}`, path)
      }
    }
  } catch {
    // Ignore storage errors
  }
}

export default function Notes() {
  const [searchParams, setSearchParams] = useSearchParams()
  const repositoryId = searchParams.get('repo') || ''
  const selectedPath = searchParams.get('path') || ''
  const [repositories, setRepositories] = React.useState([])
  const navigationRef = React.useRef(null)
  const noteReaderRef = React.useRef(null)
  const [index, setIndex] = React.useState(null)
  const [note, setNote] = React.useState(null)
  const [query, setQuery] = React.useState('')
  const [noteSource, setNoteSource] = React.useState('remote')
  const [sourceRevision, setSourceRevision] = React.useState(0)
  const [expanded, setExpanded] = React.useState({})
  const [showNavigation, setShowNavigation] = React.useState(true)
  const [mobilePanel, setMobilePanel] = React.useState(null)
  const [isMobile, setIsMobile] = React.useState(false)
  const [linkPreview, setLinkPreview] = React.useState(null)
  const [linkPreviewHistory, setLinkPreviewHistory] = React.useState([])
  const [targetHash, setTargetHash] = React.useState('')
  const [excalidrawModal, setExcalidrawModal] = React.useState(null)
  const [codeModal, setCodeModal] = React.useState(null)
  const [loadingCatalog, setLoadingCatalog] = React.useState(true)
  const [loadingIndex, setLoadingIndex] = React.useState(false)
  const [loadingNote, setLoadingNote] = React.useState(false)
  const [presentationMode, setPresentationMode] = React.useState(false)
  const [error, setError] = React.useState('')

  const leftPanel = useResizablePanel({
    initialWidth: 360,
    minWidth: 240,
    maxWidth: 640,
    storageKey: 'learning-notes:left-panel-width',
    direction: 'left',
  })

  const rightPanel = useResizablePanel({
    initialWidth: 270,
    minWidth: 200,
    maxWidth: 480,
    storageKey: 'learning-notes:right-panel-width',
    direction: 'right',
  })

  const isResizing = leftPanel.isResizing || rightPanel.isResizing

  React.useEffect(() => {
    let active = true
    getNoteRepositories().then(data => active && setRepositories(data.repositories || [])).catch(fetchError => active && setError(fetchError.message || 'Unable to load note repositories.')).finally(() => active && setLoadingCatalog(false))
    return () => { active = false }
  }, [])

  React.useEffect(() => {
    if (!repositoryId || !repositories.length) return
    const repository = repositories.find(item => item.id === repositoryId)
    const preferred = localStorage.getItem(`learning-notes-source:${repositoryId}`)
    setNoteSource(preferred === 'local' && repository?.local_available ? 'local' : 'remote')
  }, [repositoryId, repositories])

  React.useEffect(() => {
    if (!repositoryId) return undefined
    document.body.classList.add('notes-reader-open')
    return () => document.body.classList.remove('notes-reader-open')
  }, [repositoryId])

  React.useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)')
    const update = () => { setIsMobile(media.matches); if (!media.matches) setMobilePanel(null) }
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  React.useEffect(() => {
    if (navigationRef.current) navigationRef.current.inert = !showNavigation || (isMobile && mobilePanel !== 'library')
  }, [showNavigation, isMobile, mobilePanel])

  React.useEffect(() => {
    if (!mobilePanel) return undefined
    const closeOnEscape = event => { if (event.key === 'Escape') setMobilePanel(null) }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [mobilePanel])

  React.useEffect(() => {
    if (!repositoryId) { setIndex(null); setNote(null); return undefined }
    let active = true
    setLoadingIndex(true); setError(''); setQuery('')
    getNotes(repositoryId, noteSource).then(data => {
      if (!active) return
      setIndex(data)
      const validPaths = new Set((data.notes || []).map(item => item.path))
      const savedPath = getLastOpenPath(repositoryId)
      const resolvedPath = (selectedPath && validPaths.has(selectedPath))
        ? selectedPath
        : (savedPath && validPaths.has(savedPath))
          ? savedPath
          : data.notes?.[0]?.path

      if (resolvedPath && resolvedPath !== selectedPath) {
        setSearchParams({ repo: repositoryId, path: resolvedPath }, { replace: true })
      }
      if (resolvedPath) {
        setLastOpenPath(repositoryId, resolvedPath, data.root_path || '')
      }
    }).catch(fetchError => active && setError(fetchError.message || 'Unable to load this repository.')).finally(() => active && setLoadingIndex(false))
    return () => { active = false }
  }, [repositoryId, noteSource, sourceRevision])

  React.useEffect(() => {
    if (!repositoryId || !selectedPath) { setNote(null); return undefined }
    let active = true
    setLoadingNote(true); setError('')
    getNoteContent(repositoryId, selectedPath, noteSource).then(data => {
      if (active) {
        setNote(data)
        setLastOpenPath(repositoryId, selectedPath, index?.root_path || '')
      }
    }).catch(fetchError => { if (active) { setNote(null); setError(fetchError.message || 'Unable to load this note.') } }).finally(() => active && setLoadingNote(false))
    return () => { active = false }
  }, [repositoryId, selectedPath, noteSource, sourceRevision, index?.root_path])

  const allNotes = index?.notes || []
  const currentTaxonomy = selectedPath ? taxonomy({ path: selectedPath }, index?.root_path || '') : { year: '', topic: '' }
  const years = [...new Set(allNotes.map(item => taxonomy(item, index?.root_path || '').year))].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  const selectedYear = years.includes(currentTaxonomy.year) ? currentTaxonomy.year : years[0]
  const yearNotes = allNotes.filter(item => taxonomy(item, index?.root_path || '').year === selectedYear)
  const topics = [...new Set(yearNotes.map(item => taxonomy(item, index?.root_path || '').topic))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const selectedTopic = topics.includes(currentTaxonomy.topic) ? currentTaxonomy.topic : topics[0]
  const normalizedQuery = query.trim().toLowerCase()
  const filteredNotes = allNotes.filter(item => !normalizedQuery || `${item.title} ${item.path}`.toLowerCase().includes(normalizedQuery))
  const yearFilteredNotes = filteredNotes.filter(item => taxonomy(item, index?.root_path || '').year === selectedYear)
  const topicNotes = filteredNotes.filter(item => { const value = taxonomy(item, index?.root_path || ''); return value.year === selectedYear && value.topic === selectedTopic })
  const topicPrefix = [index?.root_path, selectedYear !== 'Notes' ? selectedYear : '', selectedTopic !== 'General' ? selectedTopic : ''].filter(Boolean).join('/')
  const tree = React.useMemo(() => buildTree(topicNotes, topicPrefix), [topicNotes, topicPrefix])
  const allTreePaths = React.useMemo(() => directoryPaths(tree), [tree])
  const allTreePathsKey = allTreePaths.join('\u0000')
  const activeDirectories = React.useMemo(() => {
    if (!selectedPath || !topicPrefix || !selectedPath.startsWith(`${topicPrefix}/`)) return new Set()
    const directories = selectedPath.slice(topicPrefix.length + 1).split('/').slice(0, -1)
    return new Set(directories.map((_, position) => directories.slice(0, position + 1).join('/')))
  }, [selectedPath, topicPrefix])
  const headings = React.useMemo(() => extractHeadings(note?.content), [note?.content])
  const readingStats = React.useMemo(() => calculateReadingStats(note?.content), [note?.content])
  const [readingProgress, setReadingProgress] = React.useState(0)
  const [showScrollTop, setShowScrollTop] = React.useState(false)
  const orderedNotes = React.useMemo(() => [...allNotes].sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true })), [allNotes])
  const selectedNotePosition = orderedNotes.findIndex(item => item.path === selectedPath)
  const previousNote = selectedNotePosition > 0 ? orderedNotes[selectedNotePosition - 1] : null
  const nextNote = selectedNotePosition >= 0 && selectedNotePosition < orderedNotes.length - 1 ? orderedNotes[selectedNotePosition + 1] : null

  React.useEffect(() => setExpanded({}), [repositoryId, selectedYear, selectedTopic])

  React.useEffect(() => {
    const reader = noteReaderRef.current
    if (!reader) return

    setReadingProgress(0)
    setShowScrollTop(false)

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = reader
      const totalScrollable = scrollHeight - clientHeight
      if (totalScrollable <= 0) {
        setReadingProgress(0)
        setShowScrollTop(false)
        return
      }
      const pct = Math.min(100, Math.max(0, (scrollTop / totalScrollable) * 100))
      setReadingProgress(pct)
      setShowScrollTop(pct > 12)
    }

    reader.addEventListener('scroll', handleScroll, { passive: true })
    handleScroll()
    return () => reader.removeEventListener('scroll', handleScroll)
  }, [note?.path, note?.content])

  React.useEffect(() => {
    if (!normalizedQuery || !allTreePaths.length) return
    setExpanded(Object.fromEntries(allTreePaths.map(path => [path, true])))
  }, [normalizedQuery, allTreePathsKey])

  React.useEffect(() => {
    if (!selectedPath || !topicPrefix || !selectedPath.startsWith(`${topicPrefix}/`)) return
    const relativeDirectories = selectedPath.slice(topicPrefix.length + 1).split('/').slice(0, -1)
    if (!relativeDirectories.length) return
    const ancestors = Object.fromEntries(relativeDirectories.map((_, position) => [relativeDirectories.slice(0, position + 1).join('/'), true]))
    setExpanded(current => ({ ...current, ...ancestors }))
  }, [selectedPath, topicPrefix])

  React.useEffect(() => {
    if (!targetHash) {
      noteReaderRef.current?.scrollTo({ top: 0 })
      return undefined
    }

    const clean = decodeURIComponent(targetHash).replace(/^#/, '').trim()
    const match = findTargetHeading(headings, clean)
    const targetId = match ? match.id : clean

    const attemptScroll = (retries = 8) => {
      const el = document.getElementById(targetId) ||
                 document.getElementById(slug(clean)) ||
                 noteReaderRef.current?.querySelector(`[id*="${clean}"]`)

      if (el) {
        uncollapseTargetIfNeeded(el)
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        el.classList.add('notes-target-heading-highlight')
        setTimeout(() => el.classList.remove('notes-target-heading-highlight'), 2400)
      } else if (retries > 0) {
        setTimeout(() => attemptScroll(retries - 1), 60)
      }
    }

    const timer = setTimeout(() => attemptScroll(8), 60)
    return () => clearTimeout(timer)
  }, [selectedPath, targetHash, headings])

  const selectNote = React.useCallback((path, { keepMobilePanel = false, hash = '' } = {}) => {
    setLastOpenPath(repositoryId, path, index?.root_path || '')
    setSearchParams({ repo: repositoryId, path })
    setTargetHash(hash || '')
    if (!keepMobilePanel) setMobilePanel(null)
  }, [repositoryId, index?.root_path, setSearchParams])

  const handleOpenRepo = React.useCallback((targetRepoOrId) => {
    const targetRepoId = typeof targetRepoOrId === 'object' ? targetRepoOrId?.id : targetRepoOrId
    if (!targetRepoId || typeof targetRepoId !== 'string') return
    const lastPath = getLastOpenPath(targetRepoId)
    if (lastPath) {
      setSearchParams({ repo: targetRepoId, path: lastPath })
    } else {
      setSearchParams({ repo: targetRepoId })
    }
    setMobilePanel(null)
  }, [setSearchParams])

  const openPreviewLink = React.useCallback(descriptor => {
    if (!descriptor?.url) return
    if (descriptor.type === 'excalidraw') {
      setExcalidrawModal(descriptor)
      return
    }
    if (!supportsDrawerPreview(descriptor)) { openInNewTab(descriptor.url); return }
    setLinkPreviewHistory([])
    setLinkPreview(descriptor)
  }, [])

  const titleNavigation = React.useMemo(() => (
    (previousNote || nextNote) ? { previousNote, nextNote, onNavigate: selectNote } : null
  ), [previousNote, nextNote, selectNote])

  const followPreviewLink = descriptor => {
    if (!descriptor?.url) return
    if (!supportsDrawerPreview(descriptor)) { openInNewTab(descriptor.url); return }
    setLinkPreviewHistory(current => linkPreview ? [...current, linkPreview] : current)
    setLinkPreview(descriptor)
  }
  const closeLinkPreview = () => { setLinkPreview(null); setLinkPreviewHistory([]) }
  const goBackInPreview = () => {
    if (!linkPreviewHistory.length) return
    setLinkPreview(linkPreviewHistory[linkPreviewHistory.length - 1])
    setLinkPreviewHistory(current => current.slice(0, -1))
  }
  const jumpToPreviewedNote = (path, hash) => { closeLinkPreview(); selectNote(path, { hash }) }
  const chooseFirst = (candidates, options) => { if (candidates.length) selectNote([...candidates].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))[0].path, options) }
  const keepMobileLibraryOpen = isMobile && mobilePanel === 'library'
  const selectYear = year => {
    const candidateNotes = allNotes.filter(item => taxonomy(item, index.root_path || '').year === year)
    const candidatePaths = new Set(candidateNotes.map(n => n.path))
    const savedPath = getLastOpenPath(repositoryId, `year:${year}`)
    if (savedPath && candidatePaths.has(savedPath)) {
      selectNote(savedPath, { keepMobilePanel: keepMobileLibraryOpen })
    } else {
      chooseFirst(candidateNotes, { keepMobilePanel: keepMobileLibraryOpen })
    }
  }
  const selectTopic = topic => {
    const candidateNotes = yearNotes.filter(item => taxonomy(item, index.root_path || '').topic === topic)
    const candidatePaths = new Set(candidateNotes.map(n => n.path))
    const savedPath = getLastOpenPath(repositoryId, topic)
    if (savedPath && candidatePaths.has(savedPath)) {
      selectNote(savedPath, { keepMobilePanel: keepMobileLibraryOpen })
    } else {
      chooseFirst(candidateNotes, { keepMobilePanel: keepMobileLibraryOpen })
    }
  }
  const navigateBreadcrumb = parts => {
    if (parts.length === 0) {
      if (years.length > 0) selectYear(years[0])
      return
    }
    if (parts.length === 1) return selectYear(parts[0])
    if (parts.length === 2) return selectTopic(parts[1])
    const directoryPath = parts.slice(2).join('/')
    const segments = directoryPath.split('/')
    setExpanded(current => ({ ...current, ...Object.fromEntries(segments.map((_, position) => [segments.slice(0, position + 1).join('/'), true])) }))
    window.requestAnimationFrame(() => { const target = [...document.querySelectorAll('[data-tree-path]')].find(element => element.dataset.treePath === directoryPath); target?.scrollIntoView({ behavior: 'smooth', block: 'center' }); target?.focus({ preventScroll: true }) })
  }

  if (!repositoryId) return <RepositoryCards repositories={repositories} loading={loadingCatalog} onOpen={handleOpenRepo} />

  const currentRepository = repositories.find(item => item.id === repositoryId)
  const allExpanded = allTreePaths.length > 0 && allTreePaths.every(path => expanded[path] === true)
  const selectNoteSource = source => {
    if (source === 'local' && !currentRepository?.local_available) return
    localStorage.setItem(`learning-notes-source:${repositoryId}`, source)
    setNoteSource(source)
  }

  return <div className={`notes-page ${showNavigation ? '' : 'navigation-hidden'}`} style={repositoryStyle(repositoryId)}>
    <header className="notes-reader-header">
      <button type="button" className="notes-nav-reveal notes-desktop-nav-toggle" onClick={() => setShowNavigation(value => !value)} aria-controls="notes-topic-navigation" aria-expanded={showNavigation} title={showNavigation ? 'Hide notes navigation' : 'Show notes navigation'} aria-label={showNavigation ? 'Hide notes navigation' : 'Show notes navigation'}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d={showNavigation ? 'm7 9-3 3 3 3' : 'm5 9 3 3-3 3'}/></svg></button>
      <Breadcrumbs index={index} selectedPath={selectedPath} onDirectory={navigateBreadcrumb} repositories={repositories} selectedRepository={currentRepository} onSelectRepository={handleOpenRepo} />
      {note && (
        <div
          className="notes-reader-reading-badge"
          title={`${readingStats.words.toLocaleString()} words · ${readingStats.technicalCount ? `${readingStats.technicalCount} code/diagram blocks · ` : ''}${Math.round(readingProgress)}% read`}
        >
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
          </svg>
          <span className="notes-reader-reading-time">{readingStats.text}</span>
          <span className="notes-badge-divider" aria-hidden="true">·</span>
          <span className="notes-reader-reading-words">{readingStats.words.toLocaleString()} words</span>
          {readingProgress > 5 && (
            <span className="notes-reading-remaining-pill">
              {readingProgress >= 98 ? 'Finished' : `${Math.max(1, Math.ceil(readingStats.minutes * (1 - readingProgress / 100)))}m left`}
            </span>
          )}
        </div>
      )}
      <NoteSourceStatus source={noteSource} onRefresh={() => setSourceRevision(value => value + 1)} />
      <div className="notes-mobile-header-actions"><button type="button" onClick={() => { setShowNavigation(true); setMobilePanel('library') }} aria-label="Open notes library" title="Notes library"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M6 8h0M6 12h0"/></svg></button><button type="button" onClick={() => setMobilePanel('outline')} aria-label="Open page outline" title="On this page"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg></button></div>
      {note && (
        <div className="notes-reading-progress-track" aria-hidden="true">
          <div className="notes-reading-progress-fill" style={{ width: `${readingProgress}%` }} />
        </div>
      )}
    </header>
    <DismissibleError message={error} />
    <div
      className={`notes-layout ${isResizing ? 'is-resizing' : ''}`}
      style={{
        '--notes-left-width': `${leftPanel.width}px`,
        '--notes-right-width': `${rightPanel.width}px`,
        gridTemplateColumns: isMobile
          ? undefined
          : showNavigation
            ? `${leftPanel.width}px minmax(360px, 1fr) ${rightPanel.width}px`
            : `0 minmax(360px, 1fr) ${rightPanel.width}px`,
      }}
    >
      <aside ref={navigationRef} id="notes-topic-navigation" className={`notes-browser ${mobilePanel === 'library' ? 'mobile-open' : ''}`} aria-label="Repository topics" aria-hidden={!showNavigation || (isMobile && mobilePanel !== 'library')}>
        {isMobile && (
          <div className="notes-browser-header">
            <span className="notes-browser-mobile-title">Topics</span>
            <button type="button" className="notes-mobile-drawer-close" onClick={() => setMobilePanel(null)} aria-label="Close notes library">×</button>
          </div>
        )}
        <div className="notes-tree-toolbar">
          <div className="notes-search-wrapper">
            <div className="notes-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search topics and notes…" aria-label="Search this repository" />{normalizedQuery && <><small className="notes-search-count">{yearFilteredNotes.length}</small><button type="button" className="notes-search-clear" onClick={() => setQuery('')} aria-label="Clear notes search">×</button></>}</div>
            {currentRepository?.local_available && <NoteSourceToggle source={noteSource} onChange={selectNoteSource}/>}
          </div>
          <YearDropdown selectedYear={selectedYear} onSelect={selectYear} options={years.map(year => ({ value: year, label: displayName(year) }))}/>
          <TopicDropdown selectedTopic={selectedTopic} onSelect={selectTopic} options={topics.map(topic => ({ value: topic, label: displayName(topic) }))}/>
        </div>
        <div className="notes-tree-browser">
          <nav className="notes-list" aria-label={`${selectedTopic} notes`}><div className="notes-pane-label"><span><b>{displayName(selectedTopic)}</b><small>Subtopics and notes</small></span><span className="notes-pane-actions"><button type="button" onClick={() => setExpanded(Object.fromEntries(allTreePaths.map(path => [path, !allExpanded])))} title={allExpanded ? 'Collapse all subtopics' : 'Expand all subtopics'} aria-label={allExpanded ? 'Collapse all subtopics' : 'Expand all subtopics'} aria-pressed={allExpanded}><svg viewBox="0 0 24 24" aria-hidden="true">{allExpanded ? <path d="M9 9H4V4m11 5h5V4M9 15H4v5m11-5h5v5M4 9l5-5m11 5-5-5M4 15l5 5m11-5-5 5"/> : <path d="M8 3H3v5m13-5h5v5M8 21H3v-5m13 5h5v-5M3 8l5-5m13 5-5-5M3 16l5 5m13-5-5 5"/>}</svg></button><em>{topicNotes.length}</em></span></div>{!loadingIndex && <NoteTree node={tree} selectedPath={selectedPath} activeDirectories={activeDirectories} expanded={expanded} onToggle={path => setExpanded(current => ({ ...current, [path]: !current[path] }))} onSelect={selectNote} />}{!loadingIndex && !topicNotes.length && <p className="notes-empty">No notes match this search in {displayName(selectedTopic)}.</p>}</nav>
        </div>
        {!isMobile && showNavigation && (
          <PanelSplitter
            direction="left"
            isResizing={leftPanel.isResizing}
            onPointerDown={leftPanel.handlePointerDown}
            onDoubleClick={leftPanel.handleDoubleClick}
            label="Drag to resize navigation panel (Double-click to reset)"
          />
        )}
      </aside>
      <main ref={noteReaderRef} className="note-reader">
        {loadingNote ? (
          <div className="note-reader-status"><span className="spinner" /> Loading note…</div>
        ) : note ? (
          <>
            <article className="markdown-body">
              <MarkdownContent note={note} headings={headings} index={index} onOpenLink={openPreviewLink} onOpenCodeModal={setCodeModal} titleNavigation={titleNavigation} />
            </article>
            <NotePageNavigation previousNote={previousNote} nextNote={nextNote} rootPath={index?.root_path || ''} onNavigate={selectNote}/>
            {showScrollTop && (
              <button
                type="button"
                className="notes-scroll-top-btn"
                onClick={() => noteReaderRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
                title={`Back to top (${Math.round(readingProgress)}% read)`}
                aria-label="Scroll back to top"
              >
                <svg viewBox="0 0 36 36" className="notes-scroll-progress-ring" aria-hidden="true">
                  <circle className="notes-scroll-ring-bg" cx="18" cy="18" r="15" />
                  <circle
                    className="notes-scroll-ring-fill"
                    cx="18"
                    cy="18"
                    r="15"
                    strokeDasharray="94.2"
                    strokeDashoffset={94.2 - (94.2 * readingProgress) / 100}
                  />
                </svg>
                <span className="notes-scroll-top-arrow" aria-hidden="true">↑</span>
              </button>
            )}
          </>
        ) : (
          <div className="note-reader-status">Choose a note to start reading.</div>
        )}
      </main>
      <OnThisPage
        note={note}
        headings={headings}
        readingStats={readingStats}
        scrollContainerRef={noteReaderRef}
        isMobile={isMobile}
        mobileOpen={mobilePanel === 'outline'}
        onMobileClose={() => setMobilePanel(null)}
        onPresent={() => setPresentationMode(true)}
        splitter={
          !isMobile && (
            <PanelSplitter
              direction="right"
              isResizing={rightPanel.isResizing}
              onPointerDown={rightPanel.handlePointerDown}
              onDoubleClick={rightPanel.handleDoubleClick}
              label="Drag to resize outline panel (Double-click to reset)"
            />
          )
        }
      />
    </div>
    {isMobile && mobilePanel && <button type="button" className="notes-mobile-backdrop" onClick={() => setMobilePanel(null)} aria-label="Close mobile navigation" />}
    <LinkPreviewDrawer preview={linkPreview} repositoryId={repositoryId} source={noteSource} index={index} onClose={closeLinkPreview} onNavigate={jumpToPreviewedNote} onPreviewLink={followPreviewLink} canGoBack={linkPreviewHistory.length > 0} onBack={goBackInPreview}/>
    <ExcalidrawDialog modal={excalidrawModal} onClose={() => setExcalidrawModal(null)} />
    <CodeViewerDialog modal={codeModal} onClose={() => setCodeModal(null)} />
    {presentationMode && note && (
      <NotePresentationMode
        note={note}
        index={index}
        repository={currentRepository}
        onOpenLink={openPreviewLink}
        onClose={() => setPresentationMode(false)}
      />
    )}
  </div>
}
