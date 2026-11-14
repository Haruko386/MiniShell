export type ResourceMetrics = {
    sampledAt: string;
    cpuPercent: number | null;
    memory: {usedBytes: number; totalBytes: number; usedPercent: number};
    network: {rxBytesPerSecond: number | null; txBytesPerSecond: number | null}
}

export function resourceBytes(bytes: number | null): string {
    if (bytes === null) return '—'
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
    let unit = 0
    while (bytes >= 1024 && unit < units.length - 1) { bytes /= 1024; unit++ }
    return `${bytes.toFixed(unit ? 1 : 0)} ${units[unit]}`
}

export function resourcePercent(value: number | null): string {
    return value === null ? '—' : `${value.toFixed(1)}%`
}

export function pollResources(
    read: (signal: AbortSignal) => Promise<ResourceMetrics>,
    update: (metrics: ResourceMetrics) => void,
    failed: (error: unknown) => void
): () => void {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController
    const poll = async () => {
        controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 5000)
        let delay = 2000
        try {
            const metrics = await read(controller.signal)
            if (!stopped) update(metrics)
        } catch (err) {
            delay = 10000
            if (!stopped) failed(err)
        } finally {
            clearTimeout(timeout)
            if (!stopped) timer = setTimeout(poll, delay)
        }
    }
    void poll()
    return () => {
        stopped = true
        clearTimeout(timer)
        controller.abort()
    }
}
