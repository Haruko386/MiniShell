import test from 'node:test'
import assert from 'node:assert/strict'
import {pollResources, resourceBytes, resourcePercent} from '../../desktop/frontend/src/resource-monitor.ts'
import type {ResourceMetrics} from '../../desktop/frontend/src/resource-monitor.ts'

const metrics: ResourceMetrics = {
    sampledAt: '2026-11-14T08:00:00Z', cpuPercent: 12.5,
    memory: {usedBytes: 1024, totalBytes: 4096, usedPercent: 25},
    network: {rxBytesPerSecond: 2048, txBytesPerSecond: 0}
}

test('resource formatting distinguishes unavailable data from zero', () => {
    assert.equal(resourcePercent(null), '—')
    assert.equal(resourcePercent(0), '0.0%')
    assert.equal(resourcePercent(12.56), '12.6%')
    assert.equal(resourceBytes(null), '—')
    assert.equal(resourceBytes(0), '0 B')
    assert.equal(resourceBytes(2048), '2.0 KiB')
    assert.equal(resourceBytes(3 * 1024 ** 3), '3.0 GiB')
})

test('stopping polling aborts the request and discards a late session response', async () => {
    let resolve!: (value: ResourceMetrics) => void
    let signal!: AbortSignal
    let updates = 0
    const stop = pollResources(s => {
        signal = s
        return new Promise(r => { resolve = r })
    }, () => updates++, () => updates++)
    stop()
    assert.equal(signal.aborted, true)
    resolve(metrics)
    await Promise.resolve()
    assert.equal(updates, 0)
})

test('polling waits for completion before scheduling the next sample', async t => {
    t.mock.timers.enable({apis: ['setTimeout']})
    let calls = 0
    let resolve!: (value: ResourceMetrics) => void
    const updates: ResourceMetrics[] = []
    const stop = pollResources(() => {
        calls++
        return new Promise(r => { resolve = r })
    }, value => updates.push(value), assert.fail)
    t.after(stop)
    t.mock.timers.tick(3000)
    assert.equal(calls, 1)
    resolve(metrics)
    await Promise.resolve()
    assert.equal(updates[0], metrics)
    t.mock.timers.tick(1999)
    assert.equal(calls, 1)
    t.mock.timers.tick(1)
    assert.equal(calls, 2)
    stop()
    t.mock.timers.tick(10000)
    assert.equal(calls, 2)
})

test('failed samples report unavailable and retry after ten seconds', async t => {
    t.mock.timers.enable({apis: ['setTimeout']})
    let calls = 0, errors = 0
    const stop = pollResources(async () => { calls++; throw new Error('not implemented') }, assert.fail, () => errors++)
    t.after(stop)
    await Promise.resolve()
    assert.equal(errors, 1)
    t.mock.timers.tick(9999)
    assert.equal(calls, 1)
    t.mock.timers.tick(1)
    assert.equal(calls, 2)
    await Promise.resolve()
})

test('a stalled sample is aborted after five seconds', t => {
    t.mock.timers.enable({apis: ['setTimeout']})
    let signal!: AbortSignal
    const stop = pollResources(s => { signal = s; return new Promise(() => {}) }, assert.fail, assert.fail)
    t.after(stop)
    t.mock.timers.tick(4999)
    assert.equal(signal.aborted, false)
    t.mock.timers.tick(1)
    assert.equal(signal.aborted, true)
})
