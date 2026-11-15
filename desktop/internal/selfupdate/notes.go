package selfupdate

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	// ([#56](…)) and ([4b8c528](…)): semantic-release's issue and commit links.
	refLink = regexp.MustCompile(`\s*\(\[[^\]]*\]\([^)]*\)\)`)
	mdLink  = regexp.MustCompile(`\[([^\]]*)\]\([^)]*\)`)
	bold    = regexp.MustCompile(`\*\*([^*]+)\*\*`)
)

// ShortNotes turns a release body (semantic-release's markdown) into a few
// plain-text lines for Settings → About: the section names and up to max
// entries, without the version heading, links or markup. The renderer shows
// it as text, never as HTML.
func ShortNotes(body string, max int) string {
	var out []string
	shown, hidden := 0, 0
	for _, line := range strings.Split(strings.ReplaceAll(body, "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		switch {
		case line == "", strings.HasPrefix(line, "# "), strings.HasPrefix(line, "## "):
			continue
		case strings.HasPrefix(line, "#"):
			if shown < max {
				out = append(out, strings.TrimSpace(strings.TrimLeft(line, "#")))
			}
			continue
		}
		item, isItem := strings.CutPrefix(line, "* ")
		if !isItem {
			item, isItem = strings.CutPrefix(line, "- ")
		}
		if !isItem {
			continue
		}
		if shown >= max {
			hidden++
			continue
		}
		item = refLink.ReplaceAllString(item, "")
		item = mdLink.ReplaceAllString(item, "$1")
		item = bold.ReplaceAllString(item, "$1")
		item = strings.TrimSpace(strings.ReplaceAll(item, "`", ""))
		if r := []rune(item); len(r) > 160 {
			item = strings.TrimSpace(string(r[:157])) + "…"
		}
		out = append(out, "• "+item)
		shown++
	}
	// A section heading with none of its entries shown says nothing.
	for len(out) > 0 && !strings.HasPrefix(out[len(out)-1], "• ") {
		out = out[:len(out)-1]
	}
	if hidden > 0 {
		out = append(out, fmt.Sprintf("…and %d more", hidden))
	}
	return strings.Join(out, "\n")
}
