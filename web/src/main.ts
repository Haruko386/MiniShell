import {Terminal} from '@xterm/xterm'
import {FitAddon} from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {createIcons, icons} from 'lucide'
import './style.css'

type Connection = { id: string; name: string; host: string; port: number; username: string; password?: string }
type Entry = { name: string; type: 'file' | 'directory'; size: number; modifiedAt: string }
type Transfer = { name: string; progress: number; status: string }
type UploadJob = { file: File; path: string }
type HostKeyInfo = { host: string; port: number; keyType: string; fingerprint: string; changed: boolean; known: string[] }
type ApiError = Error & { status?: number; data?: { message?: string; hostKey?: HostKeyInfo } }
const key = 'minishell.connections.v1'
let connections: Connection[] = JSON.parse(localStorage.getItem(key) || '[]')
let selected = connections[0]?.id || ''
let session = '', socket: WebSocket | undefined, currentPath = '/', entries: Entry[] = [], transfers: Transfer[] = []
const app = document.querySelector<HTMLDivElement>('#app')!
const icon = (name: string, size = 16) => `<i data-lucide="${name}" width="${size}" height="${size}"></i>`
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
}[c]!))
app.innerHTML = `<aside class="sidebar"><div class="brand"><div class="brand-mark">${icon('terminal', 19)}</div><div><strong>MiniShell</strong><span>SSH WORKSPACE</span></div></div><div class="side-heading"><span>连接</span><button class="icon-button" id="add" title="新建连接">${icon('plus', 17)}</button></div><div class="connection-list" id="connections"></div><div class="side-footer">${icon('shield-check', 15)} <span>连接配置保存在本地</span></div></aside><main><header class="topbar"><div class="breadcrumbs"><span>工作区</span>${icon('chevron-right', 14)}<strong id="crumb">未连接</strong></div><div class="top-status"><span class="status-dot"></span><span id="status">未连接</span></div></header><section class="workspace"><div id="quick-connect" class="quick-connect"><div class="quick-list"><div class="quick-heading"><span>快速连接</span><button id="quick-add" class="button secondary" type="button">新建连接</button></div><div id="quick-rows"></div></div></div><div class="workspace-heading"><div><div class="eyebrow">WORKSPACE <span>/</span> SSH</div><h1 id="title">你的远程工作区</h1><p id="subtitle">选择一个连接，开始使用终端和文件管理。</p></div><div class="heading-actions"><button class="button secondary hidden" id="disconnect">${icon('unplug')} 断开连接</button><button class="button primary" id="connect">${icon('plug', 16)} 连接服务器</button></div></div><div class="panels"><section class="terminal-panel"><div class="panel-header terminal-header"><div class="panel-title"><span class="terminal-icon">${icon('terminal', 15)}</span><strong>终端</strong><span class="panel-label">TERMINAL</span></div><span id="terminal-state" class="terminal-state"><span></span> 未连接</span></div><div class="terminal-wrap"><div id="terminal"></div><div id="terminal-empty" class="terminal-empty"><div class="empty-terminal-icon">${icon('terminal', 25)}</div><strong>准备就绪，等待连接</strong><p>连接服务器后，在这里输入命令。</p></div></div><div class="terminal-footer"><span>SSH TERMINAL</span><span id="terminal-target">未建立会话</span></div></section><section class="files-panel"><div class="panel-header file-header"><div class="panel-title"><span class="folder-icon">${icon('folder', 16)}</span><strong>远程文件</strong><span class="panel-label">FILES</span></div><div class="file-actions"><button class="icon-button" id="up" title="上一级">${icon('arrow-up', 16)}</button><button class="icon-button" id="refresh" title="刷新">${icon('refresh-cw', 15)}</button><button class="button upload-button" id="choose">${icon('upload', 15)} 上传文件</button><button class="button upload-button" id="choose-folder">${icon('folder-up', 15)} 上传文件夹</button><input id="file-input" type="file" multiple hidden><input id="folder-input" type="file" webkitdirectory multiple hidden></div></div><div class="path-bar"><span>路径</span><form id="path-form"><span class="path-icon">${icon('folder-open', 15)}</span><input id="path" value="/" aria-label="远程路径" spellcheck="false"><button title="前往路径">${icon('arrow-right', 15)}</button></form><span class="path-hint">Enter 前往</span></div><div class="file-body" id="dropzone"><div class="table-head"><span>名称</span><span>大小</span><span>修改时间</span></div><div id="file-list" class="file-list"></div><div id="file-empty" class="file-empty"><div class="empty-folder">${icon('folder-open', 25)}</div><strong>连接后查看远程文件</strong><p>也可以将文件或文件夹拖到此区域上传</p></div><div class="drop-overlay">${icon('upload-cloud', 30)}<strong>松开以上传文件或文件夹</strong><span>内容将上传至当前目录</span></div></div><div class="files-footer"><span id="file-count">等待连接</span><span>${icon('mouse-pointer-2', 13)} 拖放文件或文件夹到此区域上传</span></div></section></div><div class="transfer-bar"><div><span class="transfer-icon">${icon('arrow-up-down', 15)}</span><strong>传输队列</strong><span id="transfer-summary">暂无传输任务</span></div><button id="toggle-transfers" class="icon-button" title="展开传输队列">${icon('chevron-up', 16)}</button></div><div id="transfers" class="transfers hidden"></div></section></main><dialog id="connection-dialog"><form id="connection-form" class="dialog-content"><div class="dialog-heading"><div><div class="eyebrow">CONNECTION</div><h2 id="dialog-title">新建连接</h2><p>填写服务器信息，保存后可随时连接。</p></div><button type="button" class="icon-button" id="close-dialog">${icon('x', 19)}</button></div><label>连接名称<input name="name" required placeholder="例如：我的服务器" maxlength="80"></label><div class="form-row"><label>主机地址<input name="host" required placeholder="IP 地址或域名"></label><label>端口<input name="port" type="number" min="1" max="65535" required value="22"></label></div><label>用户名<input name="username" required placeholder="例如：root"></label><label>密码<input name="password" type="password" required autocomplete="current-password" placeholder="输入 SSH 密码"></label><p class="form-note">${icon('shield-check', 15)} 密码会明文保存在此浏览器中。</p><div class="dialog-actions"><button type="button" class="button secondary" id="cancel-dialog">取消</button><button class="button primary">保存连接</button></div></form></dialog><div id="toast" role="status"></div>`
const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!
const iconsRefresh = () => createIcons({icons})
const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: 'Cascadia Code, Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.45,
    theme: {background: '#101010', foreground: '#d9e2ef', cursor: '#83cbb6'}
})
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open($('#terminal'))

