declare global { interface Window { go: { main: { App: { Backend(): Promise<{base: string; token: string}>; ChooseDirectory(): Promise<string>; ChooseFiles(): Promise<string[]>; ChooseUploadDirectory(): Promise<string>; SubmitUploadStreaming(session: string, remote: string, file: string, requestId: string): Promise<{tasks: {id: string; name: string; size: number}[]; directories: number; skipped: string[]; submissionError: string}>; SubmitDownload(session: string, remote: string, local: string): Promise<string>; TransferStatus(id: string): Promise<{status: string; error: string; transferredBytes: number; totalBytes: number}> } } }; runtime: { OnFileDrop(callback: (x: number, y: number, paths: string[]) => void, useDropTarget: boolean): void; EventsOn(name: string, callback: (event: {requestId: string; task: {id: string; name: string; size: number}}) => void): () => void } } }
let backend = {base: '', token: ''}
const desktop = () => window.go.main.App
import {Terminal} from '@xterm/xterm'
import {FitAddon} from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {createIcons, icons} from 'lucide'
import './style.css'

type Connection = { id: string; name: string; host: string; port: number; username: string; password?: string }
type Entry = { name: string; type: 'file' | 'directory'; size: number; modifiedAt: string }
type Transfer = { name: string; progress: number; status: string; error?: string; direction?: 'upload' | 'download'; speed?: number; speedAt?: number }
type HostKeyInfo = { host: string; port: number; keyType: string; fingerprint: string; changed: boolean; known: string[] }
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
const icon = (name: string, size = 15) => `<i data-lucide="${name}" width="${size}" height="${size}"></i>`
const paintIcons = () => createIcons({icons, attrs: {width: '15', height: '15'}})
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]!))

app.innerHTML = `<header class="topbar"><span class="logo">${icon('terminal')}</span><strong class="tab-label" id="crumb">新标签页</strong><span class="spacer"></span><span class="top-status"><span class="status-dot"></span><span id="status">未连接</span></span></header><div class="shell"><button class="dock hidden" id="open-side" type="button" title="展开左侧">${icon('panel-left')}</button><aside class="sidebar" id="sidebar"><div class="side-resize" id="side-resize" title="拖动调整宽度，拖到最左收起"></div><div class="side-heading"><button class="icon-button" id="toggle-connections" title="收起连接">${icon('chevron-down')}</button><span id="connection-count">连接</span><button class="icon-button" id="add" title="新建连接">${icon('plus')}</button></div><div class="connection-list" id="connections"></div><div id="file-pane" class="hidden"><div class="side-heading"><button class="icon-button" id="toggle-files" title="收起文件">${icon('chevron-down')}</button><span class="file-heading" id="file-heading">文件</span><span class="heading-tools"><button class="icon-button" id="new-file" title="新建文件">${icon('file-plus')}</button><button class="icon-button" id="new-folder" title="新建目录">${icon('folder-plus')}</button><button class="icon-button" id="refresh" title="刷新">${icon('refresh-cw')}</button><button class="icon-button" id="choose" title="上传">${icon('upload')}</button></span></div><div id="file-body"><div class="crumb" id="crumb-bar"></div><form class="path-edit hidden" id="path-form"><input id="path" aria-label="远程路径" spellcheck="false"></form><div class="file-tools"><button class="button" id="download-selected" disabled>下载选中</button><button class="icon-button" id="up" title="上一级">${icon('arrow-up')}</button><button class="icon-button" id="choose-folder" title="上传文件夹">${icon('folder-up')}</button></div><div id="dropzone"><div class="file-list" id="file-list"></div><div id="file-empty" class="file-empty"></div><div class="drop-overlay">${icon('upload', 22)}<strong>松开以上传文件或文件夹</strong></div></div><div class="side-footer"><span id="file-count">等待连接</span><span id="file-meta"></span></div></div></aside><main class="main"><section class="welcome" id="welcome"><div class="welcome-card"><span class="logo">${icon('server', 18)}</span><h1 id="welcome-title">选择一台服务器</h1><p id="welcome-copy">单击连接。一次只能保持一个会话。</p><div id="quick-rows"></div></div></section><section class="terminal-pane hidden" id="terminal-pane"><div id="terminal"></div></section></main><aside class="transfer-rail hidden" id="transfer-rail"><button class="icon-button" id="toggle-transfers" title="传输队列">${icon('arrow-up-down')}</button><span class="badge hidden" id="transfer-badge"></span></aside><aside class="queue hidden" id="queue"><div class="queue-resize" id="queue-resize" title="拖动调整宽度，双击收起"></div><div class="queue-head"><span id="transfer-summary">传输</span><span><button class="button" id="clear-done" type="button">清空完成</button><button class="icon-button" id="close-queue" title="收起">${icon('x')}</button></span></div><div class="transfers" id="transfers"></div></aside></div><dialog id="connection-dialog"><form id="connection-form" class="dialog-content"><div class="dialog-heading"><div><h2 id="dialog-title">新建连接</h2><p>填写服务器信息，保存后可随时连接。</p></div><button type="button" class="icon-button" id="close-dialog">${icon('x')}</button></div><label>连接名称<input name="name" required placeholder="例如：我的服务器" maxlength="80"></label><div class="form-row"><label>主机地址<input name="host" required placeholder="IP 地址或域名"></label><label>端口<input name="port" type="number" min="1" max="65535" required value="22"></label></div><label>用户名<input name="username" required placeholder="例如：root"></label><label>密码<input name="password" type="password" required autocomplete="current-password" placeholder="输入 SSH 密码"></label><p class="form-note">${icon('shield-alert')} 密码会明文保存在此浏览器中。</p><div class="dialog-actions"><button type="button" class="button" id="cancel-dialog">取消</button><button class="button primary">保存连接</button></div></form></dialog><div id="toast" role="status"></div>`

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!
const terminal = new Terminal({cursorBlink: true, fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 13, lineHeight: 1.45, theme: {background: '#0c0c0c', foreground: '#d7dbe2', cursor: '#d7dbe2'}})
const fit = new FitAddon()
terminal.loadAddon(fit)
terminal.open($('#terminal'))

