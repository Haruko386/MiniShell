declare global {
    interface Window {
        go: {
            main: {
                App: {
                    Backend(): Promise<{ base: string; token: string }>;
                    ChooseDirectory(): Promise<string>;
                    ChooseFiles(): Promise<string[]>;
                    ChooseUploadDirectory(): Promise<string>;
                    SubmitUploadStreaming(session: string, remote: string, file: string, requestId: string): Promise<{
                        tasks: { id: string; name: string; size: number }[];
                        directories: number;
                        skipped: string[];
                        submissionError: string
                    }>;
                    SubmitDownload(session: string, remote: string, local: string): Promise<string>;
                    TransferStatus(id: string): Promise<{
                        status: string;
                        error: string;
                        transferredBytes: number;
                        totalBytes: number
                    }>
                }
            }
        };
        runtime: {
            OnFileDrop(callback: (x: number, y: number, paths: string[]) => void, useDropTarget: boolean): void;
            EventsOn(name: string, callback: (event: {
                requestId: string;
                task: { id: string; name: string; size: number }
            }) => void): () => void
        }
    }
}
let backend = {base: '', token: ''}
const desktop = () => window.go.main.App
import {Terminal} from '@xterm/xterm'
import {FitAddon} from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {createIcons, icons} from 'lucide'
import {joinPath, parentPath, parts} from './path'
import './style.css'

type Connection = { id: string; name: string; host: string; port: number; username: string; password?: string }
type Entry = { name: string; type: 'file' | 'directory'; size: number; modifiedAt: string }
type Transfer = {
    name: string;
    progress: number;
    status: string;
    error?: string;
    direction?: 'upload' | 'download';
    speed?: number;
    speedAt?: number
}
type HostKeyInfo = {
    host: string;
    port: number;
    keyType: string;
    fingerprint: string;
    changed: boolean;
    known: string[]
}
type ApiError = Error & { status?: number; data?: { message?: string; hostKey?: HostKeyInfo } }
const key = 'minishell.connections.v1'
let connections: Connection[] = JSON.parse(localStorage.getItem(key) || '[]')
let selected = connections[0]?.id || ''
let selectedFiles = new Set<string>()
let selectionAnchor = -1
let session = '', socket: WebSocket | undefined, currentPath = '/', entries: Entry[] = [], transfers: Transfer[] = []
let editingPath = false
let queueWidth = 300
let sideWidth = 264
let sideOpen = true
let connectionsOpen = true
let filesOpen = true
const app = document.querySelector<HTMLDivElement>('#app')!
window.addEventListener('wheel', event => {
    if (event.ctrlKey) event.preventDefault()
}, {passive: false})
const icon = (name: string, size = 15) => `<i data-lucide="${name}" width="${size}" height="${size}"></i>`
const paintIcons = () => createIcons({icons, attrs: {width: '15', height: '15'}})
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
}[c]!))

app.innerHTML = `<header class="topbar"><span class="logo">${icon('terminal')}</span><strong class="tab-label" id="crumb">新标签页</strong><span class="spacer"></span><button class="icon-button" id="theme" type="button" title="主题"></button><span class="top-status"><span class="status-dot"></span><span id="status">未连接</span></span></header><div class="shell"><button class="dock hidden" id="open-side" type="button" title="展开左侧">${icon('panel-left')}</button><aside class="sidebar" id="sidebar"><div class="side-resize" id="side-resize" title="拖动调整宽度，拖到最左收起"></div><div class="side-heading"><button class="icon-button" id="toggle-connections" title="收起连接">${icon('chevron-down')}</button><span id="connection-count">连接</span><button class="icon-button" id="add" title="新建连接">${icon('plus')}</button></div><div class="connection-list" id="connections"></div><div id="file-pane" class="hidden"><div class="side-heading"><button class="icon-button" id="toggle-files" title="收起文件">${icon('chevron-down')}</button><span class="file-heading" id="file-heading">文件</span><span class="heading-tools"><button class="icon-button" id="new-file" title="新建文件">${icon('file-plus')}</button><button class="icon-button" id="new-folder" title="新建目录">${icon('folder-plus')}</button><button class="icon-button" id="refresh" title="刷新">${icon('refresh-cw')}</button></span></div><div id="file-body"><div class="path-row"><div class="crumb" id="crumb-bar"></div><form class="path-edit hidden" id="path-form"><input id="path" aria-label="远程路径" spellcheck="false"></form><button class="icon-button" id="up" title="上一级">${icon('arrow-up')}</button></div><div id="dropzone"><div class="file-list" id="file-list"></div><div id="file-empty" class="file-empty"></div><div class="drop-overlay">${icon('upload', 22)}<strong>松开以上传文件或文件夹</strong></div></div><div class="side-footer"><span id="file-count">等待连接</span><span id="file-meta"></span></div></div></aside><main class="main"><section class="welcome" id="welcome"><div class="welcome-card"><span class="logo">${icon('server', 18)}</span><h1 id="welcome-title">选择一台服务器</h1><p id="welcome-copy">单击连接。一次只能保持一个会话。</p><div id="quick-rows"></div></div></section><section class="terminal-pane hidden" id="terminal-pane"><div id="terminal"></div></section></main><aside class="transfer-rail hidden" id="transfer-rail"><button class="icon-button" id="toggle-transfers" title="传输队列">${icon('arrow-up-down')}</button><span class="badge hidden" id="transfer-badge"></span></aside><aside class="queue hidden" id="queue"><div class="queue-resize" id="queue-resize" title="拖动调整宽度，双击收起"></div><div class="queue-head"><span id="transfer-summary">传输</span><span><button class="button" id="clear-done" type="button">清空完成</button><button class="icon-button" id="close-queue" title="收起">${icon('x')}</button></span></div><div class="transfers" id="transfers"></div></aside></div><dialog id="connection-dialog"><form id="connection-form" class="dialog-content"><div class="dialog-heading"><div><h2 id="dialog-title">新建连接</h2><p>填写服务器信息，保存后可随时连接。</p></div><button type="button" class="icon-button" id="close-dialog">${icon('x')}</button></div><label>连接名称<input name="name" required placeholder="例如：我的服务器" maxlength="80"></label><div class="form-row"><label>主机地址<input name="host" required placeholder="IP 地址或域名"></label><label>端口<input name="port" type="number" min="1" max="65535" required value="22"></label></div><label>用户名<input name="username" required placeholder="例如：root"></label><label>密码<input name="password" type="password" required autocomplete="current-password" placeholder="输入 SSH 密码"></label><p class="form-note">${icon('shield-alert')} 密码会明文保存在此浏览器中。</p><div class="dialog-actions"><button type="button" class="button" id="cancel-dialog">取消</button><button class="button primary">保存连接</button></div></form></dialog><div id="toast" role="status"></div>`

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!
type ThemeChoice = 'system' | 'light' | 'dark'
const themeKey = 'minishell.theme'
const themeQuery = window.matchMedia('(prefers-color-scheme: dark)')
let themeChoice: ThemeChoice = (localStorage.getItem(themeKey) as ThemeChoice) || 'system'
function themeDark() { return themeChoice === 'dark' || (themeChoice === 'system' && themeQuery.matches) }
function applyTheme() {
    document.documentElement.dataset.theme = themeDark() ? 'dark' : 'light'
    document.documentElement.dataset.themeChoice = themeChoice
    $('#theme').innerHTML = icon(themeChoice === 'dark' ? 'moon' : themeChoice === 'light' ? 'sun' : 'monitor')
    $('#theme').title = themeChoice === 'dark' ? '深色，点击切换为跟随系统' : themeChoice === 'light' ? '浅色，点击切换为深色' : '跟随系统，点击切换为浅色'
    paintIcons()
}
$('#theme').onclick = () => {
    themeChoice = themeChoice === 'system' ? 'light' : themeChoice === 'light' ? 'dark' : 'system'
    localStorage.setItem(themeKey, themeChoice)
    applyTheme()
}
themeQuery.addEventListener('change', () => { if (themeChoice === 'system') applyTheme() })
applyTheme()
$('#crumb').insertAdjacentHTML('afterend', '<div id="tabs"></div><button class="icon-button" id="new-terminal" title="新建终端">+</button>')
$('#add').insertAdjacentHTML('beforebegin', '<button class="icon-button" id="side-new-terminal" title="为当前连接新建终端">＋</button>')
type Tab = {
    id: string;
    connection: string;
    terminal: Terminal;
    fit: FitAddon;
    socket: WebSocket;
    element: HTMLElement;
    path: string
}
const tabs: Tab[] = []
const lastActiveTabs = new Map<string, string>()