function fitTerminal() {
    if (session) {
        fit.fit();
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
            type: 'resize',
            cols: terminal.cols,
            rows: terminal.rows
        }))
    }
}

new ResizeObserver(fitTerminal).observe($('#terminal'))
terminal.onData(data => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type: 'input', data}))
})

function toast(message: string) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.add('show');
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
    $('#connections').innerHTML = connections.length ? connections.map(c => `<div class="connection ${selected === c.id ? 'active' : ''}" data-id="${esc(c.id)}"><button class="connection-select" data-select="${esc(c.id)}"><span class="server-icon">${icon('server', 16)}</span><span class="connection-copy"><strong>${esc(c.name)}</strong><small>${esc(c.username)}@${esc(c.host)}</small></span></button><button class="connection-edit icon-button" data-edit="${esc(c.id)}" title="编辑">${icon('pencil', 14)}</button><button class="connection-delete icon-button" data-delete="${esc(c.id)}" title="删除">${icon('trash-2', 14)}</button></div>`).join('') : `<div class="side-empty">还没有连接<br><span>点击 + 添加服务器</span></div>`;
    const c = active();
    $('#title').textContent = c?.name || '你的远程工作区';
    $('#subtitle').textContent = c ? `${c.username}@${c.host}:${c.port}` : '选择一个连接，开始使用终端和文件管理。';
    $('#crumb').textContent = c?.name || '未连接';
    iconsRefresh()
}

let editing = ''

