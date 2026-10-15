module github.com/boson-chat/boson/desktop

go 1.27.0

require (
	github.com/boson-chat/boson v0.0.0
	github.com/wailsapp/wails/v3 v3.0.0-beta.30
)

replace github.com/boson-chat/boson => ../

require (
	al.essio.dev/pkg/shellescape v1.6.0 // indirect
	github.com/adrg/xdg v0.5.3 // indirect
	github.com/coder/websocket v1.8.14 // indirect
	github.com/danieljoos/wincred v1.2.3 // indirect
	github.com/go-ole/go-ole v1.3.0 // indirect
	github.com/godbus/dbus/v5 v5.2.2 // indirect
	github.com/lrstanley/girc v1.1.1 // indirect
	github.com/mattn/go-colorable v0.1.14 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/zalando/go-keyring v0.2.6 // indirect
	golang.org/x/sys v0.47.0 // indirect
)
