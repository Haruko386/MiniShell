declare global { interface Window { go: { main: { App: { Backend():Promise<{base:string;token:string}>; ChooseDirectory():Promise<string>; ChooseFiles():Promise<string[]>; ChooseUploadDirectory():Promise<string>; SubmitUploadStreaming(session:string,remote:string,file:string,requestId:string):Promise<{tasks:{id:string;name:string;size:number}[];directories:number;skipped:string[];submissionError:string}>; SubmitDownload(session:string,remote:string,local:string):Promise<string>; TransferStatus(id:string):Promise<{status:string;error:string;transferredBytes:number;totalBytes:number}> } } }; runtime: { OnFileDrop(callback:(x:number,y:number,paths:string[])=>void,useDropTarget:boolean):void; EventsOn(name:string,callback:(event:{requestId:string;task:{id:string;name:string;size:number}})=>void):()=>void } } }
let backend={base:'',token:''}
const desktop=()=>window.go.main.App
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { createIcons, icons } from 'lucide'
import './style.css'

type Connection = { id:string; name:string; host:string; port:number; username:string; password?:string }
type Entry = { name:string; type:'file'|'directory'; size:number; modifiedAt:string }
type Transfer = { name:string; progress:number; status:string; error?:string; direction?:'upload'|'download'; speed?:number; speedAt?:number }
type HostKeyInfo = { host:string; port:number; keyType:string; fingerprint:string; changed:boolean; known:string[] }
type ApiError = Error & { status?:number; data?:{ message?:string; hostKey?:HostKeyInfo } }
const key = 'minishell.connections.v1'
let connections:Connection[] = JSON.parse(localStorage.getItem(key) || '[]')
let selected = connections[0]?.id || ''
let selectedFiles = new Set<string>(); let selectionAnchor = -1
let session = '', socket:WebSocket | undefined, currentPath = '/', entries:Entry[] = [], transfers:Transfer[] = []
const app = document.querySelector<HTMLDivElement>('#app')!
const icon = (name:string, size=16) => `<i data-lucide="${name}" width="${size}" height="${size}"></i>`
const esc = (s:unknown) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
app.innerHTML = `<aside class="sidebar"><div class="brand"><div class="brand-mark">${icon('terminal',19)}</div><div><strong>MiniShell</strong><span>SSH WORKSPACE</span></div></div><div class="side-heading"><span>连接</span><button class="icon-button" id="add" title="新建连接">${icon('plus',17)}</button></div><div class="connection-list" id="connections"></div><div class="side-footer">${icon('shield-check',15)} <span>连接配置保存在本地</span></div></aside><main><header class="topbar"><div class="breadcrumbs"><span>工作区</span>${icon('chevron-right',14)}<strong id="crumb">未连接</strong></div><div class="top-status"><span class="status-dot"></span><span id="status">未连接</span></div></header><section class="workspace"><div id="quick-connect" class="quick-connect"><div class="quick-list"><div class="quick-heading"><span>快速连接</span><button id="quick-add" class="button secondary" type="button">新建连接</button></div><div id="quick-rows"></div></div></div><div class="workspace-heading"><div><div class="eyebrow">WORKSPACE <span>/</span> SSH</div><h1 id="title">你的远程工作区</h1><p id="subtitle">选择一个连接，开始使用终端和文件管理。</p></div><div class="heading-actions"><button class="button secondary hidden" id="disconnect">${icon('unplug')} 断开连接</button><button class="button primary" id="connect">${icon('plug',16)} 连接服务器</button></div></div><div class="panels"><section class="terminal-panel"><div class="panel-header terminal-header"><div class="panel-title"><span class="terminal-icon">${icon('terminal',15)}</span><strong>终端</strong><span class="panel-label">TERMINAL</span></div><span id="terminal-state" class="terminal-state"><span></span> 未连接</span></div><div class="terminal-wrap"><div id="terminal"></div><div id="terminal-empty" class="terminal-empty"><div class="empty-terminal-icon">${icon('terminal',25)}</div><strong>准备就绪，等待连接</strong><p>连接服务器后，在这里输入命令。</p></div></div><div class="terminal-footer"><span>SSH TERMINAL</span><span id="terminal-target">未建立会话</span></div></section><section class="files-panel"><div class="panel-header file-header"><div class="panel-title"><span class="folder-icon">${icon('folder',16)}</span><strong>远程文件</strong><span class="panel-label">FILES</span></div><div class="file-actions"><button class="button upload-button" id="download-selected" disabled>下载选中</button><button class="icon-button" id="up" title="上一级">${icon('arrow-up',16)}</button><button class="icon-button" id="refresh" title="刷新">${icon('refresh-cw',15)}</button><button class="button upload-button" id="choose">${icon('upload',15)} 上传文件</button><button class="button upload-button" id="choose-folder">${icon('folder-up',15)} 上传文件夹</button><input id="file-input" type="file" multiple hidden></div></div><div class="path-bar"><span>路径</span><form id="path-form"><span class="path-icon">${icon('folder-open',15)}</span><input id="path" value="/" aria-label="远程路径" spellcheck="false"><button title="前往路径">${icon('arrow-right',15)}</button></form><span class="path-hint">Enter 前往</span></div><div class="file-body" id="dropzone"><div class="table-head"><span>名称</span><span>大小</span><span>修改时间</span></div><div id="file-list" class="file-list"></div><div id="file-empty" class="file-empty"><div class="empty-folder">${icon('folder-open',25)}</div><strong>连接后查看远程文件</strong><p>也可以将文件或文件夹拖到此区域上传</p></div><div class="drop-overlay">${icon('upload-cloud',30)}<strong>松开以上传文件</strong><span>文件将上传至当前目录</span></div></div><div class="files-footer"><span id="file-count">等待连接</span><span>${icon('mouse-pointer-2',13)} 拖放文件到此区域上传</span></div></section></div><div class="transfer-bar"><div><span class="transfer-icon">${icon('arrow-up-down',15)}</span><strong>传输队列</strong><span id="transfer-summary">暂无传输任务</span></div><button id="toggle-transfers" class="icon-button" title="展开传输队列">${icon('chevron-up',16)}</button></div><div id="transfers" class="transfers hidden"></div></section></main><dialog id="connection-dialog"><form id="connection-form" class="dialog-content"><div class="dialog-heading"><div><div class="eyebrow">CONNECTION</div><h2 id="dialog-title">新建连接</h2><p>填写服务器信息，保存后可随时连接。</p></div><button type="button" class="icon-button" id="close-dialog">${icon('x',19)}</button></div><label>连接名称<input name="name" required placeholder="例如：我的服务器" maxlength="80"></label><div class="form-row"><label>主机地址<input name="host" required placeholder="IP 地址或域名"></label><label>端口<input name="port" type="number" min="1" max="65535" required value="22"></label></div><label>用户名<input name="username" required placeholder="例如：root"></label><label>密码<input name="password" type="password" required autocomplete="current-password" placeholder="输入 SSH 密码"></label><p class="form-note">${icon('shield-check',15)} 密码会明文保存在此浏览器中。</p><div class="dialog-actions"><button type="button" class="button secondary" id="cancel-dialog">取消</button><button class="button primary">保存连接</button></div></form></dialog><div id="toast" role="status"></div>`
const $ = <T extends HTMLElement>(s:string) => document.querySelector<T>(s)!
const iconsRefresh = () => createIcons({icons})
const terminal = new Terminal({cursorBlink:true,fontFamily:'Cascadia Code, Consolas, monospace',fontSize:13,lineHeight:1.45,theme:{background:'#101010',foreground:'#d9e2ef',cursor:'#83cbb6'}})
const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open($('#terminal'))
function fitTerminal(){ if(session){ fit.fit(); if(socket?.readyState===WebSocket.OPEN) socket.send(JSON.stringify({type:'resize',cols:terminal.cols,rows:terminal.rows})) } }
new ResizeObserver(fitTerminal).observe($('#terminal'))
terminal.onData(data => { if(socket?.readyState===WebSocket.OPEN) socket.send(JSON.stringify({type:'input',data})) })
function toast(message:string){ const el=$('#toast'); el.textContent=message; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),3500) }
function save(){localStorage.setItem(key,JSON.stringify(connections)); renderConnections()}
function active(){return connections.find(c=>c.id===selected)}
function renderConnections(){ $('#connections').innerHTML = connections.length ? connections.map(c=>`<div class="connection ${selected===c.id?'active':''}" data-id="${esc(c.id)}"><button class="connection-select" data-select="${esc(c.id)}"><span class="server-icon">${icon('server',16)}</span><span class="connection-copy"><strong>${esc(c.name)}</strong><small>${esc(c.username)}@${esc(c.host)}</small></span></button><button class="connection-edit icon-button" data-edit="${esc(c.id)}" title="编辑">${icon('pencil',14)}</button><button class="connection-delete icon-button" data-delete="${esc(c.id)}" title="删除">${icon('trash-2',14)}</button></div>`).join('') : `<div class="side-empty">还没有连接<br><span>点击 + 添加服务器</span></div>`; const c=active(); $('#title').textContent=c?.name || '你的远程工作区'; $('#subtitle').textContent=c ? `${c.username}@${c.host}:${c.port}` : '选择一个连接，开始使用终端和文件管理。'; $('#crumb').textContent=c?.name || '未连接'; iconsRefresh() }
let editing=''
function openEditor(c?:Connection){ editing=c?.id||''; const form=$<HTMLFormElement>('#connection-form'); form.reset(); (form.elements.namedItem('name') as HTMLInputElement).value=c?.name||''; (form.elements.namedItem('host') as HTMLInputElement).value=c?.host||''; (form.elements.namedItem('port') as HTMLInputElement).value=String(c?.port||22); (form.elements.namedItem('username') as HTMLInputElement).value=c?.username||''; (form.elements.namedItem('password') as HTMLInputElement).value=c?.password||''; $('#dialog-title').textContent=c?'编辑连接':'新建连接'; $<HTMLDialogElement>('#connection-dialog').showModal() }
$('#add').onclick=()=>openEditor(); $('#close-dialog').onclick=$('#cancel-dialog').onclick=()=>$<HTMLDialogElement>('#connection-dialog').close()
$('#connection-form').onsubmit=e=>{e.preventDefault(); const data=new FormData(e.target as HTMLFormElement); const c={id:editing||crypto.randomUUID(),name:String(data.get('name')).trim(),host:String(data.get('host')).trim(),port:Number(data.get('port')),username:String(data.get('username')).trim(),password:String(data.get('password')||'')}; if(!c.name||!c.host||!c.username){toast('请填写完整的连接信息');return} if(editing) connections=connections.map(x=>x.id===editing?c:x); else connections.push(c); selected=c.id; save(); $<HTMLDialogElement>('#connection-dialog').close()}
$('#connections').onclick=e=>{const target=e.target as HTMLElement; const select=target.closest<HTMLElement>('[data-select]'), edit=target.closest<HTMLElement>('[data-edit]'), del=target.closest<HTMLElement>('[data-delete]'); if(select){if(session){toast('请先断开当前连接');return} selected=select.dataset.select!; renderConnections(); void connect()} if(edit){if(session){toast('请先断开当前连接');return} openEditor(connections.find(c=>c.id===edit.dataset.edit))} if(del){if(session){toast('请先断开当前连接');return} const c=connections.find(x=>x.id===del.dataset.delete); if(c && confirm(`删除连接“${c.name}”？`)){connections=connections.filter(x=>x.id!==c.id); if(selected===c.id)selected=connections[0]?.id||''; save()}}}
function setConnected(on:boolean){$('#quick-connect').classList.toggle('hidden',on); $('.workspace-heading').classList.toggle('hidden',!on); $('.panels').classList.toggle('hidden',!on); $('.transfer-bar').classList.toggle('hidden',!on); if(!on) $('#transfers').classList.add('hidden'); $('#crumb').textContent=on ? (active()?.name || 'SSH') : '新标签页'; $('#status').textContent=on?'已连接':'未连接'; $('.top-status').classList.toggle('online',on); $('#terminal-state').innerHTML=`<span></span> ${on?'已连接':'未连接'}`; $('#terminal-state').classList.toggle('online',on); $('#terminal-empty').classList.toggle('hidden',on); $('#disconnect').classList.toggle('hidden',!on); $('#connect').classList.toggle('hidden',on); $('#terminal-target').textContent=on?`${active()?.username}@${active()?.host}`:'未建立会话'}
async function api(url:string, init?:RequestInit){
 const response=await fetch(backend.base+url,{...init,headers:{...((init?.headers||{}) as Record<string,string>),'X-Minishell-Token':backend.token}})
 if(!response.ok){
  let message=`请求失败 (${response.status})`
  let data:ApiError['data']
  try{data=await response.json();message=data?.message||message}catch{}
  const error=new Error(message) as ApiError
  error.status=response.status
  error.data=data
  throw error
 }
 return response
}