function renderTabs() {
    $('#tabs').innerHTML = tabs.map(t => `<span class="terminal-tab ${t.id === session ? 'active' : ''}"><button data-tab="${esc(t.id)}">${esc(connections.find(c => c.id === t.connection)?.name || 'SSH')}</button><button data-close-tab="${esc(t.id)}" title="关闭">×</button></span>`).join('')
}

function activateTab(tab: Tab) {
    const previous = tabs.find(t => t.id === session)
    if (previous) previous.path = currentPath
    session = tab.id;
    selected = tab.connection;
    socket = tab.socket;
    currentPath = tab.path
    lastActiveTabs.set(tab.connection, tab.id)
    tabs.forEach(t => t.element.classList.toggle('hidden', t !== tab))
    selectedFiles.clear();
    selectionAnchor = -1;
    entries = []
    setConnected(true);
    renderTabs();
    renderFiles();
    void loadFiles(currentPath)
    requestAnimationFrame(() => {
        fitTerminal();
        tab.terminal.focus()
    })
}

function fitTerminal() {
    const tab = tabs.find(t => t.id === session)
    if (!tab) return
    tab.fit.fit()
    if (tab.socket.readyState === WebSocket.OPEN) tab.socket.send(JSON.stringify({
        type: 'resize',
        cols: tab.terminal.cols,
        rows: tab.terminal.rows
    }))
}

new ResizeObserver(fitTerminal).observe($('#terminal'))
$('#tabs').onclick = e => {
    const target = e.target as HTMLElement
    const close = target.closest<HTMLElement>('[data-close-tab]')
    if (close) {
        void closeTab(close.dataset.closeTab!);
        return
    }
    const button = target.closest<HTMLElement>('[data-tab]')
    const tab = tabs.find(t => t.id === button?.dataset.tab)
    if (tab) activateTab(tab)
}
$('#new-terminal').onclick = () => void connect()
$('#side-new-terminal').onclick = () => {
    if (session) void connect(); else toast('请先连接服务器')
}

function toast(message: string) {
    const el = $('#toast')
    el.textContent = message
    el.classList.add('show')
    setTimeout(() => el.classList.remove('show'), 3500)
}

function save() {
    localStorage.setItem(key, JSON.stringify(connections));
    renderConnections()
}

function active() {
    return connections.find(c => c.id === selected)
}

