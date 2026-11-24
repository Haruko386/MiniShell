package internal_test

import (
	"context"
	"testing"

	"github.com/Haruko386/MiniShell/internal/service"
	"golang.org/x/crypto/ssh"
)

func TestSessionDisks(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", t.TempDir())

	output := "__MINISHELL_OS__\nLinux\n" +
		"__MINISHELL_DF__\n" +
		"Filesystem     1024-blocks      Used Available Capacity Mounted on\n" +
		"/dev/sda1           440700    100000    340700      23% /\n" +
		"tmpfs              1024000         0   1024000       0% /dev\n"
	signer, port := startMetricsSSHServer(t, []string{output}, 0)

	sessions := service.NewSessionSvr()
	defer sessions.CloseAll()

	id, err := sessions.Connect("127.0.0.1", "test", "password", port, service.HostKeyPolicy{
		Mode:        service.HostKeyModeOnce,
		Fingerprint: ssh.FingerprintSHA256(signer.PublicKey()),
	})
	if err != nil {
		t.Fatal(err)
	}

	snapshot, err := sessions.Disks(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Disks) != 2 {
		t.Fatalf("unexpected disk count: %d", len(snapshot.Disks))
	}
	root := snapshot.Disks[0]
	if root.MountPoint != "/" || root.TotalBytes != 440700*1024 || root.UsedPercent != 22.7 {
		t.Fatalf("unexpected root partition: %+v", root)
	}
}
