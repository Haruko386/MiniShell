import test from 'node:test'
import assert from 'node:assert/strict'

import {createRemoteEntry} from '../../desktop/frontend/src/create-entry.ts'

for (const [type, endpoint] of [['file', 'files/create'], ['directory', 'directories']] as const) {
    test(`create ${type}: sends parent path and name as JSON`, async () => {
        const calls: {url: string; init?: RequestInit}[] = []
        await createRemoteEntry(async (url, init) => {
            calls.push({url, init})
            return new Response(null, {status: 201})
        }, type, 'session/id', '/home/user', '中文 name.txt')
        assert.equal(calls.length, 1)
        assert.equal(calls[0].url, `/api/sessions/session%2Fid/${endpoint}`)
        assert.equal(calls[0].init?.method, 'POST')
        assert.deepEqual(calls[0].init?.headers, {'Content-Type': 'application/json'})
        assert.deepEqual(JSON.parse(calls[0].init?.body as string), {
            path: '/home/user', name: '中文 name.txt'
        })
    })
}

test('invalid names never send a create request', async () => {
    for (const name of ['', '.', '..', '../file', 'sub/file', 'sub\\file', 'a\0b']) {
        let called = false
        await assert.rejects(createRemoteEntry(async () => {
            called = true
            return new Response(null, {status: 201})
        }, 'file', 'session', '/', name), /请输入单个名称/)
        assert.equal(called, false, name)
    }
})

test('dotfiles and spaces in names are preserved', async () => {
    for (const name of ['.env', ' file ', '中文文件夹']) {
        await createRemoteEntry(async (_url, init) => {
            assert.deepEqual(JSON.parse(init?.body as string), {path: '/', name})
            return new Response(null, {status: 201})
        }, 'file', 'session', '/', name)
    }
})

test('API errors propagate without retrying or reporting success', async () => {
    for (const error of [new Error('同名文件已存在'), new TypeError('Failed to fetch')]) {
        let calls = 0
        await assert.rejects(createRemoteEntry(async () => {
            calls++
            throw error
        }, 'file', 'session', '/', 'file'), actual => actual === error)
        assert.equal(calls, 1)
    }
})