function fitTerminal() {
    if (!session) return
    fit.fit()
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type: 'resize', cols: terminal.cols, rows: terminal.rows}))
}
new ResizeObserver(fitTerminal).observe($('#terminal'))
terminal.onData(data => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type: 'input', data})) })

function toast(message: string) {
    const el = $('#toast')
    el.textContent = message
    el.classList.add('show')
    setTimeout(() => el.classList.remove('show'), 3500)
}
function save() { localStorage.setItem(key, JSON.stringify(connections)); renderConnections() }
function active() { return connections.find(c => c.id === selected) }
function parentPath(path: string) { return path.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/' }
function joinPath(dir: string, name: string) { return `${dir.replace(/\/$/, '')}/${name}` }
function parts(path: string) {
    const names = path.split('/').filter(Boolean)
    return [{label: '/', path: '/'}, ...names.map((label, index) => ({label, path: '/' + names.slice(0, index + 1).join('/')}))]
}
function renderConnections() {
    $('#connection-count').textContent = session ? '连接 · 1' : '连接'
    $('#connections').innerHTML = connections.length ? connections.map(c => `<div class="connection ${selected === c.id ? 'active' : ''} ${session && selected === c.id ? 'online' : ''}"><button class="connection-select" data-select="${esc(c.id)}" title="${esc(c.username)}@${esc(c.host)}:${esc(c.port)}"><span class="status-dot"></span><span class="connection-copy"><strong>${esc(c.name)} <small>${esc(c.username)}@${esc(c.host)}</small></strong></span></button>${session && selected === c.id ? `<button class="connection-off icon-button" data-disconnect title="断开">${icon('unplug', 14)}</button>` : ''}<button class="connection-edit icon-button" data-edit="${esc(c.id)}" title="编辑">${icon('pencil', 14)}</button><button class="connection-delete icon-button" data-delete="${esc(c.id)}" title="删除">${icon('trash-2', 14)}</button></div>`).join('') : `<div class="side-empty">还没有连接<br><span>点击 + 添加服务器</span></div>`
    $('#quick-rows').innerHTML = connections.length ? connections.map(c => `<button class="quick-row" data-quick="${esc(c.id)}" type="button"><span><strong>${esc(c.name)}</strong><small>${esc(c.username)}@${esc(c.host)}:${esc(c.port)}</small></span><span class="button primary">连接</span></button>`).join('') : `<button class="button primary" id="welcome-add" type="button" style="margin-top:14px">添加第一台服务器</button>`
    $('#welcome-add')?.addEventListener('click', () => openEditor())
    const c = active()
    $('#crumb').textContent = session ? (c?.name || 'SSH') : '新标签页'
    $('#welcome-title').textContent = connections.length ? '选择一台服务器' : '还没有连接'
    $('#welcome-copy').textContent = connections.length ? '单击连接。一次只能保持一个会话。' : '先保存一台服务器，再开始使用终端和文件。'
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
    const c = {id: editing || crypto.randomUUID(), name: String(data.get('name')).trim(), host: String(data.get('host')).trim(), port: Number(data.get('port')), username: String(data.get('username')).trim(), password: String(data.get('password') || '')}
    if (!c.name || !c.host || !c.username) { toast('请填写完整的连接信息'); return }
    if (editing) connections = connections.map(x => x.id === editing ? c : x)
    else connections.push(c)
    selected = c.id
    save()
    $<HTMLDialogElement>('#connection-dialog').close()
}
$('#connections').onclick = e => {
    const target = e.target as HTMLElement
    const select = target.closest<HTMLElement>('[data-select]'), edit = target.closest<HTMLElement>('[data-edit]'), del = target.closest<HTMLElement>('[data-delete]')
    if (target.closest('[data-disconnect]')) { void disconnect(); return }
    if (select) { if (select.dataset.select === selected && session) return; selected = select.dataset.select!; renderConnections(); void connect() }
    if (edit) { if (session) { toast('请先断开当前连接'); return } openEditor(connections.find(c => c.id === edit.dataset.edit)) }
    if (del) {
        if (session) { toast('请先断开当前连接'); return }
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
$('#toggle-connections').onclick = () => { connectionsOpen = !connectionsOpen; applyPanels() }
$('#toggle-files').onclick = () => { filesOpen = !filesOpen; applyPanels() }
$('#open-side').onclick = () => { sideOpen = true; sideWidth = Math.max(220, sideWidth); applyPanels() }
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
    const response = await fetch(backend.base + url, {...init, headers: {...((init?.headers || {}) as Record<string, string>), 'X-Minishell-Token': backend.token}})
    if (!response.ok) {
        let message = `请求失败 (${response.status})`
        let data: ApiError['data']
        try { data = await response.json(); message = data?.message || message } catch {}
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
        const response = await api('/api/sessions', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})
        return await response.json()
    } catch (err) {
        const apiErr = err as ApiError
        const info = apiErr.data?.hostKey
        if (apiErr.status !== 409 || !info) throw err
        const mode = await askHostKey(info)
        if (!mode) throw new Error('已取消连接')
        const response = await api('/api/sessions', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({...body, hostKeyMode: mode, hostKeyFingerprint: info.fingerprint})})
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
    if (!c) { openEditor(); return }
    if (!c.password) { toast('请先在编辑中填写密码'); openEditor(c); return }
    if (connecting) return
    if (session) await disconnect()
    connecting = true
    $('#status').textContent = '连接中'
    try {
        const result = await createSession({host: c.host, port: c.port, username: c.username, password: c.password})
        if (!result.id) throw new Error('服务端未返回会话 ID')
        session = result.id
        setConnected(true)
        terminal.clear()
        socket = new WebSocket(`${backend.base.replace('http:', 'ws:')}/api/sessions/${encodeURIComponent(session)}/terminal?token=${encodeURIComponent(backend.token)}`)
        socket.onopen = () => { fitTerminal(); terminal.focus() }
        socket.onmessage = event => {
            try {
                const msg = JSON.parse(event.data)
                if (msg.type === 'output') terminal.write(msg.data)
                else if (msg.type === 'error') toast(msg.message)
            } catch { toast('终端收到无法解析的数据') }
        }
        socket.onclose = () => { if (session) { toast('终端连接已断开'); void disconnect() } }
        socket.onerror = () => toast('终端连接失败')
        currentPath = '/'
        selectedFiles.clear()
        selectionAnchor = -1
        await loadFiles('/')
    } catch (err) {
        $('#status').textContent = '未连接'
        toast(err instanceof Error ? err.message : '连接失败，请检查后端是否运行')
    } finally { connecting = false }
}
async function disconnect() {
    const old = session
    session = ''
    socket?.close()
    socket = undefined
    if (old) try { await api(`/api/sessions/${encodeURIComponent(old)}`, {method: 'DELETE'}) } catch {}
    entries = []
    selectedFiles.clear()
    selectionAnchor = -1
    currentPath = '/'
    setConnected(false)
    renderFiles()
}
async function loadFiles(path: string) {
    if (!session) { toast('请先连接服务器'); return }
    try {
        const res = await api(`/api/sessions/${encodeURIComponent(session)}/files?path=${encodeURIComponent(path)}`)
        const data = await res.json()
        if (typeof data.path !== 'string' || !Array.isArray(data.entries)) throw new Error('服务器返回的文件列表格式有误')
        entries = data.entries.map((item: Record<string, unknown>) => {
            const name = item.name ?? item.Name, type = item.type ?? item.Type, size = item.size ?? item.Size, modifiedAt = item.modifiedAt ?? item.ModifiedAt
            if (typeof name !== 'string' || (type !== 'file' && type !== 'directory') || typeof size !== 'number' || typeof modifiedAt !== 'string') throw new Error('服务器返回的文件信息格式有误')
            return {name, type, size, modifiedAt}
        }).sort((a: Entry, b: Entry) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name, 'zh-CN'))
        currentPath = data.path
        selectedFiles.clear()
        selectionAnchor = -1
        editingPath = false
        renderFiles()
    } catch (err) { toast(err instanceof Error ? err.message : '读取目录失败') }
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
    if (editingPath) { $<HTMLInputElement>('#path').value = currentPath; $<HTMLInputElement>('#path').focus(); return }
    $('#crumb-bar').innerHTML = parts(currentPath).map((part, index) => `${index ? '<span>/</span>' : ''}<button type="button" data-path="${esc(part.path)}">${esc(part.label)}</button>`).join('')
}
function renderFiles() {
    renderPath()
    $('#file-list').innerHTML = entries.map(f => {
        const meta = f.type === 'directory' ? '目录' : `${size(f.size)} · ${when(f.modifiedAt)}`
        return `<div class="file-row ${f.type === 'directory' ? 'directory' : ''} ${selectedFiles.has(f.name) ? 'selected' : ''}" data-name="${esc(f.name)}" data-type="${esc(f.type)}" title="${esc(f.name)}&#10;${esc(meta)}">${icon(f.type === 'directory' ? 'folder' : 'file')}<span class="file-name"><span>${esc(f.name)}</span></span><button class="file-download icon-button" data-download title="${f.type === 'directory' ? '下载文件夹' : '下载'}" aria-label="下载 ${esc(f.name)}">${icon('download', 14)}</button></div>`
    }).join('')
    $('#file-empty').classList.toggle('hidden', !session || !!entries.length)
    $('#file-empty').innerHTML = `<strong>这个文件夹是空的</strong><p>将文件或文件夹拖到此区域，上传至当前目录</p>`
    $<HTMLButtonElement>('#download-selected').disabled = selectedFiles.size === 0
    const picked = entries.filter(f => selectedFiles.has(f.name))
    $('#file-count').textContent = session ? `${entries.length} 个项目` : '等待连接'
    $('#file-meta').textContent = picked.length === 1 && picked[0].type === 'file' ? `${size(picked[0].size)} · ${when(picked[0].modifiedAt)}` : picked.length ? `已选 ${picked.length}` : ''
    paintIcons()
}
$('#crumb-bar').onclick = e => {
    const button = (e.target as HTMLElement).closest<HTMLElement>('[data-path]')
    if (!button) return
    if (button.dataset.path === currentPath) { editingPath = true; renderPath(); return }
    void loadFiles(button.dataset.path!)
}
$('#path-form').onsubmit = e => { e.preventDefault(); void loadFiles($<HTMLInputElement>('#path').value) }
$('#file-list').onclick = e => {
    const mouse = e as MouseEvent, target = e.target as HTMLElement
    const row = target.closest<HTMLElement>('.file-row')
    if (!row?.dataset.name) return
    if (target.closest('[data-download]')) { void downloadFile(row.dataset.name); return }
    const index = entries.findIndex(f => f.name === row.dataset.name)
    if (mouse.shiftKey && selectionAnchor >= 0) {
        if (!mouse.ctrlKey) selectedFiles.clear()
        for (let i = Math.min(selectionAnchor, index); i <= Math.max(selectionAnchor, index); i++) if (entries[i].type === 'file') selectedFiles.add(entries[i].name)
    } else if (entries[index]?.type === 'file') {
        if (!mouse.ctrlKey && !mouse.metaKey) selectedFiles.clear()
        if ((mouse.ctrlKey || mouse.metaKey) && selectedFiles.has(row.dataset.name)) selectedFiles.delete(row.dataset.name)
        else selectedFiles.add(row.dataset.name)
        selectionAnchor = index
    } else { selectedFiles.clear(); selectionAnchor = index }
    renderFiles()
}
$('#file-list').ondblclick = e => {
    if ((e.target as HTMLElement).closest('[data-download]')) return
    const row = (e.target as HTMLElement).closest<HTMLElement>('.file-row')
    if (row?.dataset.type === 'directory' && row.dataset.name) void loadFiles(joinPath(currentPath, row.dataset.name))
}
$('#up').onclick = () => void loadFiles(parentPath(currentPath))
$('#refresh').onclick = () => void loadFiles(currentPath)
$('#download-selected').onclick = async () => {
    if (!selectedFiles.size) return
    const local = await desktop().ChooseDirectory()
    if (!local) return
    for (const name of [...selectedFiles]) await downloadFile(name, local)
}
async function downloadFile(name: string, chosenDir?: string) {
    if (!session) { toast('请先连接服务器'); return }
    const local = chosenDir || await desktop().ChooseDirectory()
    if (!local) return
    const transfer: Transfer = {name, progress: 0, status: '提交中', direction: 'download'}
    transfers.push(transfer)
    setQueue(true)
    renderTransfers()
    try { const id = await desktop().SubmitDownload(session, joinPath(currentPath, name), local); void monitorTask(id, transfer) }
    catch (err) { transfer.status = '失败'; transfer.error = String(err); renderTransfers(); toast(transfer.error) }
}
$('#choose').onclick = async () => {
    if (!session) { toast('请先连接服务器'); return }
    try { const files = await desktop().ChooseFiles(); if (files?.length) await uploadPaths(files) } catch (err) { toast(String(err)) }
}
$('#choose-folder').onclick = async () => {
    if (!session) { toast('请先连接服务器'); return }
    try { const dir = await desktop().ChooseUploadDirectory(); if (dir) await uploadPaths([dir]) } catch (err) { toast(String(err)) }
}
async function uploadPaths(paths: string[]) {
    if (!session) { toast('请先连接服务器'); return }
    const sid = session, remoteDir = currentPath
    for (const localPath of paths) {
        const rootName = localPath.split(/[\\/]/).pop() || localPath
        const pending: Transfer = {name: rootName, progress: 0, status: '扫描中', direction: 'upload'}
        transfers.push(pending)
        setQueue(true)
        renderTransfers()
        const requestId = crypto.randomUUID(), seen = new Set<string>()
        let outstanding = 0, submitting = true
        const refresh = () => { if (!submitting && outstanding === 0 && session === sid && currentPath === remoteDir) void loadFiles(remoteDir) }
        const addTask = (task: {id: string; name: string; size: number}) => {
            if (seen.has(task.id)) return
            seen.add(task.id)
            outstanding++
            const transfer: Transfer = {name: task.name, progress: 0, status: '等待中', direction: 'upload'}
            transfers.push(transfer)
            renderTransfers()
            void monitorTask(task.id, transfer, () => { outstanding--; refresh() })
        }
        const off = window.runtime.EventsOn('upload:task', event => { if (event.requestId === requestId) addTask(event.task) })
        try {
            const result = await desktop().SubmitUploadStreaming(sid, remoteDir, localPath, requestId)
            for (const task of result.tasks) addTask(task)
            if (result.skipped.length) toast(`已跳过 ${result.skipped.length} 个符号链接或特殊文件`)
            if (result.submissionError) { pending.status = '部分提交失败'; pending.error = result.submissionError; toast(result.submissionError) }
            else if (!seen.size) { pending.status = '完成（空目录）'; pending.progress = 100 }
            else transfers = transfers.filter(t => t !== pending)
        } catch (err) { pending.status = '失败'; pending.error = String(err); toast(pending.error) }
        finally { off(); submitting = false; renderTransfers(); refresh() }
    }
}
let activeStatusCalls = 0
const statusWaiters: Array<() => void> = []
async function readTransferStatus(id: string) {
    if (activeStatusCalls >= 32) await new Promise<void>(resolve => statusWaiters.push(resolve))
    else activeStatusCalls++
    try { return await desktop().TransferStatus(id) }
    finally { const next = statusWaiters.shift(); if (next) next(); else activeStatusCalls-- }
}
async function monitorTask(id: string, transfer: Transfer, onDone?: () => void) {
    let previousBytes = 0, previousTime = performance.now()
    try {
        while (true) {
            const result = await readTransferStatus(id)
            const now = performance.now()
            if (transfer.direction === 'upload') {
                const elapsed = (now - previousTime) / 1000
                if (elapsed > 0) { transfer.speed = Math.max(0, (result.transferredBytes - previousBytes) / elapsed); transfer.speedAt = Date.now() }
                previousBytes = result.transferredBytes
                previousTime = now
                if (result.totalBytes > 0) transfer.progress = Math.min(99, Math.floor(result.transferredBytes / result.totalBytes * 100))
            }
            if (result.status === 'created') transfer.status = '等待中'
            else if (result.status === 'in_progress') transfer.status = '传输中'
            else if (result.status === 'success') { transfer.status = '完成'; transfer.progress = 100; transfer.speed = 0; renderTransfers(); onDone?.(); return }
            else if (result.status === 'failed') { transfer.status = '失败'; transfer.speed = 0; transfer.error = result.error; renderTransfers(); onDone?.(); return }
            else throw new Error('未知任务状态: ' + result.status)
            renderTransfers()
            await new Promise(resolve => setTimeout(resolve, 500))
        }
    } catch (err) { transfer.status = '状态未知'; transfer.error = String(err); renderTransfers(); onDone?.() }
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
$('#clear-done').onclick = () => { transfers = transfers.filter(t => !t.status.startsWith('完成')); renderTransfers() }
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
bindResize($('#queue-resize'), x => window.innerWidth - x, width => { queueWidth = width; $('#queue').style.width = `${width}px`; setQueue(true) }, () => setQueue(false))
bindResize($('#side-resize'), x => x, width => { sideWidth = width; sideOpen = true; applyPanels() }, () => { sideOpen = false; applyPanels() })

renderConnections()
renderFiles()
setConnected(false)
paintIcons()
void desktop().Backend().then(info => {
    backend = info
    window.runtime.OnFileDrop((_x, _y, paths) => { void uploadPaths(paths) }, false)
}).catch(err => toast(String(err)))
