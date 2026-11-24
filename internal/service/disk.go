package service

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Haruko386/MiniShell/internal/entity"
)

const (
	diskOSMarker = "__MINISHELL_OS__"
	diskDFMarker = "__MINISHELL_DF__"
)

// Disks samples mounted filesystems from the remote Linux host.
func (s *SessionSvr) Disks(ctx context.Context, id string) (entity.DiskSnapshot, error) {
	s.Mu.Lock()
	sess, ok := s.sessions[id]
	s.Mu.Unlock()
	if !ok {
		return entity.DiskSnapshot{}, ErrSessionNotFound
	}

	select {
	case <-sess.closed:
		return entity.DiskSnapshot{}, ErrSessionNotFound
	default:
	}

	output, runErr := readRemoteCommand(ctx, sess.client, entity.DiskCommand)
	if err := ctx.Err(); err != nil {
		return entity.DiskSnapshot{}, err
	}
	select {
	case <-sess.closed:
		return entity.DiskSnapshot{}, ErrSessionNotFound
	default:
	}

	disks, parseErr := parseDisks(output)
	if errors.Is(parseErr, entity.ErrDisksUnsupported) {
		return entity.DiskSnapshot{}, parseErr
	}
	if parseErr != nil {
		if runErr != nil {
			return entity.DiskSnapshot{}, fmt.Errorf("collect remote disks: %w", runErr)
		}
		return entity.DiskSnapshot{}, parseErr
	}
	if len(disks) == 0 && runErr != nil {
		return entity.DiskSnapshot{}, fmt.Errorf("collect remote disks: %w", runErr)
	}

	return entity.DiskSnapshot{
		SampledAt: time.Now().UTC().Format(time.RFC3339),
		Disks:     disks,
	}, nil
}

func parseDisks(output string) ([]entity.DiskPartition, error) {
	osName, dfOutput, err := splitDiskSections(output)
	if err != nil {
		return nil, err
	}
	if newline := strings.IndexByte(osName, '\n'); newline >= 0 {
		osName = strings.TrimSpace(osName[:newline])
	}
	if !strings.EqualFold(osName, "linux") {
		return nil, entity.ErrDisksUnsupported
	}

	disks := make([]entity.DiskPartition, 0)
	sawDataLine := false
	for _, line := range strings.Split(dfOutput, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 6 || strings.EqualFold(fields[0], "Filesystem") {
			continue
		}
		sawDataLine = true

		blocks, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		used, err := strconv.ParseUint(fields[2], 10, 64)
		if err != nil {
			continue
		}
		available, err := strconv.ParseUint(fields[3], 10, 64)
		if err != nil {
			continue
		}

		mountPoint := strings.Join(fields[5:], " ")
		if mountPoint == "" {
			continue
		}

		totalBytes := blocks * 1024
		usedBytes := used * 1024
		availableBytes := available * 1024
		usedPercent := float64(0)
		if totalBytes > 0 {
			usedPercent = round1(100 * float64(usedBytes) / float64(totalBytes))
		}

		disks = append(disks, entity.DiskPartition{
			Filesystem:     fields[0],
			MountPoint:     mountPoint,
			TotalBytes:     totalBytes,
			UsedBytes:      usedBytes,
			AvailableBytes: availableBytes,
			UsedPercent:    usedPercent,
		})
	}

	if sawDataLine && len(disks) == 0 {
		return nil, entity.ErrDisksUnavailable
	}

	sort.SliceStable(disks, func(i, j int) bool {
		if disks[i].MountPoint == "/" {
			return disks[j].MountPoint != "/"
		}
		if disks[j].MountPoint == "/" {
			return false
		}
		return disks[i].MountPoint < disks[j].MountPoint
	})
	return disks, nil
}

func splitDiskSections(output string) (string, string, error) {
	osStart := strings.Index(output, diskOSMarker)
	dfStart := strings.Index(output, diskDFMarker)
	if osStart < 0 || dfStart < 0 || dfStart < osStart {
		return "", "", entity.ErrDisksUnavailable
	}

	osStart += len(diskOSMarker)
	dfStart += len(diskDFMarker)
	osName := strings.TrimSpace(output[osStart : dfStart-len(diskDFMarker)])
	dfOutput := strings.TrimSpace(output[dfStart:])
	return osName, dfOutput, nil
}
