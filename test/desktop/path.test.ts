import test from 'node:test'
import assert from 'node:assert/strict'

import * as desktopPath from '../../desktop/frontend/src/path.ts'
import * as webPath from '../../web/src/path.ts'

const modules = [
    ['desktop', desktopPath],
    ['web', webPath]
] as const

for (const [name, path] of modules) {
    test(`${name}: parentPath`, () => {
        assert.equal(path.parentPath('/'), '/')
        assert.equal(path.parentPath('/home'), '/')
        assert.equal(path.parentPath('/home/user/'), '/home')
        assert.equal(path.parentPath('/home/user/file.txt'), '/home/user')
    })

    test(`${name}: joinPath`, () => {
        assert.equal(path.joinPath('/', 'file.txt'), '/file.txt')
        assert.equal(path.joinPath('/home', 'user'), '/home/user')
        assert.equal(path.joinPath('/home/', 'user'), '/home/user')
    })

    test(`${name}: parts`, () => {
        assert.deepEqual(path.parts('/'), [{label: '/', path: '/'}])
        assert.deepEqual(path.parts('/home/user'), [
            {label: '/', path: '/'},
            {label: 'home', path: '/home'},
            {label: 'user', path: '/home/user'}
        ])
        assert.deepEqual(path.parts('/home/user/'), path.parts('/home/user'))
    })
}
