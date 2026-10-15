package main

import (
	"embed"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strconv"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var assets embed.FS

// Build-time settings (go build -ldflags "-X main.apiBase=… -X main.devBuild=true").
var (
	// apiBase is the Boson API the proxy may reach (default: production).
	apiBase = ""
	// devBuild is "true" for dev and e2e builds: the API proxy may also reach
	// a local backend on any loopback port.
	devBuild = "false"
)

func main() {
	dist, err := fs.Sub(assets, "frontend/dist")
	if err != nil {
		log.Fatal(err)
	}
	dataDir, err := appDataDir()
	if err != nil {
		log.Fatal(err)
	}
	// Dev and e2e builds may skip the OS keychain (BOSON_SECURE_STORE=derived),
	// as the Electron e2e suite does with its mock keychain.
	secureMode := ""
	if devBuild == "true" {
		secureMode = os.Getenv("BOSON_SECURE_STORE")
	}
	app := application.New(application.Options{
		Name:        "Boson",
		Description: "Boson chat",
		Services: []application.Service{
			application.NewService(&EngineService{}),
			application.NewService(NewApiService(apiBase, devBuild == "true")),
			application.NewService(NewSecureStore(dataDir, secureMode)),
		},
		Assets: application.AssetOptions{
			Handler: assetHandler(dist),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
		// Used only by a server-mode build (-tags server), which serves the
		// app to a browser — how e2e tests drive it.
		Server: application.ServerOptions{
			Host: "127.0.0.1",
			Port: serverPort(),
		},
	})

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:     "Boson",
		Width:     1280,
		Height:    800,
		MinWidth:  900,
		MinHeight: 600,
		// The renderer draws its own 32px title bar. On macOS the native
		// traffic lights stay, over it: the plain hidden style (no toolbar
		// inset) centres them in a 28px strip, close enough to ours — Wails
		// can't position them (wails#4227). Windows and Linux are frameless;
		// the renderer draws min/max/close there.
		Frameless: runtime.GOOS != "darwin",
		Mac: application.MacWindow{
			TitleBar: application.MacTitleBarHidden,
		},
		BackgroundColour: application.NewRGB(0x1a, 0x1b, 0x1e),
		URL:              "/",
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

// serverPort is BOSON_SERVER_PORT, for server-mode builds (default 8080).
func serverPort() int {
	if p, err := strconv.Atoi(os.Getenv("BOSON_SERVER_PORT")); err == nil && p > 0 {
		return p
	}
	return 8080
}

// appDataDir is where the app keeps its files (the secure store, themes):
// <user config dir>/Boson, e.g. ~/Library/Application Support/Boson.
func appDataDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, "Boson")
	return dir, os.MkdirAll(dir, 0o700)
}
