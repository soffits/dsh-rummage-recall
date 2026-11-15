window.__ModuleLoader__.load({
  id: '@soffits/dsh-rummage-recall',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** Locale namespace, Chat node kind and Host source kind of the leads message. */
    const NS = 'rummage-recall'
    const KIND = 'rummage-recall'
    /** The Host's log-only record of a recall that added nothing. */
    const RECORD_TYPE = 'plugin:rummage-recall/outcome'

    const en = {
      title: 'rummage recall',
      leads: '{n} leads',
      lead: '1 lead',
      noMatch: 'no plausible match',
      timeout: 'skipped: timeout',
      error: 'skipped: error',
      injected: 'Added to the message',
    }
    const zh = {
      title: 'rummage 回忆',
      leads: '{n} 条线索',
      lead: '1 条线索',
      noMatch: '没有相关的',
      timeout: '已跳过：超时',
      error: '已跳过：出错',
      injected: '附在消息后的内容',
    }

    // -------------------------------------------------------------------------------------------
    // Chat Definition: the leads message and the record of a skipped recall become one row each
    // among the turn's work rows, like a tool call. The model's copy of the leads is unchanged; the
    // record is log-only and never reaches a model.

    function matchLead(event) {
      if (event?.type !== 'user/message' || event.surfaceOp !== 'append') return null
      const data = event.data
      if (data === null || typeof data !== 'object' || data.source?.kind !== KIND) return null
      return { id: String(data.id), role: 'start', exclusive: true }
    }

    function matchRecord(event) {
      if (event?.type !== RECORD_TYPE || event.data === null || typeof event.data !== 'object') return null
      return { id: `${RECORD_TYPE}:${event.seq}`, role: 'start', exclusive: true }
    }

    function textOf(content) {
      return (Array.isArray(content) ? content : [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
    }

    function num(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : null
    }

    /**
     * Row state from the matched event.
     * @returns {{ seq: number, time: number, outcome: 'leads' | 'no-match' | 'timeout' | 'error', leads: number | null, durationMs: number | null, text: string }}
     */
    function readEvent(event) {
      if (event.type === RECORD_TYPE) {
        const reason = event.data.reason
        return {
          seq: event.seq,
          time: event.time,
          outcome: reason === 'timeout' || reason === 'error' ? reason : 'no-match',
          leads: null,
          durationMs: num(event.data.durationMs),
          text: typeof event.data.detail === 'string' ? event.data.detail : '',
        }
      }
      const source = event.data.source ?? {}
      return {
        seq: event.seq,
        time: event.time,
        outcome: 'leads',
        leads: num(source.leads),
        durationMs: num(source.durationMs),
        text: textOf(event.data.content),
      }
    }

    const definition = {
      kind: KIND,
      target: 'chat',
      match: { 'user/message': matchLead, [RECORD_TYPE]: matchRecord },
      start: (_context, match) => readEvent(match.event),
      update: (context) => context.state,
      buildViewNode: (context) => {
        if (context.state === undefined) return null
        const location = context.start?.location ?? context.matches?.[0]?.location ?? { kind: 'unresolved' }
        return {
          key: context.key,
          kind: KIND,
          id: context.id,
          target: 'chat',
          anchorSeq: context.state.seq,
          location,
          visibility: 'visible',
          // In the turn's process disclosure, outside step runs: a step run of its own would fold
          // the row under a generic "Analysis completed" header.
          groupTree: 'process',
          data: context.state,
        }
      },
    }

    /** The words after the title: "3 leads · 180 ms", "no plausible match · 420 ms". */
    function rowSummary(data, t) {
      const parts = []
      if (data.outcome === 'leads') {
        if (data.leads === 1) parts.push(t('lead'))
        else if (data.leads !== null && data.leads > 0) parts.push(t('leads').replace('{n}', String(data.leads)))
      } else if (data.outcome === 'timeout') parts.push(t('timeout'))
      else if (data.outcome === 'error') parts.push(t('error'))
      else parts.push(t('noMatch'))
      if (data.durationMs !== null) parts.push(`${Math.round(data.durationMs)} ms`)
      return parts.join(' · ')
    }

    // -------------------------------------------------------------------------------------------
    // The row. Markup and styles follow the host's tool rows (the skill row), under this plugin's
    // prefix; only theme tokens are shared.

    const svgProps = { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }

    function RecallIcon() {
      return h('svg', svgProps,
        h('circle', { cx: 7, cy: 7, r: 4.25 }),
        h('path', { d: 'M10.2 10.2 13.5 13.5' }),
        h('path', { d: 'M5.4 7h3.2M7 5.4v3.2' }))
    }

    function ChevronIcon() {
      return h('svg', svgProps, h('path', { d: 'M4 6.5 8 10.5 12 6.5' }))
    }

    function RecallRow(props) {
      const { node, t } = props
      const data = node.data
      const [open, setOpen] = React.useState(false)
      const expandable = data.text.length > 0
      const shown = open && expandable
      const toggle = () => setOpen((value) => !value)
      const onKeyDown = (event) => {
        if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) return
        event.preventDefault()
        toggle()
      }
      const leading = shown
        ? h(ChevronIcon)
        : expandable
          ? [h('span', { key: 'idle', className: 'drr-iconIdle' }, h(RecallIcon)), h('span', { key: 'hover', className: 'drr-chevronHover' }, h(ChevronIcon))]
          : h(RecallIcon)
      const summaryClass = data.outcome === 'error' ? 'drr-summary drr-error' : data.outcome === 'timeout' ? 'drr-summary drr-warn' : 'drr-summary'
      return h(
        'div',
        { className: 'drr-card', 'data-rummage-recall': data.outcome },
        h(
          'div',
          {
            className: 'drr-row',
            ...(expandable ? { role: 'button', tabIndex: 0, 'aria-expanded': shown, 'data-expandable': true, onClick: toggle, onKeyDown } : {}),
          },
          h('span', { className: 'drr-leading' }, leading),
          h('span', { className: 'drr-title' }, t('title')),
          h('span', { className: 'drr-separator', 'aria-hidden': true }),
          h('span', { className: summaryClass }, rowSummary(data, t)),
        ),
        shown
          ? h(
              'div',
              { className: 'drr-detailCard' },
              data.outcome === 'leads' ? h('div', { className: 'drr-detailHeader' }, t('injected')) : null,
              h('pre', { className: 'drr-detail' }, data.text),
            )
          : null,
      )
    }

    const CSS = `
.drr-card{display:flex;flex-direction:column}
.drr-row{height:calc(24px + var(--dsh-content-font-delta,0px));min-width:0;color:var(--dsw-alias-label-tertiary);align-items:center;transition:color .1s;display:flex;position:relative;overflow:hidden}
.drr-row:hover{color:var(--dsw-alias-label-secondary)}
.drr-row[data-expandable]{cursor:pointer}
.drr-leading{width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px));color:inherit;flex:none;justify-content:center;align-items:center;margin-right:6px;display:inline-flex;position:relative}
.drr-leading svg{width:calc(14px + var(--dsh-content-font-delta,0px));height:calc(14px + var(--dsh-content-font-delta,0px))}
.drr-iconIdle{opacity:1;transition:opacity .1s;display:inline-flex}
.drr-chevronHover{opacity:0;margin:auto;transition:opacity .1s;position:absolute;inset:0;display:inline-flex;justify-content:center;align-items:center}
.drr-row:hover .drr-iconIdle{opacity:0}
.drr-row:hover .drr-chevronHover{opacity:1}
.drr-title{font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));flex:none}
.drr-separator{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}
.drr-summary{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));flex:auto;overflow:hidden}
.drr-error{color:var(--dsw-alias-state-error-primary)}
.drr-warn{color:var(--dsw-alias-state-warn-label)}
.drr-detailCard{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);flex-direction:column;max-height:320px;margin:4px 0 4px 4px;display:flex;overflow:hidden}
.drr-detailHeader{border-bottom:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-markdown-code-block-banner);color:var(--dsw-alias-label-caption);text-transform:uppercase;letter-spacing:.04em;flex:none;padding:8px 12px;font-size:11px;font-weight:500;line-height:16px}
.drr-detail{white-space:pre-wrap;overflow-wrap:anywhere;min-height:0;font:var(--dsw-font-markdown-code-block-small);color:var(--dsw-alias-label-secondary);margin:0;padding:10px 12px 12px;overflow:auto}
@media (prefers-reduced-motion:reduce){.drr-row,.drr-iconIdle,.drr-chevronHover{transition:none}}
`

    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => {
        const offEn = ctx.locale.register(NS, 'en', en)
        const offZh = ctx.locale.register(NS, 'zh', zh)
        return () => {
          offZh()
          offEn()
        }
      }, 'dsh-rummage-recall: dictionaries')
      if (typeof document !== 'undefined') {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = '@soffits/dsh-rummage-recall'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'dsh-rummage-recall: row styles')
      }
      // A client without the transcript has no uiConversation; nothing to draw there.
      ctx.inject(['uiConversation'], (scope) => {
        scope.uiConversation.events.register(definition)
      })
      ctx.slots.inject('conversation.chat.node', () =>
        ctx.slots.register({ name: 'conversation.chat.node', key: KIND, locale: NS }, RecallRow),
      )
    }

    exports.NS = NS
    exports.apply = apply
    exports.inject = inject
    exports.definition = definition
    exports.readEvent = readEvent
    exports.rowSummary = rowSummary
    exports.RecallRow = RecallRow
    exports.en = en
    exports.zh = zh
    return module.exports
  },
})
