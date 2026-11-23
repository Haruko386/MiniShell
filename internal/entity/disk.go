package entity

import "errors"

const DiskCommand = "echo __MINISHELL_OS__; uname -s; " +
	"echo __MINISHELL_DF__; env LC_ALL=C df -P -k"

type DiskSnapshot struct {
	SampledAt string          `json:"sampledAt"`
	Disks     []DiskPartition `json:"disks"`
}

type DiskPartition struct {
	Filesystem     string  `json:"filesystem"`
	MountPoint     string  `json:"mountPoint"`
	TotalBytes     uint64  `json:"totalBytes"`
	UsedBytes      uint64  `json:"usedBytes"`
	AvailableBytes uint64  `json:"availableBytes"`
	UsedPercent    float64 `json:"usedPercent"`
}

var (
	ErrDisksUnsupported = errors.New("disk metrics are not supported on this platform")
	ErrDisksUnavailable = errors.New("failed to collect remote disk metrics")
)
