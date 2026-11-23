export type DiskPartition = {
    filesystem: string;
    mountPoint: string;
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    usedPercent: number
}

export type DiskSnapshot = {
    sampledAt: string;
    disks: DiskPartition[]
}

export function diskUsageClass(percent: number): string {
    if (percent >= 90) return 'danger'
    if (percent >= 75) return 'warning'
    return ''
}
