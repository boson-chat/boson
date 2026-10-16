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
	"github.com/wailsapp/wails/v3/pkg/services/notifications"
)

//go:embed all:frontend/dist
var assets embed.FS

// Build-time settings (go build -ldflags "-X main.apiBase=… -X main.devBuild=true").
var (
	// apiBase is the Boson API the proxy may reach (default: production).
	apiBase = ""
	// devBuild is "true" for dev and e2e builds: the API proxy may also reach
	// a local backend on any loopback port, and nothing checks for updates.
	devBuild = "false"
	// appVersion is the release this build is (client/package.json's version).
	appVersion = "0.0.0-dev"
	// youtubeWrapperOrigin is the https origin hosting the YouTube wrapper
	// (website/public/youtube-embed.*); empty uses the app's own loopback
	// copy. WebKit needs a real site for some videos (a loopback wrapper
	// still got the player's error).
	youtubeWrapperOrigin = "https://boson.chat"
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
	// so e2e runs never touch the real one.
	secureMode := ""
	if devBuild == "true" {
		secureMode = os.Getenv("BOSON_SECURE_STORE")
	}
	dev := devBuild == "true"
	e2e := dev && os.Getenv("BOSON_E2E") == "1"
	// The YouTube wrapper: boson.chat's (or -X main.youtubeWrapperOrigin=…;
	// empty for the app's own loopback copy). The e2e build always uses its
	// own: it stubs YouTube.
	youtubeWrapper := youtubeWrapperOrigin
	if e2e {
		youtubeWrapper = ""
	}
	links := NewLinksService(dev)
	api := NewApiService(apiBase, dev)
	deepLinks := &DeepLinkService{}
	engine := &EngineService{}
	spotify := NewSpotifyService()
	updater := NewUpdaterService(appVersion, !dev, links)
	native := notifications.New()
	notify := NewNotifyService(native)
	// One running app: a second launch (a boson:// click on Windows/Linux)
	// hands its args over and exits. Its args are untrusted input — parsed
	// strictly by the renderer (deep-link.ts). Off for e2e runs,
	// where parallel tests each run their own app.
	var single *application.SingleInstanceOptions
	if !e2e {
		single = &application.SingleInstanceOptions{
			UniqueID:               "chat.boson.app",
			OnSecondInstanceLaunch: func(d application.SecondInstanceData) { deepLinks.onSecondInstance(d.Args) },
		}
	}
	app := application.New(application.Options{
		Name:        "Boson",
		Description: "Boson chat",
		Services: []application.Service{
			application.NewService(engine),
			application.NewService(api),
			application.NewService(NewSecureStore(dataDir, secureMode)),
			application.NewService(NewUnfurlService(dev)),
			application.NewService(spotify),
			application.NewService(NewThemesService(dataDir)),
			application.NewService(links),
			application.NewService(deepLinks),
			application.NewService(notify),
			application.NewService(updater),
			application.NewService(NewYouTubeService(dist, youtubeWrapper)),
			application.NewService(NewE2EService(dev, e2eTargets{links, deepLinks, api, engine, spotify, updater})),
		},
		Assets: application.AssetOptions{
			Handler: assetHandler(dist),
		},
		SingleInstance: single,
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

	win := app.Window.NewWithOptions(application.WebviewWindowOptions{
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

	deepLinks.attach(app, win, os.Args[1:])
	notify.win = win

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
	// Dev and e2e builds can point it elsewhere (a test profile).
	if dir := os.Getenv("BOSON_DATA_DIR"); dir != "" && devBuild == "true" {
		return dir, os.MkdirAll(dir, 0o700)
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, "Boson")
	return dir, os.MkdirAll(dir, 0o700)
}