function renderConnections() {
    const online = new Set(tabs.filter(t => t.socket.readyState === WebSocket.OPEN).map(t => t.connection))
    $('#connection-count').textContent = session ? (active()?.name || 'SSH') : '连接'
    $('#connection-count').title = session ? (active()?.name || 'SSH') : '连接'
    $('#connections').innerHTML = connections.length ? connections.map(c => `<div class="connection ${selected === c.id ? 'active' : ''} ${online.has(c.id) ? 'online' : ''}"><button class="connection-select" data-select="${esc(c.id)}" title="${esc(c.username)}@${esc(c.host)}:${esc(c.port)}"><span class="status-dot"></span><span class="connection-copy"><strong>${esc(c.name)} <small>${esc(c.username)}@${esc(c.host)}</small></strong></span></button>${session && selected === c.id ? `<button class="connection-off icon-button" data-disconnect title="断开">${icon('unplug', 14)}</button>` : ''}<button class="connection-edit icon-button" data-edit="${esc(c.id)}" title="编辑">${icon('pencil', 14)}</button><button class="connection-delete icon-button" data-delete="${esc(c.id)}" title="删除">${icon('trash-2', 14)}</button></div>`).join('') : `<div class="side-empty">还没有连接<br><span>点击 + 添加服务器</span></div>`
    for (const c of connections) {
        const connectionTabs = tabs.filter(t => t.connection === c.id)
        if (connectionTabs.length < 2) continue
        const row = Array.from($('#connections').querySelectorAll<HTMLElement>('[data-select]')).find(el => el.dataset.select === c.id)?.parentElement
        row?.insertAdjacentHTML('afterend', `<div class="side-tabs">${connectionTabs.map((t, i) => `<span class="side-tab ${t.id === session ? 'active' : ''}"><button data-side-tab="${esc(t.id)}">终端 ${i + 1}</button><button data-side-close="${esc(t.id)}" title="关闭终端">×</button></span>`).join('')}</div>`)
    }
    $('#quick-rows').innerHTML = connections.length ? connections.map(c => `<button class="quick-row" data-quick="${esc(c.id)}" type="button"><span><strong>${esc(c.name)}</strong><small>${esc(c.username)}@${esc(c.host)}:${esc(c.port)}</small></span><span class="button primary">连接</span></button>`).join('') : `<button class="button primary" id="welcome-add" type="button" style="margin-top:14px">添加第一台服务器</button>`
    $('#welcome-add')?.addEventListener('click', () => openEditor())
    const c = active()
    $('#crumb').textContent = session ? (c?.name || 'SSH') : '新标签页'
    $('#welcome-title').textContent = connections.length ? '选择一台服务器' : '还没有连接'
    $('#welcome-copy').textContent = connections.length ? '单击连接以打开终端。' : '先保存一台服务器，再开始使用终端和文件。'
    paintIcons()
}

let editing = ''

function openEditor(c?: Connection) {
    editing = c?.id || ''
    const form = $<HTMLFormElement>('#connection-form')
    form.reset()
    ;(form.elements.namedItem('name') as HTMLInputElement).value = c?.name || ''
    ;(form.elements.namedItem('host') as HTMLInputElement).value = c?.host || ''
    ;(form.elements.namedItem('port') as HTMLInputElement).value = String(c?.port || 22)
    ;(form.elements.namedItem('username') as HTMLInputElement).value = c?.username || ''
    ;(form.elements.namedItem('password') as HTMLInputElement).value = c?.password || ''
    $('#dialog-title').textContent = c ? '编辑连接' : '新建连接'
    $<HTMLDialogElement>('#connection-dialog').showModal()
}

$('#add').onclick = () => openEditor()
$('#close-dialog').onclick = $('#cancel-dialog').onclick = () => $<HTMLDialogElement>('#connection-dialog').close()
$('#connection-form').onsubmit = e => {
    e.preventDefault()
    const data = new FormData(e.target as HTMLFormElement)
    const c = {
        id: editing || crypto.randomUUID(),
        name: String(data.get('name')).trim(),
        host: String(data.get('host')).trim(),
        port: Number(data.get('port')),
        username: String(data.get('username')).trim(),
        password: String(data.get('password') || '')
    }
    if (!c.name || !c.host || !c.username) {
        toast('请填写完整的连接信息');
        return
    }
    if (editing) connections = connections.map(x => x.id === editing ? c : x)
    else connections.push(c)
    if (!session) selected = c.id
    save()
    $<HTMLDialogElement>('#connection-dialog').close()
}
$('#connections').onclick = e => {
    const target = e.target as HTMLElement
    const closeTabButton = target.closest<HTMLElement>('[data-side-close]')
    if (closeTabButton) {
        void closeTab(closeTabButton.dataset.sideClose!);
        return
    }
    const tabButton = target.closest<HTMLElement>('[data-side-tab]')
    if (tabButton) {
        const tab = tabs.find(t => t.id === tabButton.dataset.sideTab);
        if (tab) activateTab(tab);
        return
    }
    const select = target.closest<HTMLElement>('[data-select]'), edit = target.closest<HTMLElement>('[data-edit]'),
        del = target.closest<HTMLElement>('[data-delete]')
    if (target.closest('[data-disconnect]')) {
        void disconnect();
        return
    }
    if (select) {
        const connection = select.dataset.select!
        const tab = tabs.find(t => t.id === lastActiveTabs.get(connection) && t.connection === connection && t.socket.readyState < WebSocket.CLOSING)
            || tabs.find(t => t.connection === connection && t.socket.readyState < WebSocket.CLOSING)
        if (tab) {
            if (tab.id !== session) activateTab(tab); else tab.terminal.focus()
        } else {
            selected = connection;
            void connect()
        }
    }
    if (edit) {
        if (tabs.some(t => t.connection === edit.dataset.edit)) {
            toast('请先断开该连接');
            return
        }
        openEditor(connections.find(c => c.id === edit.dataset.edit))
    }
    if (del) {
        if (tabs.some(t => t.connection === del.dataset.delete)) {
            toast('请先断开该连接');
            return
        }
        const c = connections.find(x => x.id === del.dataset.delete)
        if (c && confirm(`删除连接“${c.name}”？`)) {
            connections = connections.filter(x => x.id !== c.id)
            if (selected === c.id) selected = connections[0]?.id || ''
            save()
        }
    }
}

function applyPanels() {
    $('#sidebar').classList.toggle('hidden', !sideOpen)
    $('#open-side').classList.toggle('hidden', sideOpen)
    if (sideOpen) $('#sidebar').style.width = `${sideWidth}px`
    $('#connections').classList.toggle('hidden', !connectionsOpen)
    $('#file-body').classList.toggle('hidden', !filesOpen)
    $('#toggle-connections').innerHTML = icon(connectionsOpen ? 'chevron-down' : 'chevron-right')
    $('#toggle-files').innerHTML = icon(filesOpen ? 'chevron-down' : 'chevron-right')
    const c = active()
    $('#file-heading').textContent = c && session ? `${currentPath.split('/').filter(Boolean).pop() || '/'}  [SSH: ${c.name}]` : '文件'
    paintIcons()
    if (session) requestAnimationFrame(fitTerminal)
}

