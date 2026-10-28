package main

import (
	"embed"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"log"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()
	if err := app.startServer(); err != nil {
		log.Fatal(err)
	}
	err := wails.Run(&options.App{Title: "MiniShell", Width: 1280, Height: 800, MinWidth: 700, MinHeight: 500, AssetServer: &assetserver.Options{Assets: assets}, OnStartup: app.startup, OnShutdown: app.shutdown, Bind: []interface{}{app}, DragAndDrop: &options.DragAndDrop{EnableFileDrop: true}})
	if err != nil {
		log.Fatal(err)
	}
}
