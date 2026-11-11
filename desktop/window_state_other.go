//go:build !windows

package main

import (
	"context"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const windowClassName = "MiniShellWindow"

type windowStateManager struct{}

func (a *App) restoreWindow(ctx context.Context) { runtime.WindowShow(ctx) }
func (a *App) saveWindow(context.Context) bool   { return false }
