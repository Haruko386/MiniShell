package service

import (
	"errors"
	"testing"

	"github.com/Haruko386/MiniShell/internal/entity"
)

func diskOutput(osName, df string) string {
	return "__MINISHELL_OS__\n" + osName + "\n" +
		"__MINISHELL_DF__\n" + df
}

func TestParseDisks(t *testing.T) {
	df := "Filesystem     1024-blocks      Used Available Capacity Mounted on\n" +
		"/dev/sda1           440700    100000    340700      23% /\n" +
		"tmpfs              1024000         0   1024000       0% /dev\n" +
		"/dev/sdb1           100000     50000     50000      50% /home\n" +
		"server:/data        200000    100000    100000      50% /mnt/my disk"

	disks, err := parseDisks(diskOutput("Linux", df))
	if err != nil {
		t.Fatal(err)
	}
	if len(disks) != 4 {
		t.Fatalf("unexpected disk count: %d", len(disks))
	}

	root := disks[0]
	if root.MountPoint != "/" || root.Filesystem != "/dev/sda1" {
		t.Fatalf("root should be first: %+v", root)
	}
	if root.TotalBytes != 440700*1024 || root.UsedBytes != 100000*1024 || root.AvailableBytes != 340700*1024 {
		t.Fatalf("unexpected root bytes: %+v", root)
	}
	if root.UsedPercent != 22.7 {
		t.Fatalf("unexpected root percent: %v", root.UsedPercent)
	}

	if disks[1].MountPoint != "/dev" || disks[2].MountPoint != "/home" || disks[3].MountPoint != "/mnt/my disk" {
		t.Fatalf("unexpected mount order: %+v", disks)
	}
}

func TestParseDisksUnsupportedPlatform(t *testing.T) {
	_, err := parseDisks(diskOutput("Darwin", "df: not supported"))
	if !errors.Is(err, entity.ErrDisksUnsupported) {
		t.Fatalf("expected unsupported, got %v", err)
	}
}

func TestParseDisksMissingMarker(t *testing.T) {
	_, err := parseDisks("__MINISHELL_OS__\nLinux\n")
	if !errors.Is(err, entity.ErrDisksUnavailable) {
		t.Fatalf("expected unavailable, got %v", err)
	}
}

func TestParseDisksHeaderOnly(t *testing.T) {
	disks, err := parseDisks(diskOutput("Linux", "Filesystem 1024-blocks Used Available Capacity Mounted on"))
	if err != nil {
		t.Fatal(err)
	}
	if len(disks) != 0 {
		t.Fatalf("expected empty disks, got %+v", disks)
	}
}

func TestParseDisksInvalidLines(t *testing.T) {
	_, err := parseDisks(diskOutput("Linux", "broken line with many columns 1 2 3"))
	if !errors.Is(err, entity.ErrDisksUnavailable) {
		t.Fatalf("expected unavailable, got %v", err)
	}
}
