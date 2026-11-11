//go:build windows

package main

import (
	"os"
	"path/filepath"
	"testing"
	"unsafe"
)

func TestWindowPlacementPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "MiniShell", "window-state.json")
	if _, err := readWindowPlacement(path); !os.IsNotExist(err) {
		t.Fatalf("missing state: %v", err)
	}
	var p windowPlacement
	p.ShowCmd = 3
	p.NormalPosition.Left, p.NormalPosition.Top = -1200, 80
	p.NormalPosition.Right, p.NormalPosition.Bottom = -200, 780
	for _, state := range []uint32{3, 1} {
		p.ShowCmd = state
		if err := writeWindowPlacement(path, p); err != nil {
			t.Fatal(err)
		}
		got, err := readWindowPlacement(path)
		if err != nil {
			t.Fatal(err)
		}
		if got.NormalPosition != p.NormalPosition || got.ShowCmd != state || got.Length != uint32(unsafe.Sizeof(p)) {
			t.Fatalf("placement did not round trip: %+v", got)
		}
	}
	for _, data := range []string{"{", "{}", `{"ShowCmd":3,"NormalPosition":{"Left":100,"Right":50,"Bottom":800}}`} {
		if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := readWindowPlacement(path); err == nil {
			t.Fatalf("accepted invalid state: %s", data)
		}
	}
}

func TestMinimisedWindowReopensVisible(t *testing.T) {
	for _, tc := range []struct{ flags, want uint32 }{{0, 1}, {2, 3}} {
		p := windowPlacement{ShowCmd: 2, Flags: tc.flags}
		p.NormalPosition.Right, p.NormalPosition.Bottom = 1280, 800
		path := filepath.Join(t.TempDir(), "window-state.json")
		if err := writeWindowPlacement(path, p); err != nil {
			t.Fatal(err)
		}
		got, err := readWindowPlacement(path)
		if err != nil {
			t.Fatal(err)
		}
		if got.ShowCmd != tc.want || got.Flags != 0 {
			t.Fatalf("unexpected restore state: %+v", got)
		}
	}
}
