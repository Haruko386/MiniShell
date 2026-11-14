declare global {
    type UpdateInfo = {
        current: string;
        latest: string;
        available: boolean;
        releaseUrl: string;
        notes: string;
        assetName: string;
        assetSize: number;
        assetUrl: string
    }
    type UpdateProgress = {
        stage: string;
        percent: number;
        message?: string
    }
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
                    }>;
                    CheckForUpdate(): Promise<UpdateInfo>;
                    InstallUpdate(): Promise<void>
                }
            }
        };
        runtime: {
            WindowSetDarkTheme(): void;
            WindowSetLightTheme(): void;
            Quit(): void;
            BrowserOpenURL(url: string): void;
            ClipboardSetText(text: string): Promise<boolean>;
            OnFileDrop(callback: (x: number, y: number, paths: string[]) => void, useDropTarget: boolean): void;
            EventsOn(name: 'update:progress', callback: (event: UpdateProgress) => void): () => void;
            EventsOn(name: 'upload:task', callback: (event: {
                requestId: string;
                task: { id: string; name: string; size: number }
            }) => void): () => void;
            EventsOn(name: string, callback: (event: unknown) => void): () => void
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
import {createRemoteEntry} from './create-entry'
import {flattenFiles, creationParent, creationIndex} from './file-tree'
import {pollResources, resourceBytes, resourcePercent} from './resource-monitor'
import type {ResourceMetrics} from './resource-monitor'
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
const expandedFolders = new Map<string, Entry[]>()
const visibleFiles = () => flattenFiles(entries, expandedFolders)
let cancelCreation: (() => void) | undefined
let creationVersion = 0
let directoryLoadVersion = 0
let queueWidth = 300
let sideWidth = 264
let sideOpen = true
let connectionsOpen = true
let filesOpen = true
const kaomoji = [
    '(＾▽＾)', '(￣▽￣)', '(・∀・)', '(°∀°)', '(´∀｀)', '(＾ω＾)',
    '(๑•̀ㅂ•́)و✧', '(ง •̀_•́)ง', '(๑•́ ₃ •̀๑)', '(｡•́︿•̀｡)',
    '(；´Д｀)', '(´；ω；｀)', '(￣^￣)ゞ', '(⌒‿⌒)', '(◕‿◕)',
    '(｡◕‿◕｡)', '(๑˃̵ᴗ˂̵)', '(≧▽≦)', '(>_<)', '(T_T)',
    '(ToT)', '(Q_Q)', '(¬_¬)', '(￣ー￣)', '(￣▽￣)ノ',
    '(＾▽＾)／', 'ヽ(・∀・)ﾉ', 'ヾ(≧▽≦*)o', '(￣ω￣)', '(´･ω･`)',
    '(´・ω・`)', '( •_•)>⌐■-■', '(⌐■_■)', '(☞ﾟヮﾟ)☞', '☜(ﾟヮﾟ☜)',
    '(╯°□°）╯︵ ┻━┻', '┬─┬ノ( º _ ºノ)', '(ヘ･_･)ヘ┳━┳', '(づ｡◕‿‿◕｡)づ', '(っ˘ω˘ς )',
    '(￣▽￣)ゞ', '(ー_ー)', '(=_=)', '(#^.^#)', '(^_^)',
    '(^o^)', '(^ω^)', '(￣ε￣)', '(￣3￣)', '(づ￣ 3￣)づ'
]
const randomKaomoji = () => kaomoji[Math.floor(Math.random() * kaomoji.length)]
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

app.innerHTML = `<header class="topbar"><span class="logo">${icon('terminal')}</span><strong class="tab-label" id="crumb">新标签页</strong><span class="spacer"></span><span class="top-status"><span class="status-dot"></span><span id="status">未连接</span></span></header><div class="shell"><button class="dock hidden" id="open-side" type="button" title="展开左侧">${icon('panel-left')}</button><aside class="sidebar" id="sidebar"><div class="side-resize" id="side-resize" title="拖动调整宽度，拖到最左收起"></div><div class="side-heading"><button class="icon-button" id="toggle-connections" title="收起连接">${icon('chevron-down')}</button><span id="connection-count">连接</span><button class="icon-button" id="theme" type="button" title="主题"></button><button class="icon-button" id="add" title="新建连接">${icon('plus')}</button></div><div class="connection-list" id="connections"></div><div id="file-pane" class="hidden"><div class="side-heading"><button class="icon-button" id="toggle-files" title="收起文件">${icon('chevron-down')}</button><span class="file-heading" id="file-heading">文件</span><span class="heading-tools"><button class="icon-button" id="new-file" title="新建文件">${icon('file-plus')}</button><button class="icon-button" id="new-folder" title="新建目录">${icon('folder-plus')}</button><button class="icon-button" id="refresh" title="刷新">${icon('refresh-cw')}</button></span></div><div id="file-body"><div class="path-row"><div class="crumb" id="crumb-bar"></div><form class="path-edit hidden" id="path-form"><input id="path" aria-label="远程路径" spellcheck="false"></form><button class="icon-button" id="up" title="上一级">${icon('arrow-up')}</button></div><div id="dropzone"><div class="file-list" id="file-list"></div><div id="file-empty" class="file-empty"></div><div class="drop-overlay">${icon('upload', 22)}<strong>松开以上传文件或文件夹</strong></div></div><div class="side-footer"><span id="file-count">等待连接</span><span id="file-meta"></span></div></div></aside><main class="main"><section class="welcome" id="welcome"><div class="welcome-card"><div class="welcome-face" id="welcome-face"></div><div id="quick-rows"></div></div></section><section class="terminal-pane hidden" id="terminal-pane"><div id="terminal"></div></section></main><aside class="transfer-rail hidden" id="transfer-rail"><button class="icon-button" id="toggle-transfers" title="传输队列">${icon('arrow-up-down')}</button><span class="badge hidden" id="transfer-badge"></span></aside><aside class="queue hidden" id="queue"><div class="queue-resize" id="queue-resize" title="拖动调整宽度，双击收起"></div><div class="queue-head"><span id="transfer-summary">传输</span><span><button class="button" id="clear-done" type="button">清空完成</button><button class="icon-button" id="close-queue" title="收起">${icon('x')}</button></span></div><div class="transfers" id="transfers"></div></aside></div><dialog id="connection-dialog"><form id="connection-form" class="dialog-content"><div class="dialog-heading"><div><h2 id="dialog-title">新建连接</h2></div><button type="button" class="icon-button" id="close-dialog">${icon('x')}</button></div><label>连接名称<input name="name" required placeholder="server" maxlength="80"></label><div class="form-row"><label>主机地址<input name="host" required placeholder="172.0.0.1"></label><label>端口<input name="port" type="number" min="1" max="65535" required value="22"></label></div><label>用户名<input name="username" required placeholder="root"></label><label>密码<input name="password" type="password" required autocomplete="current-password" placeholder="password"></label><div class="dialog-actions"><button type="button" class="button" id="cancel-dialog">取消</button><button class="button primary">保存连接</button></div></form></dialog><div id="toast" role="status"></div>`

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!
$('#terminal-pane').insertAdjacentHTML('afterbegin', `<div class="resource-bar" aria-label="远端资源监控"><span class="resource-item">${icon('cpu', 14)}<span>CPU</span><strong id="resource-cpu">—</strong><meter id="resource-cpu-meter" min="0" max="100" value="0" aria-label="CPU 使用率" hidden></meter></span><span class="resource-item">${icon('memory-stick', 14)}<span>内存</span><strong id="resource-memory">—</strong><span id="resource-memory-size" class="resource-detail"></span></span><span class="resource-item resource-network">${icon('network', 14)}<span>网络</span><span title="远端接收速率">↓ <strong id="resource-rx">—</strong></span><span title="远端发送速率">↑ <strong id="resource-tx">—</strong></span></span><span id="resource-state" class="resource-state" role="status">等待连接</span></div>`)
let stopResourcePolling: (() => void) | undefined

function renderResources(metrics?: ResourceMetrics, state = '') {
    $('#resource-cpu').textContent = resourcePercent(metrics?.cpuPercent ?? null)
    const meter = $<HTMLMeterElement>('#resource-cpu-meter')
    meter.hidden = metrics?.cpuPercent == null
    meter.value = metrics?.cpuPercent ?? 0
    $('#resource-memory').textContent = resourcePercent(metrics?.memory.usedPercent ?? null)
    $('#resource-memory-size').textContent = metrics ? `${resourceBytes(metrics.memory.usedBytes)} / ${resourceBytes(metrics.memory.totalBytes)}` : ''
    $('#resource-rx').textContent = metrics?.network.rxBytesPerSecond == null ? '—' : `${resourceBytes(metrics.network.rxBytesPerSecond)}/s`
    $('#resource-tx').textContent = metrics?.network.txBytesPerSecond == null ? '—' : `${resourceBytes(metrics.network.txBytesPerSecond)}/s`
    $('#resource-state').textContent = state
    $('#resource-state').title = metrics ? `采样时间：${metrics.sampledAt}` : state
}

function refreshResourcePolling() {
    stopResourcePolling?.()
    stopResourcePolling = undefined
    renderResources(undefined, !session ? '等待连接' : document.hidden ? '已暂停' : '正在采样')
    if (!session || document.hidden) return
    const sid = session
    stopResourcePolling = pollResources(async signal => {
        const response = await api(`/api/sessions/${encodeURIComponent(sid)}/metrics`, {signal})
        return await response.json() as ResourceMetrics
    }, metrics => renderResources(metrics, metrics.cpuPercent === null || metrics.network.rxBytesPerSecond === null || metrics.network.txBytesPerSecond === null ? '正在采样' : '实时'), () => renderResources(undefined, '暂不可用'))
}
document.addEventListener('visibilitychange', refreshResourcePolling)
type ThemeChoice = 'system' | 'light' | 'dark'
const themeKey = 'minishell.theme'
const themeQuery = window.matchMedia('(prefers-color-scheme: dark)')
let themeChoice: ThemeChoice = (localStorage.getItem(themeKey) as ThemeChoice) || 'system'

function themeDark() {
    return themeChoice === 'dark' || (themeChoice === 'system' && themeQuery.matches)
}

function applyTheme() {
    const dark = themeDark()
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    if (dark) window.runtime?.WindowSetDarkTheme()
    else window.runtime?.WindowSetLightTheme()
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
themeQuery.addEventListener('change', () => {
    if (themeChoice === 'system') applyTheme()
})
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
    cancelCreation?.()
    expandedFolders.clear()
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

let resizingPanel = false
function fitTerminal() {
    if (resizingPanel) return
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
    $('#welcome-face').textContent = randomKaomoji()
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
$('#new-file').onclick = () => createEntry('file')
$('#new-folder').onclick = () => createEntry('directory')

async function createEntry(type: 'file' | 'directory', parent = creationParent(visibleFiles().find(f => selectedFiles.has(f.name)))) {
    if (!session) return toast('请先连接服务器')
    const version = ++creationVersion
    const ownsForm = () => creationVersion === version
    cancelCreation?.()
    const sid = session, root = currentPath, dir = parent ? joinPath(root, parent) : root
    if (parent && !expandedFolders.has(parent) && !await expandFolder(parent, ownsForm)) return
    if (session !== sid || currentPath !== root || !ownsForm()) return
    renderFiles()
    const label = type === 'file' ? '文件' : '文件夹'
    const rows = visibleFiles(), index = creationIndex(rows, parent, type)
    const depth = parent ? parent.split('/').length : 0
    const form = document.createElement('form')
    form.className = 'file-row file-create-row'
    form.style.paddingLeft = `${8 + depth * 16}px`
    form.innerHTML = `<span>${type === 'directory' ? icon('chevron-right', 14) : ''}</span>${icon(type === 'file' ? 'file' : 'folder')}<div class="file-create-field"><input aria-label="新建${label}名称" autocomplete="off" spellcheck="false"><span class="file-create-error hidden" role="alert"></span></div>`
    const input = form.querySelector('input')!
    const error = form.querySelector<HTMLElement>('.file-create-error')!
    let saving = false
    const cancel = () => {
        if (cancelCreation === cancel) cancelCreation = undefined
        form.remove()
        $('#file-empty').classList.toggle('hidden', !session || !!entries.length)
    }
    cancelCreation = cancel
    const submit = async () => {
        if (saving) return
        const name = input.value
        if (!name) { cancel(); return }
        const siblings = parent ? expandedFolders.get(parent)! : entries
        if (siblings.some(f => f.name === name)) {
            error.textContent = '同名文件或文件夹已存在'
            error.classList.remove('hidden')
            input.setAttribute('aria-invalid', 'true')
            return
        }
        saving = true
        input.readOnly = true
        try {
            await createRemoteEntry(api, type, sid, dir, name)
            if (!ownsForm()) return
            cancel()
            if (session === sid && currentPath === root) {
                if (parent) await expandFolder(parent, ownsForm)
                else await loadFiles(root, ownsForm)
                if (session !== sid || currentPath !== root || !ownsForm()) return
                selectedFiles.clear()
                const createdName = parent ? `${parent}/${name}` : name
                selectedFiles.add(createdName)
                renderFiles(false)
                const created = visibleFiles().find(f => f.name === createdName)
                if (type === 'file' && created) void openTextFile(created)
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : '创建失败'
            if (!form.isConnected) { toast(message); return }
            error.textContent = message
            error.classList.remove('hidden')
            input.setAttribute('aria-invalid', 'true')
        } finally {
            saving = false
            input.readOnly = false
        }
    }
    form.onsubmit = e => { e.preventDefault(); void submit() }
    input.onkeydown = e => {
        if (e.isComposing) return
        if (e.key === 'Escape' && !saving) { e.preventDefault(); cancel() }
        if (e.key === 'Enter') { e.preventDefault(); void submit() }
    }
    input.oninput = () => { error.classList.add('hidden'); input.removeAttribute('aria-invalid') }
    input.onblur = () => {
        if (form.isConnected && !saving && error.classList.contains('hidden')) void submit()
    }
    $('#file-list').insertBefore(form, $('#file-list').children[index] ?? null)
    $('#file-empty').classList.add('hidden')
    paintIcons()
    input.focus()
    input.scrollIntoView({block: 'nearest'})
}

function setQueue(open: boolean) {
    $('#queue').classList.toggle('hidden', !open)
    if (open) $('#queue').style.width = `${queueWidth}px`
    $('#transfer-rail').classList.toggle('hidden', open)
    if (session) requestAnimationFrame(fitTerminal)
}

function setConnected(on: boolean) {
    refreshResourcePolling()
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
            expandedFolders.clear();
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

async function readDirectory(sid: string, path: string) {
    const res = await api(`/api/sessions/${encodeURIComponent(sid)}/files?path=${encodeURIComponent(path)}`)
    const data = await res.json()
    if (typeof data.path !== 'string' || !Array.isArray(data.entries)) throw new Error('服务器返回的文件列表格式有误')
    const files = data.entries.map((item: Record<string, unknown>) => {
        const name = item.name ?? item.Name, type = item.type ?? item.Type, size = item.size ?? item.Size,
            modifiedAt = item.modifiedAt ?? item.ModifiedAt
        if (typeof name !== 'string' || (type !== 'file' && type !== 'directory') || typeof size !== 'number' || typeof modifiedAt !== 'string') throw new Error('服务器返回的文件信息格式有误')
        return {name, type, size, modifiedAt}
    }).sort((a: Entry, b: Entry) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name, 'zh-CN'))
    return {path: data.path as string, entries: files}
}

async function expandFolder(name: string, ownsForm = () => true) {
    const sid = session, root = currentPath
    const loadVersion = directoryLoadVersion
    try {
        const data = await readDirectory(sid, joinPath(root, name))
        if (session !== sid || currentPath !== root || loadVersion !== directoryLoadVersion || !ownsForm()) return false
        expandedFolders.set(name, data.entries)
        renderFiles()
        return true
    } catch (err) {
        toast(err instanceof Error ? err.message : '读取目录失败')
        return false
    }
}

async function loadFiles(path: string, ownsForm = () => true) {
    cancelCreation?.()
    if (!session) {
        toast('请先连接服务器');
        return
    }
    const requestedSession = session
    const loadVersion = ++directoryLoadVersion
    const ownsLoad = () => session === requestedSession && loadVersion === directoryLoadVersion && ownsForm()
    try {
        const data = await readDirectory(requestedSession, path)
        if (!ownsLoad()) return
        if (currentPath !== data.path) expandedFolders.clear()
        else {
            await Promise.all([...expandedFolders.keys()].map(async name => {
                try {
                    const child = await readDirectory(requestedSession, joinPath(data.path, name))
                    if (ownsLoad() && currentPath === data.path && expandedFolders.has(name)) expandedFolders.set(name, child.entries)
                } catch {
                    if (ownsLoad() && currentPath === data.path) expandedFolders.delete(name)
                }
            }))
            if (!ownsLoad()) return
        }
        entries = data.entries
        currentPath = data.path
        selectedFiles.clear()
        selectionAnchor = -1
        renderFiles()
    } catch (err) {
        if (ownsLoad()) toast(err instanceof Error ? err.message : '读取目录失败')
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

const crumbBar = $('#crumb-bar')
let crumbScrollLeft = 0
let crumbAtEnd = true

crumbBar.addEventListener('scroll', () => {
    crumbScrollLeft = crumbBar.scrollLeft
    crumbAtEnd = crumbBar.scrollLeft + crumbBar.clientWidth >= crumbBar.scrollWidth - 1
}, {passive: true})

function renderPath() {
    crumbBar.innerHTML = parts(currentPath).map((part, index) => `${index > 1 ? '<span>/</span>' : ''}<button type="button" data-path="${esc(part.path)}" title="${esc(part.path)}"${index === 0 ? ' aria-label="返回根目录"' : ''}>${esc(part.label)}</button>`).join('')
    crumbBar.scrollLeft = crumbBar.scrollWidth
    crumbScrollLeft = crumbBar.scrollLeft
    crumbAtEnd = true
}

new ResizeObserver(() => {
    const max = Math.max(0, crumbBar.scrollWidth - crumbBar.clientWidth)
    crumbBar.scrollLeft = crumbAtEnd ? max : Math.min(crumbScrollLeft, max)
}).observe(crumbBar)

function renderFiles(rebuildList = true) {
    renderPath()
    if (rebuildList) {
        cancelCreation?.()
        selectionAnchor = -1
        $('#file-list').innerHTML = visibleFiles().map(f => {
            const meta = f.type === 'directory' ? '目录' : `${size(f.size)} · ${when(f.modifiedAt)}`
            const directory = f.type === 'directory', expanded = expandedFolders.has(f.name)
            return `<div class="file-row ${directory ? 'directory' : ''} ${selectedFiles.has(f.name) ? 'selected' : ''}" style="padding-left:${8 + f.depth * 16}px" data-name="${esc(f.name)}" data-type="${esc(f.type)}" ${directory ? `aria-expanded="${expanded}"` : ''} title="${esc(f.name)}&#10;${esc(meta)}"><span class="file-chevron">${directory ? icon(expanded ? 'chevron-down' : 'chevron-right', 14) : ''}</span>${icon(directory ? (expanded ? 'folder-open' : 'folder') : 'file')}<span class="file-name"><span>${esc(f.name.split('/').pop())}</span></span><button class="file-download icon-button" data-download title="下载" aria-label="下载 ${esc(f.name)}">${icon('download', 14)}</button></div>`
        }).join('')
    }
    else $('#file-list').querySelectorAll<HTMLElement>('.file-row').forEach(row => {
        row.classList.toggle('selected', selectedFiles.has(row.dataset.name ?? ''))
    })
    $('#file-empty').classList.toggle('hidden', !session || !!entries.length)
    $('#file-empty').innerHTML = `<strong>这个文件夹是空的</strong><p>将文件或文件夹拖到此区域，上传至当前目录</p>`
    const picked = visibleFiles().filter(f => selectedFiles.has(f.name))
    $('#file-count').textContent = session ? `${entries.length} 个项目` : '等待连接'
    $('#file-meta').textContent = picked.length === 1 && picked[0].type === 'file' ? `${size(picked[0].size)} · ${when(picked[0].modifiedAt)}` : picked.length ? `已选 ${picked.length}` : ''
    paintIcons()
}

$('#crumb-bar').onclick = e => {
    const button = (e.target as HTMLElement).closest<HTMLElement>('[data-path]')
    if (!button) return
    if (button.dataset.path === currentPath) return
    void loadFiles(button.dataset.path!)
}
const selectionBox = document.createElement('div')
selectionBox.className = 'selection-box hidden'
document.body.appendChild(selectionBox)
const fileMenu = document.createElement('div')
fileMenu.className = 'file-context-menu hidden'
fileMenu.innerHTML = '<button data-action="new-file">新建文件...</button><button data-action="new-folder">新建文件夹...</button><hr><button data-action="copy-path">复制绝对路径</button><button data-action="copy-relative-path">复制相对路径</button><hr><button data-action="preview">预览图片</button><button data-action="download">下载选中项</button><button data-action="delete">删除选中项</button>'
let menuParent = ''
let menuPaths = {absolute: '', relative: ''}
document.body.appendChild(fileMenu)
const previewDialog = document.createElement('dialog')
previewDialog.className = 'image-preview'
previewDialog.innerHTML = '<div class="image-preview-header"><strong></strong><button type="button" class="icon-button" aria-label="关闭预览">×</button></div><div class="image-preview-body"><span class="image-preview-message" role="status"></span><img class="hidden" alt=""></div>'
document.body.appendChild(previewDialog)
const previewTitle = previewDialog.querySelector<HTMLElement>('strong')!
const previewMessage = previewDialog.querySelector<HTMLElement>('.image-preview-message')!
const previewImage = previewDialog.querySelector<HTMLImageElement>('img')!
for (const dir of ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']) {
    const handle = document.createElement('div')
    handle.className = 'image-preview-resize'
    handle.dataset.resize = dir
    handle.title = '拖动调整预览框大小，双击恢复默认'
    handle.setAttribute('aria-hidden', 'true')
    previewDialog.appendChild(handle)
}
const previewHandles = previewDialog.querySelectorAll<HTMLElement>('.image-preview-resize')
const previewDefaultSize = {width: 480, height: 400}
const previewMinSize = {width: 320, height: 240}
let previewSize = {...previewDefaultSize}
let previewURL = ''
let previewRequest: AbortController | undefined
const isPreviewImage = (entry: Entry) => entry.type === 'file' && /\.(jpe?g|png|gif|webp|bmp)$/i.test(entry.name)

function clearPreview() {
    previewRequest?.abort();
    previewRequest = undefined
    previewImage.removeAttribute('src');
    previewImage.classList.add('hidden')
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

function clampPreviewSize(width: number, height: number) {
    const maxWidth = Math.max(1, window.innerWidth - 32)
    const maxHeight = Math.max(1, window.innerHeight - 32)
    return {
        width: Math.round(Math.min(Math.max(width, Math.min(previewMinSize.width, maxWidth)), maxWidth)),
        height: Math.round(Math.min(Math.max(height, Math.min(previewMinSize.height, maxHeight)), maxHeight))
    }
}

function applyPreviewSize(width = previewSize.width, height = previewSize.height) {
    const size = clampPreviewSize(width, height)
    previewSize = size
    previewDialog.style.width = `${size.width}px`
    previewDialog.style.height = `${size.height}px`
}

function setPreviewGeometry(left: number, top: number, width: number, height: number) {
    previewSize = {width: Math.round(width), height: Math.round(height)}
    previewDialog.style.left = `${Math.round(left)}px`
    previewDialog.style.top = `${Math.round(top)}px`
    previewDialog.style.width = `${previewSize.width}px`
    previewDialog.style.height = `${previewSize.height}px`
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

previewHandles.forEach(handle => {
    handle.addEventListener('pointerdown', event => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        const dir = handle.dataset.resize || 'se'
        const rect = previewDialog.getBoundingClientRect()
        const startX = event.clientX, startY = event.clientY
        const startWidth = rect.width, startHeight = rect.height
        const startRight = rect.left + rect.width, startBottom = rect.top + rect.height
        const west = dir.includes('w'), north = dir.includes('n')
        const horizontal = west || dir.includes('e'), vertical = north || dir.includes('s')
        const maxWidth = west ? Math.max(1, startRight) : Math.max(1, window.innerWidth - rect.left)
        const maxHeight = north ? Math.max(1, startBottom) : Math.max(1, window.innerHeight - rect.top)
        const minWidth = Math.min(previewMinSize.width, maxWidth)
        const minHeight = Math.min(previewMinSize.height, maxHeight)
        handle.setPointerCapture(event.pointerId)
        previewDialog.classList.add('resizing')
        const move = (e: PointerEvent) => {
            const size = clampPreviewSize(
                horizontal ? Math.max(minWidth, Math.min(maxWidth, startWidth + (west ? startX - e.clientX : e.clientX - startX))) : startWidth,
                vertical ? Math.max(minHeight, Math.min(maxHeight, startHeight + (north ? startY - e.clientY : e.clientY - startY))) : startHeight
            )
            setPreviewGeometry(
                west ? startRight - size.width : rect.left,
                north ? startBottom - size.height : rect.top,
                size.width,
                size.height
            )
        }
        const finish = () => {
            handle.removeEventListener('pointermove', move)
            handle.removeEventListener('pointerup', finish)
            handle.removeEventListener('pointercancel', finish)
            handle.removeEventListener('lostpointercapture', finish)
            previewDialog.classList.remove('resizing')
        }
        handle.addEventListener('pointermove', move)
        handle.addEventListener('pointerup', finish)
        handle.addEventListener('pointercancel', finish)
        handle.addEventListener('lostpointercapture', finish)
    })
    handle.addEventListener('dblclick', event => {
        event.preventDefault()
        applyPreviewSize(previewDefaultSize.width, previewDefaultSize.height)
        const rect = previewDialog.getBoundingClientRect();
        keepPreviewVisible(rect.left, rect.top)
    })
})
window.addEventListener('resize', () => {
    if (previewDialog.open) {
        applyPreviewSize()
        const rect = previewDialog.getBoundingClientRect();
        keepPreviewVisible(rect.left, rect.top)
    }
})
previewDialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') previewDialog.close()
})

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
    applyPreviewSize()
    if (!previewDialog.open) {
        previewDialog.show()
        if (!previewDialog.style.left) keepPreviewVisible(window.innerWidth - previewDialog.offsetWidth - 16, 16)
        else {
            const rect = previewDialog.getBoundingClientRect();
            keepPreviewVisible(rect.left, rect.top)
        }
    }
    try {
        const response = await api(`/api/sessions/${encodeURIComponent(sid)}/preview?path=${encodeURIComponent(remotePath)}`, {signal: controller.signal})
        const blob = await response.blob()
        if (controller.signal.aborted) return
        if (!/^image\/(jpeg|png|gif|webp|bmp)$/i.test(blob.type)) throw new Error('服务器未返回支持的图片格式')
        previewURL = URL.createObjectURL(blob)
        previewImage.onload = () => {
            previewMessage.classList.add('hidden')
        }
        previewImage.onerror = () => {
            previewImage.classList.add('hidden');
            previewMessage.textContent = '图片无法显示'
        }
        previewImage.src = previewURL
        previewImage.classList.remove('hidden')
    } catch (err) {
        if (!controller.signal.aborted) previewMessage.textContent = `预览失败：${err instanceof Error ? err.message : String(err)}`
    }
}

let suppressFileClick = false
$('#file-list').addEventListener('pointerdown', e => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-download], .file-create-row')) return
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
$('#dropzone').oncontextmenu = e => {
    if ((e.target as HTMLElement).closest('.file-create-row')) return
    if (!session) return
    const row = (e.target as HTMLElement).closest<HTMLElement>('.file-row')
    e.preventDefault()
    menuParent = creationParent(visibleFiles().find(f => f.name === row?.dataset.name))
    if (!row?.dataset.name) {
        selectedFiles.clear()
        renderFiles(false)
    } else if (!selectedFiles.has(row.dataset.name)) {
        selectedFiles.clear();
        selectedFiles.add(row.dataset.name);
        renderFiles(false)
    }
    const previewEntries = visibleFiles().filter(f => selectedFiles.has(f.name))
    const names = [...selectedFiles]
    menuPaths = {absolute: names.map(name => joinPath(currentPath, name)).join('\n'), relative: names.join('\n')}
    $<HTMLButtonElement>('[data-action="copy-path"]').disabled = !names.length
    $<HTMLButtonElement>('[data-action="copy-relative-path"]').disabled = !names.length
    $<HTMLButtonElement>('[data-action="preview"]').disabled = previewEntries.length !== 1 || !isPreviewImage(previewEntries[0])
    $<HTMLButtonElement>('[data-action="download"]').disabled = !selectedFiles.size
    $<HTMLButtonElement>('[data-action="delete"]').disabled = !selectedFiles.size
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
    if (action === 'copy-path' || action === 'copy-relative-path') {
        const text = action === 'copy-path' ? menuPaths.absolute : menuPaths.relative
        if (!text) return
        try {
            if (!await window.runtime.ClipboardSetText(text)) throw new Error('无法写入剪贴板')
            toast(action === 'copy-path' ? '已复制绝对路径' : '已复制相对路径')
        } catch (err) {
            toast(`复制失败：${err instanceof Error ? err.message : String(err)}`)
        }
        return
    }
    if (action === 'new-file' || action === 'new-folder') {
        void createEntry(action === 'new-file' ? 'file' : 'directory', menuParent)
        return
    }
    if (action === 'preview') {
        const entry = visibleFiles().find(f => selectedFiles.has(f.name))
        if (selectedFiles.size === 1 && entry && isPreviewImage(entry)) void previewFile(entry.name)
        return
    }
    if (action === 'download') {
        void downloadSelected();
        return
    }
    if (action !== 'delete' || !session || !selectedFiles.size) return
    const names = [...selectedFiles].filter(name => ![...selectedFiles].some(parent => name.startsWith(parent + '/'))), sid = session, dir = currentPath
    const hasDirectories = visibleFiles().some(f => selectedFiles.has(f.name) && f.type === 'directory')
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
    const rows = visibleFiles()
    const index = rows.findIndex(f => f.name === row.dataset.name)
    if (mouse.shiftKey && selectionAnchor >= 0) {
        if (!mouse.ctrlKey) selectedFiles.clear()
        for (let i = Math.min(selectionAnchor, index); i <= Math.max(selectionAnchor, index); i++) selectedFiles.add(rows[i].name)
    } else if (rows[index]) {
        if (!mouse.ctrlKey && !mouse.metaKey) selectedFiles.clear()
        if ((mouse.ctrlKey || mouse.metaKey) && selectedFiles.has(row.dataset.name)) selectedFiles.delete(row.dataset.name)
        else selectedFiles.add(row.dataset.name)
        selectionAnchor = index
    } else {
        selectedFiles.clear();
        selectionAnchor = index
    }
    renderFiles(false)
    if (row.dataset.type === 'directory' && mouse.detail === 1 && !mouse.shiftKey && !mouse.ctrlKey && !mouse.metaKey) {
        const name = row.dataset.name
        if (expandedFolders.has(name)) {
            cancelCreation?.()
            expandedFolders.delete(name)
            for (const selectedName of selectedFiles) {
                if (selectedName.startsWith(name + '/')) selectedFiles.delete(selectedName)
            }
            renderFiles()
        } else void expandFolder(name)
    }
}
// Text editor contract: GET returns {content, version}; POST accepts both and returns {version}.
const editorDialog = document.createElement('dialog')
editorDialog.className = 'text-editor-dialog'
editorDialog.innerHTML = `<div class="text-editor-header"><div class="text-editor-title"><strong></strong><span></span></div><button type="button" class="icon-button editor-save" title="保存 (Ctrl+S)" aria-label="保存">${icon('save')}</button><button type="button" class="icon-button editor-close" aria-label="关闭">${icon('x')}</button></div><div class="text-editor-status hidden" role="alert"></div><textarea spellcheck="false" aria-label="文件内容" disabled></textarea>`
document.body.appendChild(editorDialog)
const editorArea = editorDialog.querySelector<HTMLTextAreaElement>('textarea')!
const editorTitle = editorDialog.querySelector<HTMLElement>('strong')!
const editorPath = editorDialog.querySelector<HTMLElement>('.text-editor-title span')!
const editorStatus = editorDialog.querySelector<HTMLElement>('.text-editor-status')!
const editorSave = editorDialog.querySelector<HTMLButtonElement>('.editor-save')!
let editor: {sid: string; path: string; cursorKey: string; version: string; saved: string; newline: string; saving: boolean} | undefined
const editorCursors = new Map<string, {start: number; end: number; scrollTop: number; scrollLeft: number}>()
let editorRequest: AbortController | undefined
function editorDirty() { return !!editor && editorArea.value !== editor.saved }
function updateEditor() {
    editorSave.disabled = !editor || editor.saving || !editorDirty()
    editorTitle.textContent = editor ? `${editor.path.split('/').pop()}${editorDirty() ? ' •' : ''}` : '打开文件'
}
function closeTextEditor() {
    if (editor?.saving) return
    if (editorDirty() && !confirm('文件有未保存的修改，确定关闭吗？')) return
    if (editor) editorCursors.set(editor.cursorKey, {
        start: editorArea.selectionStart, end: editorArea.selectionEnd,
        scrollTop: editorArea.scrollTop, scrollLeft: editorArea.scrollLeft
    })
    editorRequest?.abort()
    editor = undefined
    editorDialog.close()
}
editorDialog.querySelector<HTMLButtonElement>('.editor-close')!.onclick = closeTextEditor
editorDialog.addEventListener('cancel', event => { event.preventDefault(); closeTextEditor() })
editorArea.addEventListener('input', updateEditor)
editorDialog.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveTextFile()
    }
})
editorSave.onclick = () => void saveTextFile()
async function openTextFile(entry: Entry) {
    if (!session) return
    if (editorDialog.open) { toast('请先关闭当前编辑器'); return }
    const sid = session, remotePath = joinPath(currentPath, entry.name)
    const cursorKey = JSON.stringify([tabs.find(tab => tab.id === sid)?.connection || sid, remotePath])
    editor = undefined
    editorArea.value = ''
    editorArea.disabled = true
    editorTitle.textContent = entry.name
    editorPath.textContent = remotePath
    editorStatus.classList.add('hidden')
    editorSave.disabled = true
    editorDialog.showModal()
    paintIcons()
    const controller = new AbortController()
    editorRequest = controller
    try {
        const response = await api(`/api/sessions/${encodeURIComponent(sid)}/content?path=${encodeURIComponent(remotePath)}`, {signal: controller.signal})
        const data: unknown = await response.json()
        if (controller.signal.aborted) return
        if (!data || typeof data !== 'object' || typeof (data as any).content !== 'string' || typeof (data as any).version !== 'string') throw new Error('服务器返回的文件内容格式无效')
        const {content, version} = data as {content: string; version: string}
        editorArea.value = content
        editor = {sid, path: remotePath, cursorKey, version, saved: editorArea.value, newline: content.includes('\r\n') ? '\r\n' : '\n', saving: false}
        editorArea.disabled = false
        updateEditor()
        editorArea.focus()
        const cursor = editorCursors.get(cursorKey)
        editorArea.setSelectionRange(cursor?.start ?? 0, cursor?.end ?? 0)
        editorArea.scrollTop = cursor?.scrollTop ?? 0
        editorArea.scrollLeft = cursor?.scrollLeft ?? 0
    } catch (err) {
        if (!controller.signal.aborted) {
            editorStatus.textContent = `打开失败：${err instanceof Error ? err.message : String(err)}`
            editorStatus.classList.remove('hidden')
        }
    }
}
async function saveTextFile() {
    const current = editor
    if (!current || current.saving || !editorDirty()) return
    const value = editorArea.value
    current.saving = true
    editorStatus.classList.add('hidden')
    updateEditor()
    try {
        const response = await api(`/api/sessions/${encodeURIComponent(current.sid)}/content?path=${encodeURIComponent(current.path)}`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({content: value.replace(/\n/g, current.newline), version: current.version})
        })
        const data: unknown = await response.json()
        if (!data || typeof data !== 'object' || typeof (data as any).version !== 'string') throw new Error('服务器未返回保存版本，请重新打开文件确认远端内容')
        current.version = (data as {version: string}).version
        current.saved = value
    } catch (err) {
        editorStatus.textContent = `保存失败：${err instanceof Error ? err.message : String(err)}`
        editorStatus.classList.remove('hidden')
    } finally {
        current.saving = false
        updateEditor()
    }
}
window.addEventListener('beforeunload', event => { if (editorDirty() || editor?.saving) event.preventDefault() })