$('#toggle-connections').onclick = () => {
    connectionsOpen = !connectionsOpen;
    applyPanels()
}
$('#toggle-files').onclick = () => {
    filesOpen = !filesOpen;
    applyPanels()
}
$('#open-side').onclick = () => {
    sideOpen = true;
    sideWidth = Math.max(220, sideWidth);
    applyPanels()
}
$('#new-file').onclick = () => toast('新建文件尚未接入后端')
$('#new-folder').onclick = () => toast('新建目录尚未接入后端')

function setQueue(open: boolean) {
    $('#queue').classList.toggle('hidden', !open)
    if (open) $('#queue').style.width = `${queueWidth}px`
    $('#transfer-rail').classList.toggle('hidden', open || !session || !transfers.length)
    if (session) requestAnimationFrame(fitTerminal)
}

function setConnected(on: boolean) {
    $('#file-pane').classList.toggle('hidden', !on)
    $('#welcome').classList.toggle('hidden', on)
    $('#terminal-pane').classList.toggle('hidden', !on)
    const c = active()
    $('#crumb').textContent = on ? (c?.name || 'SSH') : '新标签页'
    $('#status').textContent = on ? '已连接' : '未连接'
    $('.top-status').classList.toggle('online', on)
    renderConnections()
    applyPanels()
    if (!on) setQueue(false)
    else setQueue(!$('#queue').classList.contains('hidden'))
}

async function api(url: string, init?: RequestInit) {
    const response = await fetch(backend.base + url, {
        ...init,
        headers: {...((init?.headers || {}) as Record<string, string>), 'X-Minishell-Token': backend.token}
    })
    if (!response.ok) {
        let message = `请求失败 (${response.status})`
        let data: ApiError['data']
        try {
            data = await response.json();
            message = data?.message || message
        } catch {
        }
        const error = new Error(message) as ApiError
        error.status = response.status
        error.data = data
        throw error
    }
    return response
}

function askHostKey(info: HostKeyInfo) {
    return new Promise<'once' | 'save' | 'replace' | null>(resolve => {
        const changed = info.changed
        const title = changed ? '主机密钥已变化' : '首次连接'
        const warning = changed ? `<p class="form-note">已保存：${esc((info.known || []).join('、') || '无')}</p><p class="form-note">如果不是服务器重装或换机，请取消连接。</p>` : ''
        const primary = changed ? '<button class="button primary" value="replace">替换并保存</button>' : '<button class="button primary" value="save">永久保存</button>'
        const dialog = document.createElement('dialog')
        dialog.innerHTML = `<form method="dialog" class="dialog-content"><div class="dialog-heading"><div><h2>${title}</h2><p>${esc(info.host)}:${info.port}</p></div></div><p class="form-note">密钥类型：${esc(info.keyType)}</p><p class="form-note">当前指纹：${esc(info.fingerprint)}</p>${warning}<div class="dialog-actions"><button class="button" value="cancel">取消</button><button class="button" value="once">仅本次</button>${primary}</div></form>`
        document.body.appendChild(dialog)
        dialog.addEventListener('close', () => {
            const value = dialog.returnValue
            dialog.remove()
            resolve(value === 'once' || value === 'save' || value === 'replace' ? value : null)
        }, {once: true})
        dialog.showModal()
    })
}

async function createSession(body: Record<string, unknown>) {
    try {
        const response = await api('/api/sessions', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body)
        })
        return await response.json()
    } catch (err) {
        const apiErr = err as ApiError
        const info = apiErr.data?.hostKey
        if (apiErr.status !== 409 || !info) throw err
        const mode = await askHostKey(info)
        if (!mode) throw new Error('已取消连接')
        const response = await api('/api/sessions', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({...body, hostKeyMode: mode, hostKeyFingerprint: info.fingerprint})
        })
        return await response.json()
    }
}

$('#quick-rows').onclick = e => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-quick]')
    if (!row) return
    selected = row.dataset.quick!
    renderConnections()
    void connect()
}
let connecting = false

async function connect() {
    const c = active()
    if (!c) {
        openEditor();
        return
    }
    if (!c.password) {
        toast('请先在编辑中填写密码');
        openEditor(c);
        return
    }
    if (connecting) return
    connecting = true
    $('#status').textContent = '连接中'
    try {
        const result = await createSession({host: c.host, port: c.port, username: c.username, password: c.password})
        if (!result.id) throw new Error('服务端未返回会话 ID')
        const element = document.createElement('div')
        element.className = 'terminal-instance'
        $('#terminal').appendChild(element)
        const terminal = new Terminal({
            cursorBlink: true,
            fontFamily: 'Cascadia Code, Consolas, monospace',
            fontSize: 13,
            lineHeight: 1.45,
            theme: {background: '#0c0c0c', foreground: '#d7dbe2', cursor: '#d7dbe2'}
        })
        const fit = new FitAddon()
        terminal.loadAddon(fit);
        terminal.open(element)
        const ws = new WebSocket(`${backend.base.replace('http:', 'ws:')}/api/sessions/${encodeURIComponent(result.id)}/terminal?token=${encodeURIComponent(backend.token)}`)
        const tab: Tab = {id: result.id, connection: c.id, terminal, fit, socket: ws, element, path: '/'}
        tabs.push(tab);
        activateTab(tab)
        terminal.onData(data => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({type: 'input', data}))
        })
        ws.onopen = () => {
            renderConnections();
            if (session === tab.id) {
                fitTerminal();
                terminal.focus()
            }
        }
        ws.onmessage = event => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'output') terminal.write(msg.data); else if (msg.type === 'error') toast(msg.message)
            } catch {
                toast('终端收到无法解析的数据')
            }
        }
        ws.onclose = () => {
            if (tabs.includes(tab)) {
                toast('终端连接已断开');
                void closeTab(tab.id)
            }
        }
        ws.onerror = () => toast('终端连接失败')
    } catch (err) {
        $('#status').textContent = '未连接'
        toast(err instanceof Error ? err.message : '连接失败，请检查后端是否运行')
    } finally {
        connecting = false
    }
}

