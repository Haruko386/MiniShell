export type FileEntry = {name: string; type: 'file' | 'directory'; size: number; modifiedAt: string}
export type TreeEntry = FileEntry & {depth: number}

export function flattenFiles(entries: FileEntry[], expanded: Map<string, FileEntry[]>, parent = '', depth = 0): TreeEntry[] {
    return entries.flatMap(entry => {
        const name = parent ? `${parent}/${entry.name}` : entry.name
        const row = {...entry, name, depth}
        return entry.type === 'directory' && expanded.has(name)
            ? [row, ...flattenFiles(expanded.get(name)!, expanded, name, depth + 1)]
            : [row]
    })
}

export function creationParent(entry?: FileEntry): string {
    if (!entry) return ''
    return entry.type === 'directory' ? entry.name : entry.name.slice(0, Math.max(0, entry.name.lastIndexOf('/')))
}

// New folders precede siblings; new files follow the directory subtrees.
export function creationIndex(rows: TreeEntry[], parent: string, type: FileEntry['type']): number {
    const parentIndex = parent ? rows.findIndex(row => row.name === parent) : -1
    const depth = parent ? rows[parentIndex].depth + 1 : 0
    let index = parentIndex + 1
    if (type === 'file') {
        while (index < rows.length && (rows[index].depth > depth ||
            (rows[index].depth === depth && rows[index].type === 'directory'))) index++
    }
    return index
}
