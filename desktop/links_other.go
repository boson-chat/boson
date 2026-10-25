//go:build !ios

package main

import (
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// openLink opens an http(s) URL in the system browser. Browser.OpenURL runs
// the desktop's opener (`open`, xdg-open, …), which Android doesn't have;
// there an Intent hands the link to the browser.
func openLink(url string) error {
	if runtime.GOOS == "android" {
		application.Mobile.OpenURL(url)
		return nil
	}
	return application.Get().Browser.OpenURL(url)
}
