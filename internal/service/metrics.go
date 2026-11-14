package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/Haruko386/MiniShell/internal/entity"
	"golang.org/x/crypto/ssh"
)

type rawMetrics struct {
	cpuTotal uint64
	cpuIdle  uint64

	memTotal     uint64
	memAvailable uint64

	netIface string
	rxBytes  uint64
	txBytes  uint64
	hasNet   bool
}

type metricsReadResult struct {
	output string
	err    error
}

// Metrics samples the remote Linux host through a dedicated exec channel.
func (s *SessionSvr) Metrics(ctx context.Context, id string) (entity.MetricSnapshot, error) {
	s.Mu.Lock()
	sess, ok := s.sessions[id]
	s.Mu.Unlock()
	if !ok {
		return entity.MetricSnapshot{}, ErrSessionNotFound
	}

	select {
	case sess.metricSlot <- struct{}{}:
		defer func() { <-sess.metricSlot }()
	case <-ctx.Done():
		return entity.MetricSnapshot{}, ctx.Err()
	case <-sess.closed:
		return entity.MetricSnapshot{}, ErrSessionNotFound
	}

	if err := ctx.Err(); err != nil {
		return entity.MetricSnapshot{}, err
	}
	select {
	case <-sess.closed:
		return entity.MetricSnapshot{}, ErrSessionNotFound
	default:
	}

	output, runErr := readMetrics(ctx, sess.client)
	if err := ctx.Err(); err != nil {
		return entity.MetricSnapshot{}, err
	}
	select {
	case <-sess.closed:
		return entity.MetricSnapshot{}, ErrSessionNotFound
	default:
	}

	raw, parseErr := parseMetrics(output)
	if errors.Is(parseErr, entity.ErrMetricsUnsupported) {
		return entity.MetricSnapshot{}, parseErr
	}
	if runErr != nil {
		return entity.MetricSnapshot{}, fmt.Errorf("collect remote metrics: %w", runErr)
	}
	if parseErr != nil {
		return entity.MetricSnapshot{}, parseErr
	}

	return buildMetricsSnapshot(raw, time.Now(), &sess.metrics), nil
}

func readMetrics(ctx context.Context, client *ssh.Client) (string, error) {
	done := make(chan metricsReadResult, 1)

	go func() {
		if err := ctx.Err(); err != nil {
			done <- metricsReadResult{err: err}
			return
		}

		channel, err := client.NewSession()
		if err != nil {
			done <- metricsReadResult{err: err}
			return
		}
		defer channel.Close()

		var output bytes.Buffer
		channel.Stdout = &output
		channel.Stderr = io.Discard

		stop := context.AfterFunc(ctx, func() { _ = channel.Close() })
		defer stop()

		if err := ctx.Err(); err != nil {
			done <- metricsReadResult{err: err}
			return
		}
		runErr := channel.Run(entity.MetricsCommand)
		if err := ctx.Err(); err != nil {
			done <- metricsReadResult{err: err}
			return
		}
		done <- metricsReadResult{output: output.String(), err: runErr}
	}()

	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case result := <-done:
		return result.output, result.err
	}
}

func parseMetrics(output string) (rawMetrics, error) {
	sections, err := splitMetricSections(output)
	if err != nil {
		return rawMetrics{}, err
	}

	osName := strings.TrimSpace(sections["os"])
	if newline := strings.IndexByte(osName, '\n'); newline >= 0 {
		osName = strings.TrimSpace(osName[:newline])
	}
	if !strings.EqualFold(osName, "linux") {
		return rawMetrics{}, entity.ErrMetricsUnsupported
	}

	cpuTotal, cpuIdle, err := parseCPUStat(sections["cpu"])
	if err != nil {
		return rawMetrics{}, err
	}
	memTotal, memAvailable, err := parseMemInfo(sections["mem"])
	if err != nil {
		return rawMetrics{}, err
	}

	raw := rawMetrics{
		cpuTotal:     cpuTotal,
		cpuIdle:      cpuIdle,
		memTotal:     memTotal,
		memAvailable: memAvailable,
	}

	iface := parseDefaultRoute(sections["route"])
	if iface != "" {
		if rx, tx, ok := parseNetDev(sections["net"], iface); ok {
			raw.netIface = iface
			raw.rxBytes = rx
			raw.txBytes = tx
			raw.hasNet = true
		}
	}
	return raw, nil
}

func splitMetricSections(output string) (map[string]string, error) {
	markers := []struct {
		name   string
		marker string
	}{
		{"os", "__MINISHELL_OS__"},
		{"cpu", "__MINISHELL_CPU__"},
		{"mem", "__MINISHELL_MEM__"},
		{"route", "__MINISHELL_ROUTE__"},
		{"net", "__MINISHELL_NET__"},
	}

	sections := make(map[string]string, len(markers))
	for index, marker := range markers {
		start := strings.Index(output, marker.marker)
		if start < 0 {
			return nil, fmt.Errorf("%w: missing %s", entity.ErrMetricsUnavailable, marker.marker)
		}
		start += len(marker.marker)

		end := len(output)
		if index+1 < len(markers) {
			next := strings.Index(output[start:], markers[index+1].marker)
			if next < 0 {
				return nil, fmt.Errorf("%w: missing %s", entity.ErrMetricsUnavailable, markers[index+1].marker)
			}
			end = start + next
		}
		sections[marker.name] = strings.TrimSpace(output[start:end])
	}
	return sections, nil
}