async function disconnect() {
    await closeTab(session)
}

async function closeTab(id: string) {
    const index = tabs.findIndex(t => t.id === id)
    if (index < 0) return
    const tab = tabs[index], wasActive = session === id
    tabs.splice(index, 1);
    tab.socket.close();
    tab.terminal.dispose();
    tab.element.remove()
    if (wasActive) {
        session = '';
        socket = undefined
        const next = tabs[Math.min(index, tabs.length - 1)]
        if (next) activateTab(next)
        else {
            entries = [];
            selectedFiles.clear();
            selectionAnchor = -1;
            currentPath = '/';
            setConnected(false);
            renderFiles()
        }
    }
    renderTabs();
    renderConnections()
    try {
        await api(`/api/sessions/${encodeURIComponent(id)}`, {method: 'DELETE'})
    } catch {
    }
}

async function loadFiles(path: string) {
    if (!session) {
        toast('请先连接服务器');
        return
    }
    const requestedSession = session
    try {
        const res = await api(`/api/sessions/${encodeURIComponent(requestedSession)}/files?path=${encodeURIComponent(path)}`)
        const data = await res.json()
        if (session !== requestedSession) return
        if (typeof data.path !== 'string' || !Array.isArray(data.entries)) throw new Error('服务器返回的文件列表格式有误')
        entries = data.entries.map((item: Record<string, unknown>) => {
            const name = item.name ?? item.Name, type = item.type ?? item.Type, size = item.size ?? item.Size,
                modifiedAt = item.modifiedAt ?? item.ModifiedAt
            if (typeof name !== 'string' || (type !== 'file' && type !== 'directory') || typeof size !== 'number' || typeof modifiedAt !== 'string') throw new Error('服务器返回的文件信息格式有误')
            return {name, type, size, modifiedAt}
        }).sort((a: Entry, b: Entry) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name, 'zh-CN'))
        currentPath = data.path
        selectedFiles.clear()
        selectionAnchor = -1
        editingPath = false
        renderFiles()
    } catch (err) {
        toast(err instanceof Error ? err.message : '读取目录失败')
    }
}

