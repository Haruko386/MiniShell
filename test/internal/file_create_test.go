package internal_test

import (
	"io"
	"net"
	"testing"

	"github.com/Haruko386/MiniShell/internal/service"
	"github.com/pkg/sftp"
)

func TestCreateFileAndDirectory(t *testing.T) {
	serverConn, clientConn := net.Pipe()
	server := sftp.NewRequestServer(serverConn, sftp.InMemHandler())
	go func() { _ = server.Serve() }()
	t.Cleanup(func() { _ = server.Close() })
	client, err := sftp.NewClientPipe(clientConn, clientConn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	svr := service.NewFileSvr()
	if err := svr.CreateDir(client, "/新建 目录"); err != nil {
		t.Fatal(err)
	}
	if err := svr.CreateFile(client, "/新建 目录", ".hello.txt"); err != nil {
		t.Fatal(err)
	}
	info, err := client.Stat("/新建 目录/.hello.txt")
	if err != nil || info.Size() != 0 || !info.Mode().IsRegular() {
		t.Fatalf("expected empty file, got %v, %v", info, err)
	}
	file, err := client.Create("/新建 目录/.hello.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte("keep me")); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	for name, create := range map[string]func() error{
		"existing file":            func() error { return svr.CreateFile(client, "/新建 目录", ".hello.txt") },
		"existing directory":       func() error { return svr.CreateDir(client, "/新建 目录") },
		"file over directory":      func() error { return svr.CreateFile(client, "/", "新建 目录") },
		"directory over file":      func() error { return svr.CreateDir(client, "/新建 目录/.hello.txt") },
		"missing file parent":      func() error { return svr.CreateFile(client, "/missing", "file") },
		"missing directory parent": func() error { return svr.CreateDir(client, "/missing/dir") },
	} {
		t.Run(name, func(t *testing.T) {
			if err := create(); err == nil {
				t.Fatal("creation should fail")
			}
		})
	}
	file, err = client.Open("/新建 目录/.hello.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil || string(data) != "keep me" {
		t.Fatalf("existing content changed: %q, %v", data, err)
	}
}
