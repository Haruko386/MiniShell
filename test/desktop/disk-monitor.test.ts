import test from 'node:test'
import assert from 'node:assert/strict'
import {diskUsageClass} from '../../desktop/frontend/src/disk-monitor.ts'

test('disk usage class uses warning and danger thresholds', () => {
    assert.equal(diskUsageClass(0), '')
    assert.equal(diskUsageClass(74.9), '')
    assert.equal(diskUsageClass(75), 'warning')
    assert.equal(diskUsageClass(89.9), 'warning')
    assert.equal(diskUsageClass(90), 'danger')
    assert.equal(diskUsageClass(100), 'danger')
})
