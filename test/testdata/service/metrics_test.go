package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Haruko386/MiniShell/internal/entity"
)

func metricsOutput(osName, cpu, mem, route, net string) string {
	return "__MINISHELL_OS__\n" + osName + "\n" +
		"__MINISHELL_CPU__\n" + cpu + "\n" +
		"__MINISHELL_MEM__\n" + mem + "\n" +
		"__MINISHELL_ROUTE__\n" + route + "\n" +
		"__MINISHELL_NET__\n" + net
}

func metricsFixture() string {
	return metricsOutput(
		"Linux",
		"cpu  100 20 30 400 10 5 3 2 0 0\ncpu0 50 10 15 200 5 2 1 1 0 0",
		"MemTotal:       2048 kB\nMemFree:         512 kB\nMemAvailable:   1024 kB",
		"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n"+
			"eth0\t00000000\t0100000A\t0003\t0\t0\t100\t00000000\t0\t0\t0",
		"Inter-|   Receive                                                |  Transmit\n"+
			" face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n"+
			"    lo: 100 0 0 0 0 0 0 0 100 0 0 0 0 0 0 0\n"+
			"  eth0: 1000 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0",
	)
}

func TestParseMetrics(t *testing.T) {
	raw, err := parseMetrics(metricsFixture())
	if err != nil {
		t.Fatal(err)
	}

	if raw.cpuTotal != 570 || raw.cpuIdle != 410 {
		t.Fatalf("unexpected cpu counters: total=%d idle=%d", raw.cpuTotal, raw.cpuIdle)
	}
	if raw.memTotal != 2*1024*1024 || raw.memAvailable != 1024*1024 {
		t.Fatalf("unexpected memory: total=%d available=%d", raw.memTotal, raw.memAvailable)
	}
	if !raw.hasNet || raw.netIface != "eth0" || raw.rxBytes != 1000 || raw.txBytes != 500 {
		t.Fatalf("unexpected network: %+v", raw)
	}
}

func TestBuildMetricsSnapshotFirstSample(t *testing.T) {
	raw, err := parseMetrics(metricsFixture())
	if err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 11, 14, 8, 0, 0, 0, time.UTC)
	cache := entity.MetricsCache{}
	snapshot := buildMetricsSnapshot(raw, now, &cache)

	if snapshot.CPUPercent != nil {
		t.Fatalf("first cpu sample should be nil, got %v", *snapshot.CPUPercent)
	}
	if snapshot.Network.RxBytesPerSecond != nil || snapshot.Network.TxBytesPerSecond != nil {
		t.Fatalf("first network sample should be nil, got %+v", snapshot.Network)
	}
	if snapshot.Memory.UsedBytes != 1024*1024 || snapshot.Memory.TotalBytes != 2*1024*1024 || snapshot.Memory.UsedPercent != 50 {
		t.Fatalf("unexpected memory snapshot: %+v", snapshot.Memory)
	}
	if snapshot.SampledAt != "2026-11-14T08:00:00Z" {
		t.Fatalf("unexpected sampledAt: %s", snapshot.SampledAt)
	}
	if !cache.HasCPU || !cache.HasNet || cache.NetIface != "eth0" {
		t.Fatalf("baseline was not stored: %+v", cache)
	}
}

func TestBuildMetricsSnapshotDeltas(t *testing.T) {
	raw, err := parseMetrics(metricsFixture())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 14, 8, 0, 0, 0, time.UTC)
	cache := entity.MetricsCache{}
	buildMetricsSnapshot(raw, now, &cache)

	nextCPU := "cpu  200 40 60 800 20 10 6 4 0 0"
	nextNet := "Inter-|   Receive                                                |  Transmit\n" +
		" face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n" +
		"  eth0: 3000 0 0 0 0 0 0 0 1500 0 0 0 0 0 0 0"
	next, err := parseMetrics(metricsOutput(
		"Linux",
		nextCPU,
		"MemTotal:       2048 kB\nMemAvailable:   1024 kB",
		"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n"+
			"eth0\t00000000\t0100000A\t0003\t0\t0\t100\t00000000\t0\t0\t0",
		nextNet,
	))
	if err != nil {
		t.Fatal(err)
	}

	snapshot := buildMetricsSnapshot(next, now.Add(2*time.Second), &cache)
	if snapshot.CPUPercent == nil || *snapshot.CPUPercent != 28.1 {
		t.Fatalf("unexpected cpu: %v", snapshot.CPUPercent)
	}
	if snapshot.Network.RxBytesPerSecond == nil || *snapshot.Network.RxBytesPerSecond != 1000 {
		t.Fatalf("unexpected rx: %v", snapshot.Network.RxBytesPerSecond)
	}
	if snapshot.Network.TxBytesPerSecond == nil || *snapshot.Network.TxBytesPerSecond != 500 {
		t.Fatalf("unexpected tx: %v", snapshot.Network.TxBytesPerSecond)
	}
}

