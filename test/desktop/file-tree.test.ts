import test from 'node:test'
import assert from 'node:assert/strict'
import {flattenFiles, creationParent, creationIndex} from '../../desktop/frontend/src/file-tree.ts'
import type {FileEntry} from '../../desktop/frontend/src/file-tree.ts'
import {createRemoteEntry} from '../../desktop/frontend/src/create-entry.ts'
import {joinPath} from '../../desktop/frontend/src/path.ts'

const file = (name: string): FileEntry => ({name, type: 'file', size: 0, modifiedAt: ''})
const dir = (name: string): FileEntry => ({...file(name), type: 'directory'})
const roots = [dir('DA2'), dir('config'), file('readme.md')]
const expanded = new Map([
    ['DA2', [dir('models'), file('app.py')]],
    ['DA2/models', [file('app.py')]],
    ['config', []]
])

test('expanded folders retain full relative paths and indentation', () => {
    const rows = flattenFiles(roots, expanded)
    assert.deepEqual(rows.map(({name, depth}) => [name, depth]), [
        ['DA2', 0], ['DA2/models', 1], ['DA2/models/app.py', 2],
        ['DA2/app.py', 1], ['config', 0], ['readme.md', 0]
    ])
    assert.equal(roots[0].name, 'DA2')
    const collapsed = new Map(expanded)
    collapsed.delete('DA2')
    assert.deepEqual(flattenFiles(roots, collapsed).map(row => row.name), ['DA2', 'config', 'readme.md'])
})

test('right-click creates inside the folder or alongside the selected file', () => {
    assert.equal(creationParent(dir('DA2/models')), 'DA2/models')
    assert.equal(creationParent(file('DA2/app.py')), 'DA2')
    assert.equal(creationParent(file('readme.md')), '')
    assert.equal(creationParent(), '')
})

test('new folder goes first, new file follows directory subtrees', () => {
    const rows = flattenFiles(roots, expanded)
    assert.equal(creationIndex(rows, '', 'directory'), 0)
    assert.equal(creationIndex(rows, '', 'file'), 5)
    assert.equal(creationIndex(rows, 'DA2', 'directory'), 1)
    assert.equal(creationIndex(rows, 'DA2', 'file'), 3)
    assert.equal(creationIndex(rows, 'DA2/models', 'file'), 2)
})

test('creation in an empty folder stays before the next sibling', () => {
    const rows = flattenFiles(roots, expanded)
    assert.equal(creationIndex(rows, 'config', 'file'), 5)
    assert.equal(creationIndex(rows, 'config', 'directory'), 5)
    assert.equal(creationIndex([], '', 'file'), 0)
})

test('right-click creation sends the target folder, not the explorer root', async () => {
    const parent = creationParent(dir('DA2/models'))
    await createRemoteEntry(async (url, init) => {
        assert.equal(url, '/api/sessions/session/files/create')
        assert.deepEqual(JSON.parse(init?.body as string), {path: '/home/user/DA2/models', name: 'new.py'})
        return new Response(null, {status: 201})
    }, 'file', 'session', joinPath('/home/user', parent), 'new.py')
})