function openEditor(c?: Connection) {
    editing = c?.id || '';
    const form = $<HTMLFormElement>('#connection-form');
    form.reset();
    (form.elements.namedItem('name') as HTMLInputElement).value = c?.name || '';
    (form.elements.namedItem('host') as HTMLInputElement).value = c?.host || '';
    (form.elements.namedItem('port') as HTMLInputElement).value = String(c?.port || 22);
    (form.elements.namedItem('username') as HTMLInputElement).value = c?.username || '';
    (form.elements.namedItem('password') as HTMLInputElement).value = c?.password || '';
    $('#dialog-title').textContent = c ? '编辑连接' : '新建连接';
    $<HTMLDialogElement>('#connection-dialog').showModal()
}

$('#add').onclick = () => openEditor();
$('#close-dialog').onclick = $('#cancel-dialog').onclick = () => $<HTMLDialogElement>('#connection-dialog').close()
$('#connection-form').onsubmit = e => {
    e.preventDefault();
    const data = new FormData(e.target as HTMLFormElement);
    const c = {
        id: editing || crypto.randomUUID(),
        name: String(data.get('name')).trim(),
        host: String(data.get('host')).trim(),
        port: Number(data.get('port')),
        username: String(data.get('username')).trim(),
        password: String(data.get('password') || '')
    };
    if (!c.name || !c.host || !c.username) {
        toast('请填写完整的连接信息');
        return
    }
    if (editing) connections = connections.map(x => x.id === editing ? c : x); else connections.push(c);
    selected = c.id;
    save();
    $<HTMLDialogElement>('#connection-dialog').close()
}
$('#connections').onclick = e => {
    const target = e.target as HTMLElement;
    const select = target.closest<HTMLElement>('[data-select]'), edit = target.closest<HTMLElement>('[data-edit]'),
        del = target.closest<HTMLElement>('[data-delete]');
    if (select) {
        if (session) {
            toast('请先断开当前连接');
            return
        }
        selected = select.dataset.select!;
        renderConnections();
        void connect()
    }
    if (edit) {
        if (session) {
            toast('请先断开当前连接');
            return
        }
        openEditor(connections.find(c => c.id === edit.dataset.edit))
    }
    if (del) {
        if (session) {
            toast('请先断开当前连接');
            return
        }
        const c = connections.find(x => x.id === del.dataset.delete);
        if (c && confirm(`删除连接“${c.name}”？`)) {
            connections = connections.filter(x => x.id !== c.id);
            if (selected === c.id) selected = connections[0]?.id || '';
            save()
        }
    }
}

function setConnected(on: boolean) {
    $('#quick-connect').classList.toggle('hidden', on);
    $('.workspace-heading').classList.toggle('hidden', !on);
    $('.panels').classList.toggle('hidden', !on);
    $('.transfer-bar').classList.toggle('hidden', !on);
    if (!on) $('#transfers').classList.add('hidden');
    $('#crumb').textContent = on ? (active()?.name || 'SSH') : '新标签页';
    $('#status').textContent = on ? '已连接' : '未连接';
    $('.top-status').classList.toggle('online', on);
    $('#terminal-state').innerHTML = `<span></span> ${on ? '已连接' : '未连接'}`;
    $('#terminal-state').classList.toggle('online', on);
    $('#terminal-empty').classList.toggle('hidden', on);
    $('#disconnect').classList.toggle('hidden', !on);
    $('#connect').classList.toggle('hidden', on);
    $('#terminal-target').textContent = on ? `${active()?.username}@${active()?.host}` : '未建立会话'
}

async function api(url: string, init?: RequestInit) {
    const response = await fetch(url, init);
    if (!response.ok) {
        let message = `请求失败 (${response.status})`;
        let data: ApiError['data'];
        try {
            data = await response.json();
            message = data?.message || message
        } catch {
        }
        const error = new Error(message) as ApiError;
        error.status = response.status;
        error.data = data;
        throw error
    }
    return response
}