func TestBuildMetricsSnapshotResetsInvalidCounters(t *testing.T) {
	raw, err := parseMetrics(metricsFixture())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 14, 8, 0, 0, 0, time.UTC)
	cache := entity.MetricsCache{
		CPUAt:    now,
		CPUTotal: 1000,
		CPUIdle:  800,
		HasCPU:   true,
		NetAt:    now,
		NetIface: "eth0",
		RxBytes:  1000,
		TxBytes:  1000,
		HasNet:   true,
	}

	snapshot := buildMetricsSnapshot(raw, now.Add(2*time.Second), &cache)
	if snapshot.CPUPercent != nil {
		t.Fatalf("rolled-back cpu should be nil, got %v", *snapshot.CPUPercent)
	}
	if snapshot.Network.RxBytesPerSecond != nil || snapshot.Network.TxBytesPerSecond != nil {
		t.Fatalf("rolled-back network should be nil, got %+v", snapshot.Network)
	}
	if cache.CPUTotal != raw.cpuTotal || cache.RxBytes != raw.rxBytes {
		t.Fatalf("baseline was not rebuilt: %+v", cache)
	}
}

func TestParseMetricsUnsupportedPlatform(t *testing.T) {
	_, err := parseMetrics(metricsOutput("Darwin", "cpu 1 2 3 4 5 6 7 8", "MemTotal: 1 kB\nMemAvailable: 1 kB", "", ""))
	if !errors.Is(err, entity.ErrMetricsUnsupported) {
		t.Fatalf("expected unsupported, got %v", err)
	}
}

func TestParseMetricsRequiresMemAvailable(t *testing.T) {
	_, err := parseMetrics(metricsOutput("Linux", "cpu 1 2 3 4 5 6 7 8", "MemTotal: 2048 kB", "", ""))
	if !errors.Is(err, entity.ErrMetricsUnavailable) {
		t.Fatalf("expected unavailable, got %v", err)
	}
}

func TestParseDefaultRouteUsesLowestMetric(t *testing.T) {
	route := "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n" +
		"eth0\t00000000\t0100000A\t0003\t0\t0\t200\t00000000\t0\t0\t0\n" +
		"eth1\t00000000\t0100000A\t0003\t0\t0\t100\t00000000\t0\t0\t0"
	raw, err := parseMetrics(metricsOutput(
		"Linux",
		"cpu 1 2 3 4 5 6 7 8",
		"MemTotal: 2048 kB\nMemAvailable: 1024 kB",
		route,
		"  eth1: 1000 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0",
	))
	if err != nil {
		t.Fatal(err)
	}
	if raw.netIface != "eth1" || raw.rxBytes != 1000 || raw.txBytes != 500 {
		t.Fatalf("unexpected interface selection: %+v", raw)
	}
}

func TestParseDefaultRouteWithoutGateway(t *testing.T) {
	route := "down0\t00000000\t00000000\t0000\t0\t0\t0\t00000000\t0\t0\t0\n" +
		"wg0\t00000000\t00000000\t0001\t0\t0\t10\t00000000\t0\t0\t0"
	if got := parseDefaultRoute(route); got != "wg0" {
		t.Fatalf("expected UP default route without gateway, got %q", got)
	}
}

func TestMetricsWaitCanBeCanceled(t *testing.T) {
	for _, reason := range []string{"cancel", "deadline", "session closed"} {
		t.Run(reason, func(t *testing.T) {
			sess := &sshSession{closed: make(chan struct{}), metricSlot: make(chan struct{}, 1)}
			sess.metricSlot <- struct{}{}
			defer func() { <-sess.metricSlot }()
			svr := NewSessionSvr()
			svr.sessions["test"] = sess
			ctx, cancel := context.WithCancel(context.Background())
			if reason == "deadline" {
				cancel()
				ctx, cancel = context.WithTimeout(context.Background(), 20*time.Millisecond)
			}
			defer cancel()
			done := make(chan error, 1)
			go func() { _, err := svr.Metrics(ctx, "test"); done <- err }()
			want := context.Canceled
			switch reason {
			case "cancel":
				cancel()
			case "deadline":
				want = context.DeadlineExceeded
			case "session closed":
				close(sess.closed)
				want = ErrSessionNotFound
			}
			select {
			case err := <-done:
				if !errors.Is(err, want) {
					t.Fatalf("got %v, want %v", err, want)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("request remained blocked waiting for sampling slot")
			}
		})
	}
}

func TestParseMetricsWithoutDefaultRoute(t *testing.T) {
	raw, err := parseMetrics(metricsOutput(
		"Linux",
		"cpu 1 2 3 4 5 6 7 8",
		"MemTotal: 2048 kB\nMemAvailable: 1024 kB",
		"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT",
		"  eth0: 1000 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0",
	))
	if err != nil {
		t.Fatal(err)
	}
	if raw.hasNet {
		t.Fatalf("network should be unavailable without a default route: %+v", raw)
	}
}

func TestParseMetricsMissingMarkers(t *testing.T) {
	_, err := parseMetrics("\n__MINISHELL_OS__\nLinux\n__MINISHELL_CPU__\ncpu 1 2 3 4 5 6 7 8")
	if !errors.Is(err, entity.ErrMetricsUnavailable) {
		t.Fatalf("expected unavailable, got %v", err)
	}
}

func TestSplitMetricSectionsTrimsValues(t *testing.T) {
	sections, err := splitMetricSections(metricsFixture())
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(sections["os"]) != "Linux" {
		t.Fatalf("unexpected os section: %q", sections["os"])
	}
}
