//go:build windows

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"unsafe"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/sys/windows"
)

const windowClassName = "MiniShellWindow"

var (
	windowUser32       = windows.NewLazySystemDLL("user32.dll")
	getWindowPlacement = windowUser32.NewProc("GetWindowPlacement")
	setWindowPlacement = windowUser32.NewProc("SetWindowPlacement")
)

// Keep the native layout: Windows retains the normal rectangle even when maximised.
// Placement coordinates are workspace coordinates and must be restored with
// SetWindowPlacement, which also handles monitors that have been disconnected.
type windowPlacement struct {
	Length         uint32
	Flags          uint32
	ShowCmd        uint32
	MinPosition    struct{ X, Y int32 }
	MaxPosition    struct{ X, Y int32 }
	NormalPosition struct{ Left, Top, Right, Bottom int32 }
}

type windowStateManager struct{ once sync.Once }

func windowStatePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "MiniShell", "window-state.json"), nil
}

func mainWindowHandle() (windows.HWND, error) {
	var result windows.HWND
	err := windows.EnumWindows(windows.NewCallback(func(hwnd windows.HWND, _ uintptr) uintptr {
		var pid uint32
		_, err := windows.GetWindowThreadProcessId(hwnd, &pid)
		if err != nil || pid != uint32(os.Getpid()) {
			return 1
		}
		var name [256]uint16
		if _, err := windows.GetClassName(hwnd, &name[0], int32(len(name))); err == nil && windows.UTF16ToString(name[:]) == windowClassName {
			result = hwnd
		}
		return 1
	}), nil)
	if err != nil {
		return 0, err
	}
	if result == 0 {
		return 0, fmt.Errorf("MiniShell window not found")
	}
	return result, nil
}

func (p *windowPlacement) prepareRestore() error {
	r := p.NormalPosition
	if int64(r.Right)-int64(r.Left) <= 0 || int64(r.Bottom)-int64(r.Top) <= 0 {
		return fmt.Errorf("invalid window rectangle")
	}
	switch p.ShowCmd {
	case 1, 3: // normal / maximised
	case 2: // Do not reopen invisibly in the taskbar.
		p.ShowCmd = 1
		if p.Flags&2 != 0 {
			p.ShowCmd = 3
		} // WPF_RESTORETOMAXIMIZED
	default:
		return fmt.Errorf("invalid window show state: %d", p.ShowCmd)
	}
	p.Length = uint32(unsafe.Sizeof(*p))
	p.Flags = 0
	return nil
}

func readWindowPlacement(path string) (windowPlacement, error) {
	var p windowPlacement
	data, err := os.ReadFile(path)
	if err != nil {
		return p, err
	}
	if err = json.Unmarshal(data, &p); err != nil {
		return p, err
	}
	err = p.prepareRestore()
	return p, err
}

func writeWindowPlacement(path string, p windowPlacement) error {
	data, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), "window-state-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, writeErr := f.Write(data)
	closeErr := f.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), path)
}

func (a *App) restoreWindow(ctx context.Context) {
	// DOM readiness also fires on reload; only restore on the first load.
	a.windowState.once.Do(func() {
		if err := restoreWindowPlacement(); err != nil {
			if !os.IsNotExist(err) {
				log.Printf("Restore window: %v", err)
			}
			runtime.WindowShow(ctx)
		}
	})
}

func restoreWindowPlacement() error {
	path, err := windowStatePath()
	if err != nil {
		return err
	}
	p, err := readWindowPlacement(path)
	if err != nil {
		return err
	}
	hwnd, err := mainWindowHandle()
	if err != nil {
		return err
	}
	if ok, _, err := setWindowPlacement.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&p))); ok == 0 {
		return err
	}
	return nil
}

func (a *App) saveWindow(ctx context.Context) bool {
	if err := saveWindowPlacement(); err != nil {
		log.Printf("Save window: %v", err)
	}
	return false // Persistence failures must never prevent closing.
}

func saveWindowPlacement() error {
	hwnd, err := mainWindowHandle()
	if err != nil {
		return err
	}
	p := windowPlacement{}
	p.Length = uint32(unsafe.Sizeof(p))
	if ok, _, err := getWindowPlacement.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&p))); ok == 0 {
		return err
	}
	path, err := windowStatePath()
	if err != nil {
		return err
	}
	return writeWindowPlacement(path, p)
}