function askHostKey(info: HostKeyInfo) {
    return new Promise<'once' | 'save' | 'replace' | null>(resolve => {
        const changed = info.changed;
        const title = changed ? '主机密钥已变化' : '首次连接';
        const warning = changed
            ? `<p class="form-note">已保存：${esc((info.known || []).join('、') || '无')}</p><p class="form-note">如果不是服务器重装或换机，请取消连接。</p>`
            : '';
        const primary = changed
            ? '<button class="button primary" value="replace">替换并保存</button>'
            : '<button class="button primary" value="save">永久保存</button>';
        const dialog = document.createElement('dialog');
        dialog.innerHTML = `<form method="dialog" class="dialog-content"><div class="dialog-heading"><div><div class="eyebrow">HOST KEY</div><h2>${title}</h2><p>${esc(info.host)}:${info.port}</p></div></div><p class="form-note">密钥类型：${esc(info.keyType)}</p><p class="form-note">当前指纹：${esc(info.fingerprint)}</p>${warning}<div class="dialog-actions"><button class="button secondary" value="cancel">取消</button><button class="button secondary" value="once">仅本次</button>${primary}</div></form>`;
        document.body.appendChild(dialog);
        dialog.addEventListener('close', () => {
            const value = dialog.returnValue;
            dialog.remove();
            resolve(value === 'once' || value === 'save' || value === 'replace' ? value : null)
        }, {once: true});
        dialog.showModal()
    })
}

async function createSession(body: Record<string, unknown>) {
    try {
        const response = await api('/api/sessions', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body)
        });
        return await response.json()
    } catch (err) {
        const apiErr = err as ApiError;
        const info = apiErr.data?.hostKey;
        if (apiErr.status !== 409 || !info) throw err;
        const mode = await askHostKey(info);
        if (!mode) throw new Error('已取消连接');
        const response = await api('/api/sessions', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({...body, hostKeyMode: mode, hostKeyFingerprint: info.fingerprint})
        });
        return await response.json()
    }
}

$('#quick-add').onclick = () => openEditor();
$('#quick-rows').onclick = e => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-quick]');
    if (!row) return;
    selected = row.dataset.quick!;
    renderConnections();
    $('#connect').click()
};
let connecting = false
$('#connect').onclick = () => {
    void connect()
}

