package internal_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Haruko386/MiniShell/internal/handler"
	"github.com/Haruko386/MiniShell/internal/service"
	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/ssh"
)

func metricsFixture(cpu, network string) string {
	return "__MINISHELL_OS__\nLinux\n" +
		"__MINISHELL_CPU__\n" + cpu + "\n" +
		"__MINISHELL_MEM__\nMemTotal: 2048 kB\nMemAvailable: 1024 kB\n" +
		"__MINISHELL_ROUTE__\n" +
		"Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n" +
		"eth0\t00000000\t0100000A\t0003\t0\t0\t100\t00000000\t0\t0\t0\n" +
		"__MINISHELL_NET__\n" + network
}

func startMetricsSSHServer(t *testing.T, outputs []string, exitStatus uint32) (ssh.Signer, int) {
	t.Helper()

	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}

	config := &ssh.ServerConfig{NoClientAuth: true}
	config.AddHostKey(signer)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })

	var calls atomic.Int32
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		server, incoming, requests, err := ssh.NewServerConn(conn, config)
		if err != nil {
			_ = conn.Close()
			return
		}
		defer server.Close()
		go ssh.DiscardRequests(requests)

		for incomingChannel := range incoming {
			channel, channelRequests, err := incomingChannel.Accept()
			if err != nil {
				continue
			}

			go func() {
				defer channel.Close()
				for request := range channelRequests {
					if request.Type != "exec" {
						_ = request.Reply(false, nil)
						continue
					}

					_ = request.Reply(true, nil)
					index := int(calls.Add(1)) - 1
					if index >= len(outputs) {
						index = len(outputs) - 1
					}
					_, _ = io.WriteString(channel, outputs[index])
					_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{exitStatus}))
					return
				}
			}()
		}
	}()

	return signer, listener.Addr().(*net.TCPAddr).Port
}

func TestSessionMetrics(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", t.TempDir())

	firstOutput := metricsFixture(
		"cpu  100 20 30 400 10 5 3 2 0 0",
		"  eth0: 1000 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0",
	)
	secondOutput := metricsFixture(
		"cpu  200 40 60 800 20 10 6 4 0 0",
		"  eth0: 3000 0 0 0 0 0 0 0 1500 0 0 0 0 0 0 0",
	)
	signer, port := startMetricsSSHServer(t, []string{firstOutput, secondOutput}, 0)

	sessions := service.NewSessionSvr()
	defer sessions.CloseAll()

	id, err := sessions.Connect("127.0.0.1", "test", "password", port, service.HostKeyPolicy{
		Mode:        service.HostKeyModeOnce,
		Fingerprint: ssh.FingerprintSHA256(signer.PublicKey()),
	})
	if err != nil {
		t.Fatal(err)
	}

	first, err := sessions.Metrics(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if first.CPUPercent != nil {
		t.Fatalf("first cpu sample should be nil, got %v", *first.CPUPercent)
	}
	if first.Network.RxBytesPerSecond != nil || first.Network.TxBytesPerSecond != nil {
		t.Fatalf("first network sample should be nil, got %+v", first.Network)
	}
	if first.Memory.UsedBytes != 1024*1024 || first.Memory.TotalBytes != 2*1024*1024 || first.Memory.UsedPercent != 50 {
		t.Fatalf("unexpected memory: %+v", first.Memory)
	}

	time.Sleep(20 * time.Millisecond)

	second, err := sessions.Metrics(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if second.CPUPercent == nil || *second.CPUPercent <= 0 {
		t.Fatalf("unexpected second cpu sample: %v", second.CPUPercent)
	}
	if second.Network.RxBytesPerSecond == nil || *second.Network.RxBytesPerSecond <= 0 {
		t.Fatalf("unexpected second rx sample: %v", second.Network.RxBytesPerSecond)
	}
	if second.Network.TxBytesPerSecond == nil || *second.Network.TxBytesPerSecond <= 0 {
		t.Fatalf("unexpected second tx sample: %v", second.Network.TxBytesPerSecond)
	}
}

func TestMetricsCommandFailureStatus(t *testing.T) {
	linux := metricsFixture("cpu 100 20 30 400 10 5 3 2 0 0", "")
	for _, tc := range []struct {
		name, output string
		status       int
	}{
		{"network read failed", linux, http.StatusBadGateway},
		{"valid output but failed command", linux + "eth0: 1000 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0", http.StatusBadGateway},
		{"unsupported platform", strings.Replace(linux, "Linux", "Darwin", 1), http.StatusNotImplemented},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			t.Setenv("USERPROFILE", t.TempDir())
			signer, port := startMetricsSSHServer(t, []string{tc.output}, 1)
			sessions := service.NewSessionSvr()
			defer sessions.CloseAll()
			id, err := sessions.Connect("127.0.0.1", "test", "password", port, service.HostKeyPolicy{
				Mode: service.HostKeyModeOnce, Fingerprint: ssh.FingerprintSHA256(signer.PublicKey()),
			})
			if err != nil {
				t.Fatal(err)
			}
			router := gin.New()
			router.GET("/api/sessions/:id/metrics", handler.NewMetricsHandler(sessions).Get)
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/sessions/"+id+"/metrics", nil))
			if recorder.Code != tc.status {
				t.Fatalf("status = %d, want %d; body: %s", recorder.Code, tc.status, recorder.Body.String())
			}
		})
	}
}