function size(n: number) {
    if (n < 1024) return `${n} B`
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
    if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`
    return `${(n / 1073741824).toFixed(1)} GB`
}

function when(value: string) {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return ''
    return date.toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'})
}

function renderPath() {
    $('#crumb-bar').classList.toggle('hidden', editingPath)
    $('#path-form').classList.toggle('hidden', !editingPath)
    if (editingPath) {
        $<HTMLInputElement>('#path').value = currentPath;
        $<HTMLInputElement>('#path').focus();
        return
    }
    $('#crumb-bar').innerHTML = parts(currentPath).map((part, index) => `${index ? '<span>/</span>' : ''}<button type="button" data-path="${esc(part.path)}">${esc(part.label)}</button>`).join('')
}

function renderFiles(rebuildList = true) {
    renderPath()
    if (rebuildList) $('#file-list').innerHTML = entries.map(f => {
        const meta = f.type === 'directory' ? '目录' : `${size(f.size)} · ${when(f.modifiedAt)}`
        return `<div class="file-row ${f.type === 'directory' ? 'directory' : ''} ${selectedFiles.has(f.name) ? 'selected' : ''}" data-name="${esc(f.name)}" data-type="${esc(f.type)}" title="${esc(f.name)}&#10;${esc(meta)}">${icon(f.type === 'directory' ? 'folder' : 'file')}<span class="file-name"><span>${esc(f.name)}</span></span><button class="file-download icon-button" data-download title="下载" aria-label="下载 ${esc(f.name)}">${icon('download', 14)}</button></div>`
    }).join('')
    else $('#file-list').querySelectorAll<HTMLElement>('.file-row').forEach(row => {
        row.classList.toggle('selected', selectedFiles.has(row.dataset.name ?? ''))
    })
    $('#file-empty').classList.toggle('hidden', !session || !!entries.length)
    $('#file-empty').innerHTML = `<strong>这个文件夹是空的</strong><p>将文件或文件夹拖到此区域，上传至当前目录</p>`
    const picked = entries.filter(f => selectedFiles.has(f.name))
    $('#file-count').textContent = session ? `${entries.length} 个项目` : '等待连接'
    $('#file-meta').textContent = picked.length === 1 && picked[0].type === 'file' ? `${size(picked[0].size)} · ${when(picked[0].modifiedAt)}` : picked.length ? `已选 ${picked.length}` : ''
    paintIcons()
}

$('#crumb-bar').onclick = e => {
    const button = (e.target as HTMLElement).closest<HTMLElement>('[data-path]')
    if (!button) return
    if (button.dataset.path === currentPath) {
        editingPath = true;
        renderPath();
        return
    }
    void loadFiles(button.dataset.path!)
}
$('#path-form').onsubmit = e => {
    e.preventDefault();
    void loadFiles($<HTMLInputElement>('#path').value)
}
const selectionBox = document.createElement('div')
selectionBox.className = 'selection-box hidden'
document.body.appendChild(selectionBox)
const fileMenu = document.createElement('div')
fileMenu.className = 'file-context-menu hidden'
fileMenu.innerHTML = '<button data-action="preview">预览图片</button><button data-action="download">下载选中项</button><button data-action="delete">删除选中项</button>'
document.body.appendChild(fileMenu)
const previewDialog = document.createElement('dialog')
previewDialog.className = 'image-preview'
previewDialog.innerHTML = '<div class="image-preview-header"><strong></strong><button type="button" class="icon-button" aria-label="关闭预览">×</button></div><div class="image-preview-body"><span class="image-preview-message" role="status"></span><img class="hidden" alt=""></div>'
document.body.appendChild(previewDialog)
const previewTitle = previewDialog.querySelector<HTMLElement>('strong')!
const previewMessage = previewDialog.querySelector<HTMLElement>('.image-preview-message')!
const previewImage = previewDialog.querySelector<HTMLImageElement>('img')!
let previewURL = ''
let previewRequest: AbortController | undefined
const isPreviewImage = (entry: Entry) => entry.type === 'file' && /\.(jpe?g|png|gif|webp|bmp)$/i.test(entry.name)
function clearPreview() {
    previewRequest?.abort(); previewRequest = undefined
    previewImage.removeAttribute('src'); previewImage.classList.add('hidden')
    if (previewURL) URL.revokeObjectURL(previewURL)
    previewURL = ''
}
previewDialog.querySelector('button')!.onclick = () => previewDialog.close()
previewDialog.addEventListener('close', clearPreview)
const previewHeader = previewDialog.querySelector<HTMLElement>('.image-preview-header')!
function keepPreviewVisible(left: number, top: number) {
    const width = previewDialog.offsetWidth, height = previewDialog.offsetHeight
    previewDialog.style.left = `${Math.max(0, Math.min(left, window.innerWidth - width))}px`
    previewDialog.style.top = `${Math.max(0, Math.min(top, window.innerHeight - height))}px`
}
previewHeader.addEventListener('pointerdown', event => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
    event.preventDefault()
    const rect = previewDialog.getBoundingClientRect()
    const offsetX = event.clientX - rect.left, offsetY = event.clientY - rect.top
    previewHeader.setPointerCapture(event.pointerId)
    const move = (e: PointerEvent) => keepPreviewVisible(e.clientX - offsetX, e.clientY - offsetY)
    const finish = () => {
        previewHeader.removeEventListener('pointermove', move)
        previewHeader.removeEventListener('pointerup', finish)
        previewHeader.removeEventListener('pointercancel', finish)
        previewHeader.removeEventListener('lostpointercapture', finish)
    }
    previewHeader.addEventListener('pointermove', move)
    previewHeader.addEventListener('pointerup', finish)
    previewHeader.addEventListener('pointercancel', finish)
    previewHeader.addEventListener('lostpointercapture', finish)
})
window.addEventListener('resize', () => {
    if (previewDialog.open) { const rect = previewDialog.getBoundingClientRect(); keepPreviewVisible(rect.left, rect.top) }
})
previewDialog.addEventListener('keydown', event => { if (event.key === 'Escape') previewDialog.close() })
async function previewFile(name: string) {
    if (!session) return
    clearPreview()
    const controller = new AbortController()
    previewRequest = controller
    const sid = session, remotePath = joinPath(currentPath, name)
    previewTitle.textContent = name
    previewImage.alt = name
    previewMessage.textContent = '正在加载图片…'
    previewMessage.classList.remove('hidden')
    if (!previewDialog.open) {
        previewDialog.show()
        if (!previewDialog.style.left) keepPreviewVisible(window.innerWidth - previewDialog.offsetWidth - 16, 16)
        else { const rect = previewDialog.getBoundingClientRect(); keepPreviewVisible(rect.left, rect.top) }
    }
    try {
        const response = await api(`/api/sessions/${encodeURIComponent(sid)}/preview?path=${encodeURIComponent(remotePath)}`, {signal: controller.signal})
        const blob = await response.blob()
        if (controller.signal.aborted) return
        if (!/^image\/(jpeg|png|gif|webp|bmp)$/i.test(blob.type)) throw new Error('服务器未返回支持的图片格式')
        previewURL = URL.createObjectURL(blob)
        previewImage.onload = () => { previewMessage.classList.add('hidden') }
        previewImage.onerror = () => { previewImage.classList.add('hidden'); previewMessage.textContent = '图片无法显示' }
        previewImage.src = previewURL
        previewImage.classList.remove('hidden')
    } catch (err) {
        if (!controller.signal.aborted) previewMessage.textContent = `预览失败：${err instanceof Error ? err.message : String(err)}`
    }
}
let suppressFileClick = false
$('#file-list').addEventListener('pointerdown', e => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-download]')) return
    const startX = e.clientX, startY = e.clientY, original = new Set(selectedFiles)
    let dragging = false
    const move = (event: PointerEvent) => {
        if (!dragging && Math.hypot(event.clientX - startX, event.clientY - startY) < 5) return
        dragging = true
        const left = Math.min(startX, event.clientX), top = Math.min(startY, event.clientY)
        const right = Math.max(startX, event.clientX), bottom = Math.max(startY, event.clientY)
        Object.assign(selectionBox.style, {
            left: `${left}px`,
            top: `${top}px`,
            width: `${right - left}px`,
            height: `${bottom - top}px`
        })
        selectionBox.classList.remove('hidden')
        selectedFiles = event.ctrlKey || event.metaKey ? new Set(original) : new Set<string>()
        $('#file-list').querySelectorAll<HTMLElement>('.file-row').forEach(row => {
            const rect = row.getBoundingClientRect()
            if (rect.left < right && rect.right > left && rect.top < bottom && rect.bottom > top && row.dataset.name) selectedFiles.add(row.dataset.name)
        })
        renderFiles(false)
    }
    const finish = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish)
        selectionBox.classList.add('hidden')
        if (dragging) {
            suppressFileClick = true;
            setTimeout(() => {
                suppressFileClick = false
            }, 0)
        }
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish)
})
$('#file-list').oncontextmenu = e => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.file-row')
    if (!row?.dataset.name) return
    e.preventDefault()
    if (!selectedFiles.has(row.dataset.name)) {
        selectedFiles.clear();
        selectedFiles.add(row.dataset.name);
        renderFiles(false)
    }
    const previewEntries = entries.filter(f => selectedFiles.has(f.name))
    $<HTMLButtonElement>('[data-action="preview"]').disabled = previewEntries.length !== 1 || !isPreviewImage(previewEntries[0])
    fileMenu.classList.remove('hidden')
    fileMenu.style.left = `${Math.min(e.clientX, window.innerWidth - fileMenu.offsetWidth)}px`
    fileMenu.style.top = `${Math.min(e.clientY, window.innerHeight - fileMenu.offsetHeight)}px`
}
document.addEventListener('pointerdown', e => {
    if (!fileMenu.contains(e.target as Node)) fileMenu.classList.add('hidden')
})
fileMenu.onclick = async e => {
    const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action
    fileMenu.classList.add('hidden')
    if (action === 'preview') {
        const entry = entries.find(f => selectedFiles.has(f.name))
        if (selectedFiles.size === 1 && entry && isPreviewImage(entry)) void previewFile(entry.name)
        return
    }
    if (action === 'download') {
        void downloadSelected();
        return
    }
    if (action !== 'delete' || !session || !selectedFiles.size) return
    const names = [...selectedFiles], sid = session, dir = currentPath
    const hasDirectories = entries.some(f => selectedFiles.has(f.name) && f.type === 'directory')
    const warning = hasDirectories ? '文件夹及其所有内容将被删除。' : ''
    if (!confirm(`确定删除 ${names.length} 个项目？${warning}此操作无法撤销。\n\n${names.join('\n')}`)) return
    const failures: string[] = []
    for (const name of names) {
        try {
            await api(`/api/sessions/${encodeURIComponent(sid)}/files?path=${encodeURIComponent(joinPath(dir, name))}`, {method: 'DELETE'})
        } catch (err) {
            failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
        }
    }
    if (session === sid && currentPath === dir) await loadFiles(dir)
    if (failures.length) alert(`部分项目删除失败，文件夹内可能已有部分内容被删除：\n${failures.join('\n')}`)
    else toast(`已删除 ${names.length} 个项目`)
}
$('#file-list').onclick = e => {
    if (suppressFileClick) return
    const mouse = e as MouseEvent, target = e.target as HTMLElement
    const row = target.closest<HTMLElement>('.file-row')
    if (!row?.dataset.name) return
    if (target.closest('[data-download]')) {
        void downloadFile(row.dataset.name);
        return
    }
    const index = entries.findIndex(f => f.name === row.dataset.name)
    if (mouse.shiftKey && selectionAnchor >= 0) {
        if (!mouse.ctrlKey) selectedFiles.clear()
        for (let i = Math.min(selectionAnchor, index); i <= Math.max(selectionAnchor, index); i++) selectedFiles.add(entries[i].name)
    } else if (entries[index]) {
        if (!mouse.ctrlKey && !mouse.metaKey) selectedFiles.clear()
        if ((mouse.ctrlKey || mouse.metaKey) && selectedFiles.has(row.dataset.name)) selectedFiles.delete(row.dataset.name)
        else selectedFiles.add(row.dataset.name)
        selectionAnchor = index
    } else {
        selectedFiles.clear();
        selectionAnchor = index
    }
    renderFiles(false)
}
$('#file-list').ondblclick = e => {
    if ((e.target as HTMLElement).closest('[data-download]')) return
    const row = (e.target as HTMLElement).closest<HTMLElement>('.file-row')
    if (row?.dataset.type === 'directory' && row.dataset.name) void loadFiles(joinPath(currentPath, row.dataset.name))
    else if (row?.dataset.name) { const entry = entries.find(f => f.name === row.dataset.name); if (entry && isPreviewImage(entry)) void previewFile(entry.name) }
}
$('#up').onclick = () => void loadFiles(parentPath(currentPath))
$('#refresh').onclick = () => void loadFiles(currentPath)
async function downloadSelected() {
    if (!session || !selectedFiles.size) return
    const names = [...selectedFiles], sid = session, dir = currentPath
    const local = await desktop().ChooseDirectory()
    if (!local) return
    for (const name of names) await downloadFile(name, local, sid, dir)
}

async function downloadFile(name: string, chosenDir?: string, sid = session, dir = currentPath) {
    if (!sid) {
        toast('请先连接服务器');
        return
    }
    const local = chosenDir || await desktop().ChooseDirectory()
    if (!local) return
    const transfer: Transfer = {name, progress: 0, status: '提交中', direction: 'download'}
    transfers.push(transfer)
    setQueue(true)
    renderTransfers()
    try {
        const id = await desktop().SubmitDownload(sid, joinPath(dir, name), local);
        void monitorTask(id, transfer)
    } catch (err) {
        transfer.status = '失败';
        transfer.error = String(err);
        renderTransfers();
        toast(transfer.error)
    }
}

async function uploadPaths(paths: string[]) {
    if (!session) {
        toast('请先连接服务器');
        return
    }
    const sid = session, remoteDir = currentPath
    for (const localPath of paths) {
        const rootName = localPath.split(/[\\/]/).pop() || localPath
        const pending: Transfer = {name: rootName, progress: 0, status: '扫描中', direction: 'upload'}
        transfers.push(pending)
        setQueue(true)
        renderTransfers()
        const requestId = crypto.randomUUID(), seen = new Set<string>()
        let outstanding = 0, submitting = true
        const refresh = () => {
            if (!submitting && outstanding === 0 && session === sid && currentPath === remoteDir) void loadFiles(remoteDir)
        }
        const addTask = (task: { id: string; name: string; size: number }) => {
            if (seen.has(task.id)) return
            seen.add(task.id)
            outstanding++
            const transfer: Transfer = {name: task.name, progress: 0, status: '等待中', direction: 'upload'}
            transfers.push(transfer)
            renderTransfers()
            void monitorTask(task.id, transfer, () => {
                outstanding--;
                refresh()
            })
        }
        const off = window.runtime.EventsOn('upload:task', event => {
            if (event.requestId === requestId) addTask(event.task)
        })
        try {
            const result = await desktop().SubmitUploadStreaming(sid, remoteDir, localPath, requestId)
            for (const task of result.tasks) addTask(task)
            if (result.skipped.length) toast(`已跳过 ${result.skipped.length} 个符号链接或特殊文件`)
            if (result.submissionError) {
                pending.status = '部分提交失败';
                pending.error = result.submissionError;
                toast(result.submissionError)
            } else if (!seen.size) {
                pending.status = '完成（空目录）';
                pending.progress = 100
            } else transfers = transfers.filter(t => t !== pending)
        } catch (err) {
            pending.status = '失败';
            pending.error = String(err);
            toast(pending.error)
        } finally {
            off();
            submitting = false;
            renderTransfers();
            refresh()
        }
    }
}

let activeStatusCalls = 0
const statusWaiters: Array<() => void> = []

async function readTransferStatus(id: string) {
    if (activeStatusCalls >= 32) await new Promise<void>(resolve => statusWaiters.push(resolve))
    else activeStatusCalls++
    try {
        return await desktop().TransferStatus(id)
    } finally {
        const next = statusWaiters.shift();
        if (next) next(); else activeStatusCalls--
    }
}

async function monitorTask(id: string, transfer: Transfer, onDone?: () => void) {
    let previousBytes = 0, previousTime = performance.now()
    try {
        while (true) {
            const result = await readTransferStatus(id)
            const now = performance.now()
            if (transfer.direction === 'upload') {
                const elapsed = (now - previousTime) / 1000
                if (elapsed > 0) {
                    transfer.speed = Math.max(0, (result.transferredBytes - previousBytes) / elapsed);
                    transfer.speedAt = Date.now()
                }
                previousBytes = result.transferredBytes
                previousTime = now
                if (result.totalBytes > 0) transfer.progress = Math.min(99, Math.floor(result.transferredBytes / result.totalBytes * 100))
            }
            if (result.status === 'created') transfer.status = '等待中'
            else if (result.status === 'in_progress') transfer.status = '传输中'
            else if (result.status === 'success') {
                transfer.status = '完成';
                transfer.progress = 100;
                transfer.speed = 0;
                renderTransfers();
                onDone?.();
                return
            } else if (result.status === 'failed') {
                transfer.status = '失败';
                transfer.speed = 0;
                transfer.error = result.error;
                renderTransfers();
                onDone?.();
                return
            } else throw new Error('未知任务状态: ' + result.status)
            renderTransfers()
            await new Promise(resolve => setTimeout(resolve, 500))
        }
    } catch (err) {
        transfer.status = '状态未知';
        transfer.error = String(err);
        renderTransfers();
        onDone?.()
    }
}

function formatSpeed(bytes: number) {
    if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB/s`
    if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB/s`
    return `${Math.round(bytes)} B/s`
}

let renderTimer: ReturnType<typeof setTimeout> | undefined

function renderTransfers() {
    if (renderTimer) return
    renderTimer = setTimeout(() => {
        renderTimer = undefined
        const activeJobs = transfers.filter(t => t.status !== '完成' && t.status !== '失败' && t.status !== '状态未知' && !t.status.startsWith('部分'))
        const done = transfers.filter(t => t.status === '完成' || t.status.startsWith('完成')).length
        const totalSpeed = transfers.reduce((sum, t) => sum + (t.direction === 'upload' && t.status === '传输中' && Date.now() - (t.speedAt || 0) < 2000 ? (t.speed || 0) : 0), 0)
        $('#transfer-summary').textContent = transfers.length ? `传输 ${done}/${transfers.length}${totalSpeed ? ' · ' + formatSpeed(totalSpeed) : ''}` : '传输'
        $('#transfer-badge').textContent = String(activeJobs.length)
        $('#transfer-badge').classList.toggle('hidden', !activeJobs.length)
        if (session && transfers.length && $('#queue').classList.contains('hidden') && $('#transfer-rail').classList.contains('hidden')) setQueue(false)
        $('#transfers').innerHTML = transfers.map(t => {
            const failed = t.status === '失败' || t.status === '状态未知' || t.status.startsWith('部分')
            const label = t.direction === 'download' ? '下载' : '上传'
            const speed = t.direction === 'upload' && t.status === '传输中' ? ` ${formatSpeed(t.speed || 0)}` : ''
            return `<div class="transfer-row ${failed ? 'failed' : ''} ${t.status.startsWith('完成') ? 'done' : ''}">${icon(t.direction === 'download' ? 'arrow-down' : 'arrow-up')}<span class="transfer-name" title="${esc(t.name)}">${esc(t.name)}</span><div class="progress"><div style="width:${t.progress}%"></div></div><span class="transfer-meta" title="${esc(t.error || '')}">${esc(label)} · ${esc(t.status)}${speed}${t.error ? `：${esc(t.error)}` : ''}</span></div>`
        }).join('') || `<div class="file-empty"><strong>暂无传输任务</strong></div>`
        paintIcons()
    }, 150)
}

$('#toggle-transfers').onclick = () => setQueue(true)
$('#close-queue').onclick = () => setQueue(false)
$('#clear-done').onclick = () => {
    transfers = transfers.filter(t => !t.status.startsWith('完成'));
    renderTransfers()
}

function bindResize(handle: HTMLElement, read: (x: number) => number, apply: (width: number) => void, collapse: () => void) {
    handle.addEventListener('pointerdown', event => {
        if (event.button !== 0) return
        event.preventDefault()
        const move = (ev: PointerEvent) => apply(Math.max(180, read(ev.clientX)))
        const up = (ev: PointerEvent) => {
            const next = read(ev.clientX)
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            if (next < 160) collapse()
            else apply(Math.max(220, Math.min(480, next)))
            if (session) requestAnimationFrame(fitTerminal)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
    })
}

bindResize($('#queue-resize'), x => window.innerWidth - x, width => {
    queueWidth = width;
    $('#queue').style.width = `${width}px`;
    setQueue(true)
}, () => setQueue(false))
bindResize($('#side-resize'), x => x, width => {
    sideWidth = width;
    sideOpen = true;
    applyPanels()
}, () => {
    sideOpen = false;
    applyPanels()
})

renderConnections()
renderFiles()
setConnected(false)
paintIcons()
void desktop().Backend().then(info => {
    backend = info
    window.runtime.OnFileDrop((_x, _y, paths) => {
        void uploadPaths(paths)
    }, false)
}).catch(err => toast(String(err)))
