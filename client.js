/**
 * Agnes 生图工具 —— 浏览器侧。
 *
 * 设置入口：注册到 `plugins.row.config` 的 `<包名>#<行 id>` 键上。
 * DSH 的 Plugins 页面会为这一行显示「配置」控件，点开就是这个页面；
 * 页面拿到 plugin-manager 注入的 `form`（{ state, mutate }），负责草稿与保存按钮。
 *
 * 安全：API Key 使用 schemastery 的 secret 角色，Host 的 settings.describe 不会把它下发到浏览器，
 * 所以这里只能「写」不能「读回」；输入框为 password，且始终不回显已保存的值。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-agnes-image',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'agnesImage'

    /** 中文词条（默认）。 */
    const zh = {
      summary: '配置 Agnes API Key，供 AI 在对话中生成/编辑图片。',
      title: 'Agnes 生图',
      intro: 'AI 在对话中调用 agnes_image 工具时使用这里的配置。API Key 只保存在本机。',
      keyLabel: 'Agnes API Key',
      keyPlaceholder: '粘贴你的 API Key（已保存的值不会回显，留空即保持不变）',
      keyHint: '仅本机保存，界面遮罩、不写日志；留空会回退到环境变量 AGNES_API_KEY。',
      keySet: '已保存 Key（无法回显）。留空表示保持不变。',
      keyUnset: '尚未保存 Key。填入后点「保存配置」。',
      baseURLLabel: 'Base URL',
      baseURLHint: '默认官方地址；如果你走自建代理再改这里。',
      timeoutLabel: '请求超时（秒）',
      timeoutHint: '官方建议 60–360 秒；生成复杂大图时更慢。',
      saveDirLabel: '另存目录（可选）',
      saveDirHint: '填写本机绝对路径后，生成的图片会额外保存一份；留空则只保存在会话附件里。',
      save: '保存配置',
      saving: '保存中…',
      saved: '已保存，下一次调用 AI 就会用新配置。',
      saveFailed: '保存失败，请检查输入或稍后重试。',
      nothing: '没有需要保存的改动。',
      clearKey: '清除已保存的 Key',
      clearing: '清除中…',
      cleared: '已清除本机保存的 Key。',
      notWritable: '当前配置不可写（可能被上层配置锁定）。',
      loading: '正在读取配置…',
      noForm: '该插件还没有配置项，或 Host 尚未提供 settings 命名空间。',
      invalidTimeout: '超时需在 60 到 360 秒之间。',
      helpTitle: 'AI 会这样用',
      helpText:
        '文生图只需 prompt（默认 2K，1:1）；要 16:9 就传 size:"2K", ratio:"16:9"。' +
        '图生图/多图合成需要提供公共 HTTPS 图片链接或 Data URI Base64，并在 prompt 里说明改了哪里、保留哪里。',
    }

    /** 英文词条。 */
    const en = {
      summary: 'Configure the Agnes API key used by the AI image tool.',
      title: 'Agnes Image',
      intro: 'The AI uses this configuration when it calls the agnes_image tool. The key stays on this machine.',
      keyLabel: 'Agnes API Key',
      keyPlaceholder: 'Paste your API key (saved values are never shown; leave blank to keep the current one)',
      keyHint: 'Stored locally, masked and never logged. Leave blank to fall back to the AGNES_API_KEY environment variable.',
      keySet: 'A key is saved (it cannot be shown). Leave blank to keep it unchanged.',
      keyUnset: 'No key saved yet. Paste one and press Save.',
      baseURLLabel: 'Base URL',
      baseURLHint: 'Official endpoint by default; change it only if you use a proxy.',
      timeoutLabel: 'Request timeout (seconds)',
      timeoutHint: 'The docs recommend 60–360 seconds; large images can take a while.',
      saveDirLabel: 'Extra save directory (optional)',
      saveDirHint: 'An absolute local path receives a copy of every generated image; leave blank to keep only session attachments.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved. The next tool call uses the new configuration.',
      saveFailed: 'Save failed. Check the fields and try again.',
      nothing: 'Nothing to save.',
      clearKey: 'Clear saved key',
      clearing: 'Clearing…',
      cleared: 'The locally saved key was cleared.',
      notWritable: 'This configuration is not writable (it may be locked by a parent configuration).',
      loading: 'Loading configuration…',
      noForm: 'This plugin has no editable configuration, or the Host does not expose its settings namespace yet.',
      invalidTimeout: 'Timeout must be between 60 and 360 seconds.',
      helpTitle: 'How the AI uses it',
      helpText:
        'Text to image needs only a prompt (2K, 1:1 by default); pass size:"2K", ratio:"16:9" for widescreen. ' +
        'Image editing and multi-image composition need public HTTPS image URLs or data URIs, plus a prompt that says what to change and what to keep.',
    }

    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '8px 10px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border, rgba(128,128,128,.45))',
      background: 'var(--dsw-alias-bg-base, transparent)',
      color: 'var(--dsw-alias-text-primary, inherit)',
      font: 'inherit',
      fontSize: 14,
    }

    const labelStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      marginBottom: 14,
      fontSize: 13,
      color: 'var(--dsw-alias-text-primary, inherit)',
    }

    const hintStyle = {
      fontSize: 12,
      lineHeight: 1.5,
      color: 'var(--dsw-alias-text-secondary, rgba(128,128,128,.95))',
    }

    const buttonStyle = {
      padding: '7px 14px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border, rgba(128,128,128,.45))',
      background: 'var(--dsw-alias-bg-elevated, transparent)',
      color: 'var(--dsw-alias-text-primary, inherit)',
      font: 'inherit',
      fontSize: 13,
      cursor: 'pointer',
    }

    /** 把毫秒输入夹到 60–360 秒。 */
    function clampSeconds(text) {
      const value = Number(text)
      if (!Number.isFinite(value)) return undefined
      const seconds = Math.round(value)
      if (seconds < 60 || seconds > 360) return undefined
      return seconds
    }

    /**
     * 归一化两种表单句柄：
     *  - plugin-manager 注入的 `{ state, mutate }`（行 id 与 settings 命名空间一致时）；
     *  - `configForms.get(ns)` 返回的控制器（`getSnapshot()` + `mutate()`），用作兜底。
     */
    function normalizeForm(raw) {
      if (!raw) return undefined
      if (raw.state !== undefined) {
        return { state: raw.state, mutate: (ops, revision) => raw.mutate(ops, revision) }
      }
      if (typeof raw.getSnapshot === 'function' && typeof raw.mutate === 'function') {
        return {
          state: raw.getSnapshot(),
          mutate: (ops, revision) => raw.mutate(ops, revision),
        }
      }
      return undefined
    }

    /**
     * 兜底查找本插件的 settings 命名空间：bundle 行 id 与 Loader entry id 在某些组合下
     * 会带 `include:` 前缀，这里按候选名匹配已经由 Host 提供的命名空间。
     */
    function findOwnForm(ctx) {
      try {
        const forms = ctx && typeof ctx.get === 'function' ? ctx.get('configForms') : undefined
        if (!forms || typeof forms.describe !== 'function') return undefined
        const mirror = forms.describe()
        const snapshot = mirror && typeof mirror.getSnapshot === 'function' ? mirror.getSnapshot() : undefined
        const namespaces = (snapshot && snapshot.view && snapshot.view.namespaces) || []
        const ids = namespaces.map((entry) => entry && entry.ns).filter((ns) => typeof ns === 'string')
        const wanted = ['include:agnes-image', 'agnes-image', '@local/dsh-agnes-image']
        const hit =
          wanted.find((ns) => ids.includes(ns)) ||
          ids.find((ns) => ns.endsWith('/dsh-agnes-image')) ||
          ids.find((ns) => ns.endsWith('agnes-image'))
        return hit ? normalizeForm(forms.get(hit)) : undefined
      } catch {
        return undefined
      }
    }

    /**
     * 行详情页：写-only 的 API Key + Base URL + 超时 + 可选另存目录。
     * @param {{ t: Function, form?: object, view?: string, ctx?: object }} props
     */
    function ConfigPage(props) {
      const t = props.t
      const form = normalizeForm(props.form) || findOwnForm(props.ctx)
      const state = form ? form.state : undefined
      const value = (state && state.value) || {}

      const [apiKey, setApiKey] = React.useState('')
      const [baseURL, setBaseURL] = React.useState('')
      const [timeoutSeconds, setTimeoutSeconds] = React.useState('180')
      const [saveDirectory, setSaveDirectory] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)

      // 配置是异步读到的：每当 Host 侧 revision 变化，就用最新值重置草稿。
      const revision = state ? state.revision : undefined
      React.useEffect(() => {
        const next = (state && state.value) || {}
        setBaseURL(typeof next.baseURL === 'string' ? next.baseURL : 'https://api.agnes-ai.cn/v1')
        const seconds = Number(next.timeoutMs)
        setTimeoutSeconds(Number.isFinite(seconds) ? String(Math.round(seconds / 1000)) : '180')
        setSaveDirectory(typeof next.saveDirectory === 'string' ? next.saveDirectory : '')
        setApiKey('')
        setNotice(null)
      }, [revision])

      if (!form || !state) {
        return h('p', { style: hintStyle }, state ? t('loading') : t('noForm'))
      }
      if (state.status === 'loading' && state.value === undefined) {
        return h('p', { style: hintStyle }, t('loading'))
      }

      const writable = state.writable !== false
      // secret 字段不会下发到浏览器，只能根据 describe() 的 secrets 标记判断「是否已保存」。
      const keySaved = (Array.isArray(state.secrets) ? state.secrets : []).some(
        (entry) => Array.isArray(entry.path) && entry.path.length === 1 && entry.path[0] === 'apiKey' && entry.set === true,
      )

      const save = async () => {
        const seconds = clampSeconds(timeoutSeconds)
        if (seconds === undefined) {
          setNotice({ kind: 'error', text: t('invalidTimeout') })
          return
        }
        const ops = []
        if (apiKey.trim().length > 0) ops.push({ op: 'set', path: ['apiKey'], value: apiKey.trim() })
        const currentBase = typeof value.baseURL === 'string' ? value.baseURL : ''
        if (baseURL.trim().length > 0 && baseURL.trim() !== currentBase) {
          ops.push({ op: 'set', path: ['baseURL'], value: baseURL.trim() })
        }
        if (Number(value.timeoutMs) !== seconds * 1000) {
          ops.push({ op: 'set', path: ['timeoutMs'], value: seconds * 1000 })
        }
        const currentDir = typeof value.saveDirectory === 'string' ? value.saveDirectory : ''
        if (saveDirectory.trim() !== currentDir) {
          ops.push({ op: 'set', path: ['saveDirectory'], value: saveDirectory.trim() })
        }
        if (ops.length === 0) {
          setNotice({ kind: 'info', text: t('nothing') })
          return
        }
        setBusy(true)
        try {
          const ok = await form.mutate(ops, state.revision)
          setNotice({ kind: ok ? 'ok' : 'error', text: ok ? t('saved') : t('saveFailed') })
          if (ok) setApiKey('')
        } catch {
          setNotice({ kind: 'error', text: t('saveFailed') })
        } finally {
          setBusy(false)
        }
      }

      const clearKey = async () => {
        setBusy(true)
        try {
          const ok = await form.mutate([{ op: 'unset', path: ['apiKey'] }], state.revision)
          setNotice({ kind: ok ? 'ok' : 'error', text: ok ? t('cleared') : t('saveFailed') })
        } catch {
          setNotice({ kind: 'error', text: t('saveFailed') })
        } finally {
          setBusy(false)
        }
      }

      const color = notice
        ? notice.kind === 'error'
          ? 'var(--dsw-alias-status-danger, #d64545)'
          : 'var(--dsw-alias-text-secondary, rgba(128,128,128,.95))'
        : undefined

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', maxWidth: 560 } },
        h('h3', { style: { margin: '0 0 6px', fontSize: 15 } }, t('title')),
        h('p', { style: { ...hintStyle, margin: '0 0 18px' } }, t('intro')),
        h(
          'label',
          { style: labelStyle },
          h('span', { style: { fontWeight: 600 } }, t('keyLabel')),
          h('input', {
            style: inputStyle,
            type: 'password',
            autoComplete: 'new-password',
            spellCheck: false,
            value: apiKey,
            disabled: !writable || busy,
            placeholder: t('keyPlaceholder'),
            onChange: (event) => setApiKey(event.target.value),
          }),
          h('span', { style: { ...hintStyle, fontWeight: 500 } }, keySaved ? t('keySet') : t('keyUnset')),
          h('span', { style: hintStyle }, t('keyHint')),
        ),
        h(
          'label',
          { style: labelStyle },
          h('span', { style: { fontWeight: 600 } }, t('baseURLLabel')),
          h('input', {
            style: inputStyle,
            type: 'url',
            spellCheck: false,
            value: baseURL,
            disabled: !writable || busy,
            onChange: (event) => setBaseURL(event.target.value),
          }),
          h('span', { style: hintStyle }, t('baseURLHint')),
        ),
        h(
          'label',
          { style: labelStyle },
          h('span', { style: { fontWeight: 600 } }, t('timeoutLabel')),
          h('input', {
            style: { ...inputStyle, maxWidth: 160 },
            type: 'number',
            min: 60,
            max: 360,
            step: 10,
            value: timeoutSeconds,
            disabled: !writable || busy,
            onChange: (event) => setTimeoutSeconds(event.target.value),
          }),
          h('span', { style: hintStyle }, t('timeoutHint')),
        ),
        h(
          'label',
          { style: labelStyle },
          h('span', { style: { fontWeight: 600 } }, t('saveDirLabel')),
          h('input', {
            style: inputStyle,
            type: 'text',
            spellCheck: false,
            value: saveDirectory,
            disabled: !writable || busy,
            onChange: (event) => setSaveDirectory(event.target.value),
          }),
          h('span', { style: hintStyle }, t('saveDirHint')),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 4 } },
          h(
            'button',
            { style: buttonStyle, disabled: !writable || busy, onClick: save, type: 'button' },
            busy ? t('saving') : t('save'),
          ),
          h(
            'button',
            { style: buttonStyle, disabled: !writable || busy, onClick: clearKey, type: 'button' },
            t('clearKey'),
          ),
        ),
        !writable ? h('p', { style: { ...hintStyle, marginTop: 10 } }, t('notWritable')) : null,
        notice ? h('p', { style: { ...hintStyle, marginTop: 10, color } }, notice.text) : null,
        h(
          'div',
          { style: { marginTop: 22, paddingTop: 14, borderTop: '1px solid var(--dsw-alias-border, rgba(128,128,128,.25))' } },
          h('p', { style: { ...hintStyle, fontWeight: 600, margin: '0 0 4px' } }, t('helpTitle')),
          h('p', { style: { ...hintStyle, margin: 0 } }, t('helpText')),
        ),
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agnes-image: dictionaries')
      ctx.slots.inject('plugins.row.config', () =>
        ctx.slots.register(
          {
            name: 'plugins.row.config',
            key: '@local/dsh-agnes-image#agnes-image',
            locale: NS,
            order: 20,
          },
          (props) =>
            props.view === 'summary'
              ? h('span', null, props.t('summary'))
              : h(ConfigPage, Object.assign({}, props, { ctx })),
        ),
      )
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
