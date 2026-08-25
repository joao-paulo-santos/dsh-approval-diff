/**
 * dsh-approval-diff — host half (v0.6 route; v0.17 keeps exactly one route).
 *
 * One loopback surface backs the browser review card with DISK TRUTH,
 * gathered at approval time with zero model involvement:
 *
 *   GET /approval-diff/context?path=<absolute path>
 *     -> { path, content, truncated }   (text content, capped at 1 MiB)
 *     -> 4xx/5xx { error }              (missing/unreadable/non-text)
 *
 * History: v0.14 added an observed-state mirror, v0.15 removed it (approval-
 * first owns never-observed at the source), v0.16 briefly sketched an
 * "askable" probe route, and v0.17 deleted the idea entirely — the card now
 * reviews ONE file at a time (the pending call's contiguous same-file run),
 * so no queued-sibling prediction surface exists at all. See the v0.17
 * README section here.
 *
 * Trust model: identical to the other loopback routes (/api, /plugins) — the
 * page is local-first; the route serves file CONTENT, so it is documented in
 * the README as a loopback file-read surface capped at text ≤ 1 MiB.
 */

export const name = 'approval-diff'

/** Hard dependencies: the fs service (read face) and the web server. */
export const inject = ['fs', 'webServer']

/** Content cap: 1 MiB of text is far beyond any reviewable file window. */
const CONTENT_LIMIT = 1024 * 1024

export function apply(ctx) {
  const fs = ctx.fs
  const webServer = ctx.webServer

  const sendJson = (res, status, body) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }

  const disposeContextRoute = webServer.register({
    kind: 'exact',
    path: '/approval-diff/context',
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET required' })
        const url = new URL(req.url, 'http://localhost')
        const requestedPath = url.searchParams.get('path') ?? ''
        if (requestedPath.trim() === '') return sendJson(res, 400, { error: 'path query parameter required' })
        const target = await fs.resolve(requestedPath)
        const content = await fs.readText(target)
        const truncated = content.length > CONTENT_LIMIT
        sendJson(res, 200, {
          path: target.displayPath,
          content: truncated ? content.slice(0, CONTENT_LIMIT) : content,
          truncated,
        })
      } catch (error) {
        sendJson(res, 404, {
          error: error !== null && typeof error === 'object' && typeof error.message === 'string'
            ? error.message
            : String(error),
        })
      }
    },
  })

  return () => {
    try { disposeContextRoute() } catch (e) {}
  }
}
