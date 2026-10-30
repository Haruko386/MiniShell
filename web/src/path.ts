export function parentPath(path: string) {
    return path.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/'
}

export function joinPath(dir: string, name: string) {
    return `${dir.replace(/\/$/, '')}/${name}`
}

export function parts(path: string) {
    const names = path.split('/').filter(Boolean)
    return [{label: '/', path: '/'}, ...names.map((label, index) => ({
        label,
        path: '/' + names.slice(0, index + 1).join('/')
    }))]
}