$('#file-list').ondblclick = e => {
    if ((e.target as HTMLElement).closest('[data-download], .file-create-row')) return
    const row = (e.target as HTMLElement).closest<HTMLElement>('.file-row')
    if (row?.dataset.type === 'directory' && row.dataset.name) void loadFiles(joinPath(currentPath, row.dataset.name))
    else if (row?.dataset.name) {
        const entry = visibleFiles().find(f => f.name === row.dataset.name);
        if (entry && isPreviewImage(entry)) void previewFile(entry.name)
        else if (entry) void openTextFile(entry)
    }
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
            if (transfer.direction === 'upload' || result.totalBytes > 0 || result.transferredBytes > 0) {
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
        const totalSpeed = transfers.reduce((sum, t) => sum + (t.status === '传输中' && Date.now() - (t.speedAt || 0) < 2000 ? (t.speed || 0) : 0), 0)
        $('#transfer-summary').textContent = transfers.length ? `传输 ${done}/${transfers.length}${totalSpeed ? ' · ' + formatSpeed(totalSpeed) : ''}` : '传输'
        $('#transfer-badge').textContent = String(activeJobs.length)
        $('#transfer-badge').classList.toggle('hidden', !activeJobs.length)
        $('#transfers').innerHTML = transfers.map(t => {
            const failed = t.status === '失败' || t.status === '状态未知' || t.status.startsWith('部分')
            const label = t.direction === 'download' ? '下载' : '上传'
            const speed = t.status === '传输中' && t.speedAt ? ` ${formatSpeed(t.speed || 0)}` : ''
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
        resizingPanel = true
        const move = (ev: PointerEvent) => apply(Math.max(180, Math.min(480, read(ev.clientX))))
        const up = (ev: PointerEvent) => {
            const next = read(ev.clientX)
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            window.removeEventListener('pointercancel', up)
            if (next < 160) collapse()
            else apply(Math.max(220, Math.min(480, next)))
            resizingPanel = false
            if (session) requestAnimationFrame(fitTerminal)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', up)
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

const updateSkipKey = 'minishell.update.skipped'
const updateDialog = document.createElement('dialog')
updateDialog.className = 'update-dialog'
updateDialog.tabIndex = -1
updateDialog.setAttribute('aria-labelledby', 'update-dialog-title')
updateDialog.innerHTML = `<div class="update-dialog-head"><span class="update-icon">${icon('download', 18)}</span><div class="update-title"><h2 id="update-dialog-title">发现新版本</h2><p>下载完成后将自动重启 MiniShell</p></div><button type="button" class="icon-button update-close" aria-label="稍后提醒">×</button></div><div class="update-body"><div class="update-versions"><span class="update-version update-current"><small>当前版本</small><code></code></span><span class="update-version-arrow">→</span><span class="update-version latest"><small>最新版本</small><code></code><span class="update-version-size"></span></span></div><section class="update-notes-wrap"><h3>更新内容</h3><div class="update-notes"></div></section><div class="update-progress hidden"><div class="update-progress-track"><div class="update-progress-fill"></div></div><p class="update-progress-text" role="status"></p></div><p class="update-error hidden" role="alert"></p></div><div class="update-actions"><button type="button" class="button update-release">查看发布页</button><span class="update-spacer"></span><button type="button" class="button update-skip">跳过此版本</button><button type="button" class="button primary update-install">立即更新</button></div>`
document.body.appendChild(updateDialog)
paintIcons()

const updateCurrent = updateDialog.querySelector<HTMLElement>('.update-current code')!
const updateLatest = updateDialog.querySelector<HTMLElement>('.update-version.latest code')!
const updateSize = updateDialog.querySelector<HTMLElement>('.update-version-size')!
const updateNotesWrap = updateDialog.querySelector<HTMLElement>('.update-notes-wrap')!
const updateNotes = updateDialog.querySelector<HTMLElement>('.update-notes')!
const updateProgress = updateDialog.querySelector<HTMLElement>('.update-progress')!
const updateProgressTrack = updateDialog.querySelector<HTMLElement>('.update-progress-track')!
const updateProgressFill = updateDialog.querySelector<HTMLElement>('.update-progress-fill')!
const updateProgressText = updateDialog.querySelector<HTMLElement>('.update-progress-text')!
const updateError = updateDialog.querySelector<HTMLElement>('.update-error')!
const updateInstall = updateDialog.querySelector<HTMLButtonElement>('.update-install')!
const updateSkip = updateDialog.querySelector<HTMLButtonElement>('.update-skip')!
const updateRelease = updateDialog.querySelector<HTMLButtonElement>('.update-release')!
const updateClose = updateDialog.querySelector<HTMLButtonElement>('.update-close')!
let pendingUpdate: UpdateInfo | null = null
let installingUpdate = false
let updateReady = false

function setUpdateBusy(busy: boolean) {
    updateInstall.disabled = busy
    updateSkip.disabled = busy
    updateRelease.disabled = busy
    updateClose.disabled = busy
}

function showUpdateError(message: string) {
    updateError.textContent = message
    updateError.classList.remove('hidden')
}

function renderUpdate(info: UpdateInfo) {
    pendingUpdate = info
    installingUpdate = false
    updateReady = false
    updateCurrent.textContent = info.current || '未知'
    updateLatest.textContent = info.latest
    updateSize.textContent = info.assetSize > 0 ? size(info.assetSize) : ''
    updateSize.classList.toggle('hidden', !(info.assetSize > 0))
    const notes = (info.notes || '').trim()
    updateNotes.textContent = notes
    updateNotesWrap.classList.toggle('hidden', !notes)
    updateError.textContent = ''
    updateError.classList.add('hidden')
    updateProgress.classList.add('hidden')
    updateProgressTrack.classList.remove('indeterminate')
    updateProgressFill.style.width = '0'
    updateProgressText.textContent = ''
    updateInstall.textContent = '立即更新'
    setUpdateBusy(false)
}

function updateStageText(stage: string) {
    switch (stage) {
        case 'download':
        case 'downloading':
            return '正在下载更新'
        case 'extract':
        case 'extracting':
            return '正在解压更新'
        case 'apply':
        case 'applying':
            return '正在准备更新'
        case 'restart':
        case 'restarting':
            return '正在重启'
        default:
            return '正在更新'
    }
}

function setUpdateProgress(progress: UpdateProgress) {
    if (!installingUpdate || updateReady || !progress) return
    updateProgress.classList.remove('hidden')
    updateError.classList.add('hidden')
    const percent = Number.isFinite(progress.percent) ? Math.min(100, Math.max(0, progress.percent)) : 0
    const determinate = percent > 0
    updateProgressTrack.classList.toggle('indeterminate', !determinate)
    updateProgressFill.style.width = determinate ? `${percent}%` : '35%'
    const label = (progress.message || '').trim() || updateStageText(progress.stage)
    updateProgressText.textContent = `${label}…${determinate ? ` ${Math.round(percent)}%` : ''}`
}

function finishUpdateProgress() {
    updateProgress.classList.remove('hidden')
    updateProgressTrack.classList.remove('indeterminate')
    updateProgressFill.style.width = '100%'
    updateProgressText.textContent = '更新已准备好，正在重启…'
}

async function installUpdate() {
    if (!pendingUpdate || installingUpdate) return
    if (editorDirty() || editor?.saving) {
        showUpdateError("编辑器中有未保存的修改，请保存后再安装更新")
        return
    }
    const app = window.go?.main?.App
    if (!app || typeof app.InstallUpdate !== 'function') {
        showUpdateError('当前版本不支持自动更新，请从发布页手动下载。')
        return
    }
    installingUpdate = true
    updateReady = false
    setUpdateBusy(true)
    updateInstall.textContent = '正在更新…'
    updateError.textContent = ''
    updateError.classList.add('hidden')
    updateProgress.classList.remove('hidden')
    updateProgressTrack.classList.add('indeterminate')
    updateProgressFill.style.width = '35%'
    updateProgressText.textContent = '正在准备更新…'
    const off = window.runtime?.EventsOn?.('update:progress', setUpdateProgress)
    try {
        await app.InstallUpdate()
        off?.()
        updateReady = true
        finishUpdateProgress()
        setTimeout(() => {
            if (typeof window.runtime?.Quit === 'function') window.runtime.Quit()
        }, 800)
    } catch (err) {
        off?.()
        installingUpdate = false
        setUpdateBusy(false)
        updateInstall.textContent = '重试'
        updateProgress.classList.add('hidden')
        showUpdateError(`更新失败：${err instanceof Error ? err.message : String(err)}。你也可以从发布页手动下载。`)
    }
}

async function checkForUpdates() {
    const app = window.go?.main?.App
    if (!app || typeof app.CheckForUpdate !== 'function') return
    try {
        const info = await app.CheckForUpdate()
        if (!info?.available || !info.current || !info.latest || info.latest === info.current) return
        if (info.current.toLowerCase() === 'dev') return
        if (localStorage.getItem(updateSkipKey) === info.latest) return
        renderUpdate(info)
        if (updateDialog.open) updateDialog.close()
        updateDialog.showModal()
        updateDialog.focus()
    } catch (err) {
        console.warn('Update check failed', err)
    }
}

updateClose.onclick = () => updateDialog.close()
updateSkip.onclick = () => {
    if (!pendingUpdate || installingUpdate) return
    localStorage.setItem(updateSkipKey, pendingUpdate.latest)
    updateDialog.close()
    toast(`已跳过 ${pendingUpdate.latest}，将在下个版本提醒`)
}
updateRelease.onclick = () => {
    if (!pendingUpdate?.releaseUrl) return
    if (typeof window.runtime?.BrowserOpenURL === 'function') window.runtime.BrowserOpenURL(pendingUpdate.releaseUrl)
    else window.open(pendingUpdate.releaseUrl, '_blank', 'noopener')
}
updateInstall.onclick = () => void installUpdate()
updateDialog.addEventListener('cancel', event => {
    if (installingUpdate) event.preventDefault()
})

renderConnections()
renderFiles()
renderTransfers()
setConnected(false)
paintIcons()
setTimeout(() => void checkForUpdates(), 1200)
void desktop().Backend().then(info => {
    backend = info
    window.runtime.OnFileDrop((_x, _y, paths) => {
        void uploadPaths(paths)
    }, false)
}).catch(err => toast(String(err)))