func parseCPUStat(section string) (uint64, uint64, error) {
	for _, line := range strings.Split(section, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || fields[0] != "cpu" {
			continue
		}
		if len(fields) < 9 {
			return 0, 0, fmt.Errorf("%w: invalid aggregate cpu line", entity.ErrMetricsUnavailable)
		}

		values := make([]uint64, 8)
		for index := range values {
			value, err := strconv.ParseUint(fields[index+1], 10, 64)
			if err != nil {
				return 0, 0, fmt.Errorf("%w: parse cpu fields: %v", entity.ErrMetricsUnavailable, err)
			}
			values[index] = value
		}

		total := values[0] + values[1] + values[2] + values[3] +
			values[4] + values[5] + values[6] + values[7]
		idle := values[3] + values[4]
		return total, idle, nil
	}
	return 0, 0, fmt.Errorf("%w: aggregate cpu line not found", entity.ErrMetricsUnavailable)
}

func parseMemInfo(section string) (uint64, uint64, error) {
	var total, available uint64
	var haveTotal, haveAvailable bool

	for _, line := range strings.Split(section, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}

		key := strings.TrimSuffix(fields[0], ":")
		if key != "MemTotal" && key != "MemAvailable" {
			continue
		}
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			return 0, 0, fmt.Errorf("%w: parse %s: %v", entity.ErrMetricsUnavailable, key, err)
		}

		switch key {
		case "MemTotal":
			total = value
			haveTotal = true
		case "MemAvailable":
			available = value
			haveAvailable = true
		}
	}

	if !haveTotal || !haveAvailable || total == 0 {
		return 0, 0, fmt.Errorf("%w: missing MemTotal or MemAvailable", entity.ErrMetricsUnavailable)
	}
	return total * 1024, available * 1024, nil
}

func parseDefaultRoute(section string) string {
	iface := ""
	bestMetric := int(^uint(0) >> 1)

	for _, line := range strings.Split(section, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 11 {
			continue
		}
		if fields[1] != "00000000" || fields[7] != "00000000" {
			continue
		}

		flags, err := strconv.ParseUint(fields[3], 16, 32)
		if err != nil || flags&0x1 == 0 {
			continue
		}
		metric, err := strconv.Atoi(fields[6])
		if err != nil {
			continue
		}
		if iface == "" || metric < bestMetric {
			iface = fields[0]
			bestMetric = metric
		}
	}
	return iface
}

func parseNetDev(section, iface string) (uint64, uint64, bool) {
	if iface == "" {
		return 0, 0, false
	}

	for _, line := range strings.Split(section, "\n") {
		name, counters, ok := strings.Cut(line, ":")
		if !ok || strings.TrimSpace(name) != iface {
			continue
		}

		fields := strings.Fields(counters)
		if len(fields) < 9 {
			return 0, 0, false
		}
		rx, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			return 0, 0, false
		}
		tx, err := strconv.ParseUint(fields[8], 10, 64)
		if err != nil {
			return 0, 0, false
		}
		return rx, tx, true
	}
	return 0, 0, false
}

func buildMetricsSnapshot(raw rawMetrics, now time.Time, cache *entity.MetricsCache) entity.MetricSnapshot {
	used := uint64(0)
	usedPercent := float64(0)
	if raw.memTotal > 0 {
		if raw.memAvailable < raw.memTotal {
			used = raw.memTotal - raw.memAvailable
		}
		usedPercent = round1(100 * float64(used) / float64(raw.memTotal))
	}

	snapshot := entity.MetricSnapshot{
		SampledAt: now.UTC().Format(time.RFC3339),
		Memory: entity.MemorySnapshot{
			UsedBytes:   used,
			TotalBytes:  raw.memTotal,
			UsedPercent: usedPercent,
		},
	}

	if cache.HasCPU && now.After(cache.CPUAt) &&
		raw.cpuTotal >= cache.CPUTotal && raw.cpuIdle >= cache.CPUIdle {
		deltaTotal := raw.cpuTotal - cache.CPUTotal
		deltaIdle := raw.cpuIdle - cache.CPUIdle
		if deltaTotal > 0 && deltaIdle <= deltaTotal {
			percent := round1(100 * float64(deltaTotal-deltaIdle) / float64(deltaTotal))
			snapshot.CPUPercent = &percent
		}
	}

	cache.CPUAt = now
	cache.CPUTotal = raw.cpuTotal
	cache.CPUIdle = raw.cpuIdle
	cache.HasCPU = true

	if raw.hasNet && raw.netIface != "" {
		if cache.HasNet && cache.NetIface == raw.netIface && now.After(cache.NetAt) &&
			raw.rxBytes >= cache.RxBytes && raw.txBytes >= cache.TxBytes {
			seconds := now.Sub(cache.NetAt).Seconds()
			if seconds > 0 {
				rx := float64(raw.rxBytes-cache.RxBytes) / seconds
				tx := float64(raw.txBytes-cache.TxBytes) / seconds
				snapshot.Network.RxBytesPerSecond = &rx
				snapshot.Network.TxBytesPerSecond = &tx
			}
		}

		cache.NetAt = now
		cache.NetIface = raw.netIface
		cache.RxBytes = raw.rxBytes
		cache.TxBytes = raw.txBytes
		cache.HasNet = true
	} else {
		cache.HasNet = false
		cache.NetIface = ""
	}

	return snapshot
}

func round1(value float64) float64 {
	return math.Round(value*10) / 10
}
