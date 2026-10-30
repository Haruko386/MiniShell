package internal_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Haruko386/MiniShell/internal/common"
	"github.com/Haruko386/MiniShell/internal/engine"
	"github.com/Haruko386/MiniShell/internal/entity"
	"github.com/Haruko386/MiniShell/internal/service"
	"github.com/google/uuid"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

func TestPreviewCancellationDoesNotExhaustSFTPPool(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", t.TempDir())
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	config := &ssh.ServerConfig{NoClientAuth: true}
	config.AddHostKey(signer)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	started := make(chan struct{}, 4)
	var channels atomic.Int32
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		server, incoming, requests, err := ssh.NewServerConn(conn, config)
		if err != nil {
			conn.Close()
			return
		}
		defer server.Close()
		go ssh.DiscardRequests(requests)
		for incomingChannel := range incoming {
			ch, reqs, err := incomingChannel.Accept()
			if err != nil {
				continue
			}
			num := channels.Add(1)
			go func() {
				defer ch.Close()
				for req := range reqs {
					if req.Type != "subsystem" {
						_ = req.Reply(false, nil)
						continue
					}
					_ = req.Reply(true, nil)
					if num <= 4 {
						var length [4]byte
						if _, err := io.ReadFull(ch, length[:]); err != nil {
							return
						}
						packet := make([]byte, binary.BigEndian.Uint32(length[:]))
						if _, err := io.ReadFull(ch, packet); err != nil {
							return
						}
						if _, err := ch.Write([]byte{0, 0, 0, 5, 2, 0, 0, 0, 3}); err != nil {
							return
						}
						if _, err := io.ReadFull(ch, length[:]); err != nil {
							return
						}
						started <- struct{}{}
						_, _ = io.Copy(io.Discard, ch)
						return
					}
					fs, err := sftp.NewServer(ch)
					if err != nil {
						return
					}
					defer fs.Close()
					_ = fs.Serve()
					return
				}
			}()
		}
	}()
	addr := listener.Addr().(*net.TCPAddr)
	sessions := service.NewSessionSvr()
	defer sessions.CloseAll()
	id, err := sessions.Connect("127.0.0.1", "test", "password", addr.Port, service.HostKeyPolicy{Mode: service.HostKeyModeOnce, Fingerprint: ssh.FingerprintSHA256(signer.PublicKey())})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	results := make(chan error, 4)
	for i := 0; i < 4; i++ {
		go func() { _, err := sessions.PreviewImage(ctx, id, "/test.png", service.NewFileSvr()); results <- err }()
	}
	for i := 0; i < 4; i++ {
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			cancel()
			t.Fatal("preview did not reach stalled SFTP request")
		}
	}
	cancel()
	for i := 0; i < 4; i++ {
		select {
		case err := <-results:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("preview: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("preview did not cancel")
		}
	}
	acquired := make(chan error, 1)
	go func() {
		_, release, err := sessions.AcquireSFTP(id)
		if err == nil {
			release()
		}
		acquired <- err
	}()
	select {
	case err := <-acquired:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("shared SFTP pool blocked")
	}
}

func TestGenerateUUID(t *testing.T) {
	seen := make(map[string]struct{}, 100)

	for i := 0; i < 100; i++ {
		id := common.GenerateUUID()
		if id == "" {
			t.Fatal("empty UUID")
		}
		if _, err := uuid.Parse(id); err != nil {
			t.Fatalf("invalid UUID %q: %v", id, err)
		}
		if _, ok := seen[id]; ok {
			t.Fatalf("duplicate UUID %q", id)
		}
		seen[id] = struct{}{}
	}
}

func TestManagerStatusString(t *testing.T) {
	tests := []struct {
		status entity.ManagerStatus
		want   string
	}{
		{entity.ManagerStatusCreated, "Created"},
		{entity.ManagerStatusRunning, "Running"},
		{entity.ManagerStatusDraining, "Draining"},
		{entity.ManagerStatusStopped, "Stopped"},
		{entity.ManagerStatus(99), "Unknown"},
	}

	for _, tt := range tests {
		if got := tt.status.String(); got != tt.want {
			t.Fatalf("status %d: got %q, want %q", tt.status, got, tt.want)
		}
	}
}

func TestSessionSvrMissingSession(t *testing.T) {
	svr := service.NewSessionSvr()
	defer svr.CloseAll()

	if _, ok := svr.Get("missing"); ok {
		t.Fatal("unexpected session")
	}

	if err := svr.Close("missing"); !errors.Is(err, service.ErrSessionNotFound) {
		t.Fatalf("close: got %v", err)
	}

	if _, _, err := svr.AcquireSFTP("missing"); !errors.Is(err, service.ErrSessionNotFound) {
		t.Fatalf("acquire SFTP: got %v", err)
	}
}

func TestHostKeyErrorMessages(t *testing.T) {
	unknown := &service.HostKeyError{Host: "example.com", Port: 22}
	if !strings.Contains(unknown.Error(), "unknown host key") {
		t.Fatalf("unexpected unknown host message: %q", unknown.Error())
	}

	changed := &service.HostKeyError{Host: "example.com", Port: 2222, Changed: true}
	if !strings.Contains(changed.Error(), "mismatch") {
		t.Fatalf("unexpected changed host message: %q", changed.Error())
	}
}

func TestManagerLifecycle(t *testing.T) {
	manager := engine.NewManager(service.NewSessionSvr(), service.NewFileSvr())

	if err := manager.Start(0); err == nil {
		t.Fatal("expected invalid worker count to fail")
	}
	if err := manager.Start(1); err != nil {
		t.Fatal(err)
	}
	defer manager.Stop()

	if err := manager.Start(1); err == nil {
		t.Fatal("expected second Start to fail")
	}
	if manager.Status() != entity.ManagerStatusRunning {
		t.Fatalf("unexpected status: %s", manager.Status())
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := manager.Submit(ctx, entity.Task{
		SessionID:  "missing",
		Direction:  "upload",
		LocalPath:  "local",
		RemotePath: "/remote",
	}); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled submit: got %v", err)
	}

	id, err := manager.Submit(context.Background(), entity.Task{
		SessionID:  "missing",
		Direction:  "upload",
		LocalPath:  "local",
		RemotePath: "/remote",
	})
	if err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for {
		status, ok := manager.GetStatus(id)
		if ok && status.Status == entity.TaskFailed {
			if status.Error == nil || !strings.Contains(status.Error.Error(), "session") {
				t.Fatalf("unexpected task error: %v", status.Error)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("task did not fail in time: %+v", status)
		}
		time.Sleep(10 * time.Millisecond)
	}

	if _, ok := manager.GetStatus("unknown"); ok {
		t.Fatal("unexpected unknown task status")
	}

	manager.Stop()
	if manager.Status() != entity.ManagerStatusStopped {
		t.Fatalf("unexpected stopped status: %s", manager.Status())
	}
	if _, err := manager.Submit(context.Background(), entity.Task{
		SessionID:  "missing",
		Direction:  "upload",
		LocalPath:  "local",
		RemotePath: "/remote",
	}); err == nil {
		t.Fatal("submit after Stop should fail")
	}
}
