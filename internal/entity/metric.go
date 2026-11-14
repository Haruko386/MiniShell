package entity

import (
	"errors"
	"time"
)

const MetricsCommand = "echo __MINISHELL_OS__; uname -s; " +
	"echo __MINISHELL_CPU__; cat /proc/stat; " +
	"echo __MINISHELL_MEM__; cat /proc/meminfo; " +
	"echo __MINISHELL_ROUTE__; cat /proc/net/route; " +
	"echo __MINISHELL_NET__; cat /proc/net/dev"

type MetricSnapshot struct {
	SampledAt  string          `json:"sampledAt"`
	CPUPercent *float64        `json:"cpuPercent"`
	Memory     MemorySnapshot  `json:"memory"`
	Network    NetworkSnapshot `json:"network"`
}

type MemorySnapshot struct {
	UsedBytes   uint64  `json:"usedBytes"`
	TotalBytes  uint64  `json:"totalBytes"`
	UsedPercent float64 `json:"usedPercent"`
}

type NetworkSnapshot struct {
	RxBytesPerSecond *float64 `json:"rxBytesPerSecond"`
	TxBytesPerSecond *float64 `json:"txBytesPerSecond"`
}

type MetricsCache struct {
	CPUAt    time.Time
	CPUTotal uint64
	CPUIdle  uint64
	HasCPU   bool

	NetAt    time.Time
	NetIface string
	RxBytes  uint64
	TxBytes  uint64
	HasNet   bool
}

var (
	ErrMetricsUnsupported = errors.New("metrics are not supported on this platform")
	ErrMetricsUnavailable = errors.New("failed to collect remote metrics")
)
