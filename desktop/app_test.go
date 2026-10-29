package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/Haruko386/MiniShell/internal/engine"
	"github.com/Haruko386/MiniShell/internal/entity"
	"github.com/Haruko386/MiniShell/internal/service"
)

func TestDesktopTransferBridge(t *testing.T) {
	sessions := service.NewSessionSvr()
	manager := engine.NewManager(sessions, service.NewFileSvr())
	if err := manager.Start(2); err != nil {
		t.Fatal(err)
	}
	app := &App{ctx: context.Background(), manager: manager}
	local := filepath.Join(t.TempDir(), "test.txt")
	if err := os.WriteFile(local, []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	upload, err := app.SubmitUpload("missing", "/root/Dataset", local)
	if err != nil {
		t.Fatal(err)
	}
	download, err := app.SubmitDownload("missing", "/root/Dataset/test.txt", filepath.Dir(local))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = app.SubmitUpload("missing", "relative", local); err == nil {
		t.Fatal("accepted relative remote directory")
	}
	if _, err = app.SubmitDownload("missing", "/file", "relative"); err == nil {
		t.Fatal("accepted relative local directory")
	}
	manager.Stop()
	for _, id := range []string{upload, download} {
		status, err := app.TransferStatus(id)
		if err != nil {
			t.Fatal(err)
		}
		if status.Status != entity.TaskFailed || status.Error == "" {
			t.Fatalf("unexpected status: %+v", status)
		}
	}
	if _, err = app.TransferStatus("unknown"); err == nil {
		t.Fatal("unknown task accepted")
	}
}