async function connect() {
    const c = active();
    if (!c) {
        openEditor();
        return
    }
    if (!c.password) {
        toast('请先在编辑中填写密码');
        openEditor(c);
        return
    }
    if (connecting) return;
    connecting = true;
    try {
        const password = c.password;
        const result = await createSession({host: c.host, port: c.port, username: c.username, password});
        if (!result.id) throw new Error('服务端未返回会话 ID');
        session = result.id;
        setConnected(true);
        terminal.clear();
        socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/sessions/${encodeURIComponent(session)}/terminal`);
        socket.onopen = () => {
            fitTerminal();
            terminal.focus()
        };
        socket.onmessage = event => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'output') terminal.write(msg.data); else if (msg.type === 'error') toast(msg.message)
            } catch {
                toast('终端收到无法解析的数据')
            }
        };
        socket.onclose = () => {
            if (session) {
                toast('终端连接已断开');
                disconnect()
            }
        };
        socket.onerror = () => toast('终端连接失败');
        currentPath = '/';
        await loadFiles('/')
    } catch (err) {
        toast(err instanceof Error ? err.message : '连接失败，请检查后端是否运行')
    } finally {
        connecting = false
    }
}

async function disconnect() {
    const old = session;
    session = '';
    socket?.close();
    socket = undefined;
    if (old) try {
        await api(`/api/sessions/${encodeURIComponent(old)}`, {method: 'DELETE'})
    } catch {
    }
    entries = [];
    currentPath = '/';
    $('#path').setAttribute('value', '/');
    ($<HTMLInputElement>('#path')).value = '/';
    setConnected(false);
    renderFiles()
}

$('#disconnect').onclick = disconnect

async function loadFiles(path: string) {
    if (!session) {
        toast('请先连接服务器');
        return
    }
    try {
        const res = await api(`/api/sessions/${encodeURIComponent(session)}/files?path=${encodeURIComponent(path)}`);
        const data = await res.json();
        if (typeof data.path !== 'string' || !Array.isArray(data.entries)) throw new Error('服务器返回的文件列表格式有误');
        const parsed: Entry[] = data.entries.map((item: Record<string, unknown>) => {
            const name = item.name ?? item.Name, type = item.type ?? item.Type, size = item.size ?? item.Size,
                modifiedAt = item.modifiedAt ?? item.ModifiedAt;
            if (typeof name !== 'string' || (type !== 'file' && type !== 'directory') || typeof size !== 'number' || typeof modifiedAt !== 'string') throw new Error('服务器返回的文件信息格式有误');
            return {name, type, size, modifiedAt}
        });
        currentPath = data.path;
        entries = parsed.sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name, 'zh-CN'));
        $<HTMLInputElement>('#path').value = currentPath;
        renderFiles()
    } catch (err) {
        toast(err instanceof Error ? err.message : '读取目录失败')
    }
}

function size(n: number) {
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
    return `${(n / 1073741824).toFixed(1)} GB`
}

function renderFiles() {
    $('#file-list').innerHTML = entries.map(f => `<div class="file-row ${f.type === 'directory' ? 'directory' : ''}" data-name="${esc(f.name)}" data-type="${esc(f.type)}"><span class="file-name">${icon(f.type === 'directory' ? 'folder' : 'file', 16)} ${esc(f.name)} <button class="file-download icon-button" data-download title="${f.type === 'directory' ? '下载文件夹' : '下载文件'}" aria-label="下载 ${esc(f.name)}">${icon('download', 14)}</button></span><span>${f.type === 'directory' ? '—' : size(f.size)}</span><span>${f.modifiedAt ? esc(new Date(f.modifiedAt).toLocaleString('zh-CN')) : '—'}</span></div>`).join('');
    $('#file-empty').classList.toggle('hidden', !!entries.length);
    $('#file-empty').innerHTML = session ? `<div class="empty-folder">${icon('folder-open', 25)}</div><strong>这个文件夹是空的</strong><p>将文件或文件夹拖到此区域，上传至当前目录</p>` : `<div class="empty-folder">${icon('folder-open', 25)}</div><strong>连接后查看远程文件</strong><p>也可以将文件或文件夹拖到此区域上传</p>`;
    $('#file-count').textContent = session ? `${entries.length} 个项目` : '等待连接';
    iconsRefresh()
}

$('#file-list').onclick = e => {
    const target = e.target as HTMLElement;
    const button = target.closest<HTMLElement>('[data-download]');
    if (!button) return;
    const row = button.closest<HTMLElement>('.file-row');
    if (row?.dataset.name) void downloadEntry(row.dataset.name)
}

async function downloadEntry(name: string) {
    if (!session) {
        toast('请先连接服务器');
        return
    }
    const local = prompt('输入 Go 服务所在电脑的本地保存目录：', localStorage.getItem('minishell.downloadDirectory') || '');
    if (local === null) return;
    if (!local.trim()) {
        toast('请填写本地保存目录');
        return
    }
    localStorage.setItem('minishell.downloadDirectory', local.trim());
    const sid = session, remote = `${currentPath.replace(/\/$/, '')}/${name}`;
    const transfer: Transfer = {name, progress: 0, status: '下载中'};
    transfers.push(transfer);
    $('#transfers').classList.remove('hidden');
    renderTransfers();
    try {
        await api(`/api/sessions/${encodeURIComponent(sid)}/download?path=${encodeURIComponent(remote)}&local=${encodeURIComponent(local.trim())}`, {cache: 'no-store'});
        transfer.progress = 100;
        transfer.status = '完成';
        toast('下载完成')
    } catch (err) {
        transfer.status = '失败';
        toast(err instanceof Error ? err.message : '下载失败')
    } finally {
        renderTransfers()
    }
}

$('#file-list').ondblclick = e => {
    if ((e.target as HTMLElement).closest('[data-download]')) return;
    const row = (e.target as HTMLElement).closest<HTMLElement>('.file-row');
    if (row?.dataset.type === 'directory') loadFiles(`${currentPath.replace(/\/$/, '')}/${row.dataset.name}`)
}
$('#path-form').onsubmit = e => {
    e.preventDefault();
    loadFiles($<HTMLInputElement>('#path').value)
};
$('#up').onclick = () => loadFiles(currentPath.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/');
$('#refresh').onclick = () => loadFiles(currentPath)
$('#choose').onclick = () => {
    if (!session) {
        toast('请先连接服务器');
        return
    }
    $<HTMLInputElement>('#file-input').click()
};
$('#choose-folder').onclick = () => {
    if (!session) {
        toast('请先连接服务器');
        return
    }
    $<HTMLInputElement>('#folder-input').click()
};
$('#file-input').onchange = e => {
    const input = e.target as HTMLInputElement;
    upload(Array.from(input.files || []).map(file => ({file, path: file.name})));
    input.value = ''
}
$('#folder-input').onchange = e => {
    const input = e.target as HTMLInputElement;
    upload(Array.from(input.files || []).map(file => ({file, path: file.webkitRelativePath || file.name})));
    input.value = ''
}
const drop = $('#dropzone');
let drag = 0;

// Read dropped entries recursively so folder uploads keep their structure.
function readEntry(entry: FileSystemEntry): Promise<UploadJob[]> {
    if (entry.isFile) {
        return new Promise((resolve, reject) => {
            (entry as FileSystemFileEntry).file(
                file => resolve([{file, path: entry.fullPath.replace(/^\//, '')}]),
                reject
            )
        })
    }

    if (!entry.isDirectory) return Promise.resolve([]);

    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const readBatch = () => new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    return (async () => {
        const jobs: UploadJob[] = [];
        let batch = await readBatch();
        while (batch.length) {
            for (const child of batch) jobs.push(...await readEntry(child));
            batch = await readBatch()
        }
        return jobs
    })()
}

async function readDrop(data: DataTransfer) {
    const roots = Array.from(data.items)
        .map(item => item.webkitGetAsEntry?.())
        .filter((entry): entry is FileSystemEntry => !!entry);
    if (!roots.length) return Array.from(data.files).map(file => ({file, path: file.name}));
    const jobs: UploadJob[] = [];
    for (const root of roots) jobs.push(...await readEntry(root));
    return jobs
}

drop.ondragenter = e => {
    e.preventDefault();
    drag++;
    drop.classList.add('dragging')
};
drop.ondragover = e => e.preventDefault();
drop.ondragleave = e => {
    e.preventDefault();
    if (--drag <= 0) {
        drag = 0;
        drop.classList.remove('dragging')
    }
};
drop.ondrop = async e => {
    e.preventDefault();
    drag = 0;
    drop.classList.remove('dragging');
    if (!e.dataTransfer) return;
    try {
        upload(await readDrop(e.dataTransfer))
    } catch {
        toast('读取拖放内容失败')
    }
}

function renderTransfers() {
    const done = transfers.filter(t => t.status === '完成').length;
    $('#transfer-summary').textContent = transfers.length ? `${done} / ${transfers.length} 已完成` : '暂无传输任务';
    $('#transfers').innerHTML = transfers.map(t => `<div class="transfer-row"><span>${icon('file', 15)} ${esc(t.name)}</span><div class="progress"><div style="width:${t.progress}%"></div></div><span>${esc(t.status)}</span></div>`).join('');
    iconsRefresh()
}

$('#toggle-transfers').onclick = () => $('#transfers').classList.toggle('hidden')

async function upload(jobs: UploadJob[]) {
    if (!session) {
        toast('请先连接服务器');
        return
    }
    if (!jobs.length) return;
    const sid = session, path = currentPath;
    const queue = jobs.map(job => ({job, transfer: {name: job.path, progress: 0, status: '等待中'}}));
    transfers.push(...queue.map(item => item.transfer));
    $('#transfers').classList.remove('hidden');
    renderTransfers();
    let next = 0;

    async function worker() {
        while (next < queue.length) {
            const item = queue[next++];
            item.transfer.status = '上传中';
            renderTransfers();
            await new Promise<void>(resolve => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', `/api/sessions/${encodeURIComponent(sid)}/files?path=${encodeURIComponent(path)}`);
                xhr.upload.onprogress = e => {
                    if (e.lengthComputable) {
                        item.transfer.progress = Math.round(e.loaded / e.total * 100);
                        renderTransfers()
                    }
                };
                xhr.onload = () => {
                    item.transfer.status = xhr.status >= 200 && xhr.status < 300 ? '完成' : `失败 (${xhr.status})`;
                    renderTransfers();
                    resolve()
                };
                xhr.onerror = () => {
                    item.transfer.status = '网络错误';
                    renderTransfers();
                    resolve()
                };
                const form = new FormData();
                form.append('file', item.job.file);
                form.append('relative', item.job.path);
                xhr.send(form)
            })
        }
    }

    await Promise.all(Array.from({length: Math.min(3, queue.length)}, worker));
    if (session === sid && currentPath === path) loadFiles(path)
}

renderConnections();
renderFiles();
setConnected(false);
iconsRefresh()