export type EntryType = 'file' | 'directory'

type Api = (url: string, init?: RequestInit) => Promise<Response>

export async function createRemoteEntry(api: Api, type: EntryType, session: string, path: string, name: string) {
    if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) {
        throw new Error('请输入单个名称，不能包含 /、\\ 或特殊路径字符')
    }
    const endpoint = type === 'file' ? 'files/create' : 'directories'
    await api(`/api/sessions/${encodeURIComponent(session)}/${endpoint}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path, name})
    })
}