function askHostKey(info:HostKeyInfo){
 return new Promise<'once'|'save'|null>(resolve=>{
  const dialog=document.createElement('dialog')
  dialog.innerHTML=`<form method="dialog" class="dialog-content"><div class="dialog-heading"><div><div class="eyebrow">HOST KEY</div><h2>首次连接</h2><p>${esc(info.host)}:${info.port}</p></div></div><p class="form-note">密钥类型：${esc(info.keyType)}</p><p class="form-note">指纹：${esc(info.fingerprint)}</p><div class="dialog-actions"><button class="button secondary" value="cancel">取消</button><button class="button secondary" value="once">仅本次</button><button class="button primary" value="save">永久保存</button></div></form>`
  document.body.appendChild(dialog)
  dialog.addEventListener('close',()=>{
   const value=dialog.returnValue
   dialog.remove()
   resolve(value==='once'||value==='save'?value:null)
  },{once:true})
  dialog.showModal()
 })
}

async function createSession(body:Record<string,unknown>){
 try{
  const response=await api('/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  return await response.json()
 }catch(err){
  const apiErr=err as ApiError
  const info=apiErr.data?.hostKey
  if(apiErr.status!==409||!info) throw err
  if(info.changed) throw new Error(`主机密钥已变化。当前指纹：${info.fingerprint}；已保存：${(info.known||[]).join('、')||'无'}`)
  const mode=await askHostKey(info)
  if(!mode) throw new Error('已取消连接')
  const response=await api('/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,hostKeyMode:mode,hostKeyFingerprint:info.fingerprint})})
  return await response.json()
 }
}

$('#quick-add').onclick=()=>openEditor(); $('#quick-rows').onclick=e=>{const row=(e.target as HTMLElement).closest<HTMLElement>('[data-quick]'); if(!row)return; selected=row.dataset.quick!; renderConnections(); $('#connect').click()};
let connecting=false
$('#connect').onclick=()=>{void connect()}
async function connect(){ const c=active(); if(!c){openEditor();return} if(!c.password){toast('请先在编辑中填写密码');openEditor(c);return} if(connecting)return; connecting=true; try{const password=c.password; const result=await createSession({host:c.host,port:c.port,username:c.username,password}); if(!result.id)throw new Error('服务端未返回会话 ID'); session=result.id; setConnected(true); terminal.clear(); socket=new WebSocket(`${backend.base.replace('http:','ws:')}/api/sessions/${encodeURIComponent(session)}/terminal?token=${encodeURIComponent(backend.token)}`); socket.onopen=()=>{fitTerminal();terminal.focus()}; socket.onmessage=event=>{try{const msg=JSON.parse(event.data); if(msg.type==='output')terminal.write(msg.data); else if(msg.type==='error')toast(msg.message)}catch{toast('终端收到无法解析的数据')}}; socket.onclose=()=>{if(session){toast('终端连接已断开'); disconnect()}}; socket.onerror=()=>toast('终端连接失败'); currentPath='/'; await loadFiles('/') }catch(err){toast(err instanceof Error?err.message:'连接失败，请检查后端是否运行')}finally{connecting=false}}
async function disconnect(){const old=session; session=''; socket?.close(); socket=undefined; if(old)try{await api(`/api/sessions/${encodeURIComponent(old)}`,{method:'DELETE'})}catch{} entries=[]; currentPath='/'; $('#path').setAttribute('value','/'); ($<HTMLInputElement>('#path')).value='/'; setConnected(false); renderFiles()}
$('#disconnect').onclick=disconnect
async function loadFiles(path:string){if(!session){toast('请先连接服务器');return} try{const res=await api(`/api/sessions/${encodeURIComponent(session)}/files?path=${encodeURIComponent(path)}`); const data=await res.json(); if(typeof data.path!=='string'||!Array.isArray(data.entries))throw new Error('服务器返回的文件列表格式有误'); const parsed:Entry[]=data.entries.map((item:Record<string,unknown>)=>{ const name=item.name ?? item.Name, type=item.type ?? item.Type, size=item.size ?? item.Size, modifiedAt=item.modifiedAt ?? item.ModifiedAt; if(typeof name!=='string'||(type!=='file'&&type!=='directory')||typeof size!=='number'||typeof modifiedAt!=='string')throw new Error('服务器返回的文件信息格式有误'); return {name,type,size,modifiedAt} }); currentPath=data.path; selectedFiles.clear(); selectionAnchor=-1; entries=parsed.sort((a,b)=>Number(b.type==='directory')-Number(a.type==='directory') || a.name.localeCompare(b.name, 'zh-CN')); $<HTMLInputElement>('#path').value=currentPath; renderFiles()}catch(err){toast(err instanceof Error?err.message:'读取目录失败')}}
function size(n:number){if(n<1024)return `${n} B`; if(n<1048576)return `${(n/1024).toFixed(1)} KB`; if(n<1073741824)return `${(n/1048576).toFixed(1)} MB`; return `${(n/1073741824).toFixed(1)} GB`}
function renderFiles(){ $('#file-list').innerHTML=entries.map(f=>`<div class="file-row ${f.type==='directory'?'directory':''} ${selectedFiles.has(f.name)?'selected':''}" data-name="${esc(f.name)}" data-type="${esc(f.type)}"><span class="file-name">${icon(f.type==='directory'?'folder':'file',16)} ${esc(f.name)} ${f.type==='file'?`<button class="file-download icon-button" data-download title="下载文件" aria-label="下载 ${esc(f.name)}">${icon('download',14)}</button>`:''}</span><span>${f.type==='directory'?'—':size(f.size)}</span><span>${f.modifiedAt?esc(new Date(f.modifiedAt).toLocaleString('zh-CN')):'—'}</span></div>`).join(''); $('#file-empty').classList.toggle('hidden',!!entries.length); $('#file-empty').innerHTML=session?`<div class="empty-folder">${icon('folder-open',25)}</div><strong>这个文件夹是空的</strong><p>将文件或文件夹拖到此区域，上传至当前目录</p>`:`<div class="empty-folder">${icon('folder-open',25)}</div><strong>连接后查看远程文件</strong><p>也可以将文件或文件夹拖到此区域上传</p>`; $<HTMLButtonElement>('#download-selected').disabled=selectedFiles.size===0; $('#file-count').textContent=session?`${entries.length} 个项目`:'等待连接'; iconsRefresh()}
$('#file-list').onclick=e=>{const mouse=e as MouseEvent, target=e.target as HTMLElement; const row=target.closest<HTMLElement>('.file-row'); if(!row?.dataset.name)return; if(target.closest('[data-download]')){void downloadFile(row.dataset.name);return} const index=entries.findIndex(f=>f.name===row.dataset.name); if(mouse.shiftKey&&selectionAnchor>=0){if(!mouse.ctrlKey)selectedFiles.clear(); for(let i=Math.min(selectionAnchor,index);i<=Math.max(selectionAnchor,index);i++)if(entries[i].type==='file')selectedFiles.add(entries[i].name)}else if(entries[index]?.type==='file'){if(!mouse.ctrlKey&&!mouse.metaKey)selectedFiles.clear(); if((mouse.ctrlKey||mouse.metaKey)&&selectedFiles.has(row.dataset.name))selectedFiles.delete(row.dataset.name);else selectedFiles.add(row.dataset.name); selectionAnchor=index}else {selectedFiles.clear();selectionAnchor=index} document.querySelectorAll<HTMLElement>('.file-row').forEach(row=>row.classList.toggle('selected',selectedFiles.has(row.dataset.name||''))); $<HTMLButtonElement>('#download-selected').disabled=selectedFiles.size===0}
$('#download-selected').onclick=async()=>{if(!selectedFiles.size)return; const local=await desktop().ChooseDirectory(); if(!local)return; for(const name of [...selectedFiles])await downloadFile(name,local)}

async function downloadFile(name:string,chosenDir?:string){
 if(!session){toast('请先连接服务器');return}
 const local=chosenDir||await desktop().ChooseDirectory(); if(!local)return
 const sid=session, remote=`${currentPath.replace(/\/$/,'')}/${name}`
 const transfer:Transfer={name,progress:0,status:'提交中',direction:'download'}; transfers.push(transfer); $('#transfers').classList.remove('hidden'); renderTransfers()
 try{const id=await desktop().SubmitDownload(sid,remote,local); void monitorTask(id,transfer)}catch(err){transfer.status='失败';transfer.error=String(err);renderTransfers();toast(transfer.error)}
}

$('#file-list').ondblclick=e=>{if((e.target as HTMLElement).closest('[data-download]'))return; const row=(e.target as HTMLElement).closest<HTMLElement>('.file-row'); if(row?.dataset.type==='directory')loadFiles(`${currentPath.replace(/\/$/,'')}/${row.dataset.name}`)}
$('#path-form').onsubmit=e=>{e.preventDefault();loadFiles($<HTMLInputElement>('#path').value)}; $('#up').onclick=()=>loadFiles(currentPath.replace(/\/+$/,'').replace(/\/[^/]*$/,'')||'/'); $('#refresh').onclick=()=>loadFiles(currentPath)
$('#choose').onclick=async()=>{if(!session){toast('请先连接服务器');return} try{const files=await desktop().ChooseFiles(); if(files?.length) await uploadPaths(files)}catch(err){toast(String(err))}}
$('#choose-folder').onclick=async()=>{if(!session){toast('请先连接服务器');return} try{const dir=await desktop().ChooseUploadDirectory(); if(dir) await uploadPaths([dir])}catch(err){toast(String(err))}}
async function uploadPaths(paths:string[]){
 if(!session){toast('请先连接服务器');return}
 const sid=session,remoteDir=currentPath
 for(const localPath of paths){
  const rootName=localPath.split(/[\\/]/).pop()||localPath
  const pending:Transfer={name:rootName,progress:0,status:'扫描中',direction:'upload'};transfers.push(pending);$('#transfers').classList.remove('hidden');renderTransfers()
  const requestId=crypto.randomUUID(), seen=new Set<string>();let outstanding=0,submitting=true
  const refresh=()=>{if(!submitting&&outstanding===0&&session===sid&&currentPath===remoteDir)void loadFiles(remoteDir)}
  const addTask=(task:{id:string;name:string;size:number})=>{
   if(seen.has(task.id))return;seen.add(task.id);outstanding++
   const transfer:Transfer={name:task.name,progress:0,status:'等待中',direction:'upload'};transfers.push(transfer);renderTransfers()
   void monitorTask(task.id,transfer,()=>{outstanding--;refresh()})
  }
  const off=window.runtime.EventsOn('upload:task',event=>{if(event.requestId===requestId)addTask(event.task)})
  try{
   const result=await desktop().SubmitUploadStreaming(sid,remoteDir,localPath,requestId)
   for(const task of result.tasks)addTask(task)
   if(result.skipped.length)toast(`已跳过 ${result.skipped.length} 个符号链接或特殊文件`)
   if(result.submissionError){pending.status='部分提交失败';pending.error=result.submissionError;toast(result.submissionError)}
   else if(!seen.size){pending.status='完成（空目录）';pending.progress=100}
   else transfers=transfers.filter(t=>t!==pending)
  }catch(err){pending.status='失败';pending.error=String(err);toast(pending.error)}
  finally{off();submitting=false;renderTransfers();refresh()}
 }
}
// Limit concurrent bridge calls when a directory contains thousands of files.
let activeStatusCalls=0
const statusWaiters:Array<()=>void>=[]
async function readTransferStatus(id:string){
 if(activeStatusCalls>=32)await new Promise<void>(resolve=>statusWaiters.push(resolve))
 else activeStatusCalls++
 try{return await desktop().TransferStatus(id)}finally{const next=statusWaiters.shift();if(next)next();else activeStatusCalls--}
}
async function monitorTask(id:string,transfer:Transfer,onDone?:()=>void){
 let previousBytes=0, previousTime=performance.now()
 try{
  while(true){
   const result=await readTransferStatus(id)
   const now=performance.now()
   if(transfer.direction==='upload'){
    const elapsed=(now-previousTime)/1000
    if(elapsed>0){transfer.speed=Math.max(0,(result.transferredBytes-previousBytes)/elapsed);transfer.speedAt=Date.now()}
    previousBytes=result.transferredBytes;previousTime=now
    if(result.totalBytes>0)transfer.progress=Math.min(99,Math.floor(result.transferredBytes/result.totalBytes*100))
   }
   if(result.status==='created')transfer.status='等待中'
   else if(result.status==='in_progress')transfer.status='传输中'
   else if(result.status==='success'){transfer.status='完成';transfer.progress=100;transfer.speed=0;renderTransfers();onDone?.();return}
   else if(result.status==='failed'){transfer.status='失败';transfer.speed=0;transfer.error=result.error;renderTransfers();onDone?.();return}
   else throw new Error('未知任务状态: '+result.status)
   renderTransfers();await new Promise(resolve=>setTimeout(resolve,500))
  }
 }catch(err){transfer.status='状态未知';transfer.error=String(err);renderTransfers();onDone?.()}
}

function formatSpeed(bytes:number){if(bytes>=1_000_000)return `${(bytes/1_000_000).toFixed(1)} MB/s`;if(bytes>=1_000)return `${(bytes/1_000).toFixed(1)} KB/s`;return `${Math.round(bytes)} B/s`}
let renderTimer:ReturnType<typeof setTimeout>|undefined
function renderTransfers(){if(renderTimer)return;renderTimer=setTimeout(()=>{renderTimer=undefined;const done=transfers.filter(t=>t.status==='完成').length;const totalSpeed=transfers.reduce((sum,t)=>sum+(t.direction==='upload'&&t.status==='传输中'&&Date.now()-(t.speedAt||0)<2000?(t.speed||0):0),0);$('#transfer-summary').textContent=transfers.length?`${done} / ${transfers.length} 已完成  |  上传 ${formatSpeed(totalSpeed)}`:'暂无传输任务';$('#transfers').innerHTML=transfers.map(t=>`<div class="transfer-row"><span>${icon('file',15)} ${esc(t.name)}</span><div class="progress"><div style="width:${t.progress}%"></div></div><span title="${esc(t.error||'')}">${esc(t.status)}${t.direction==='upload'&&t.status==='传输中'?` ${formatSpeed(t.speed||0)}`:''}${t.error?`：${esc(t.error)}`:''}</span></div>`).join('');iconsRefresh()},150)}

$('#toggle-transfers').onclick=()=>$('#transfers').classList.toggle('hidden')

renderConnections(); renderFiles(); setConnected(false); iconsRefresh()
void desktop().Backend().then(info=>{backend=info; window.runtime.OnFileDrop((x,y,paths)=>{const r=$('#dropzone').getBoundingClientRect(); if(x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom)void uploadPaths(paths)},false)}).catch(err=>toast(String(err)))
