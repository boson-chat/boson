package main

import (
	"context"
	"html"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// OgCard is a link preview: OpenGraph / title metadata from a page.
type OgCard struct {
	URL         string `json:"url"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	Image       string `json:"image,omitempty"`
	SiteName    string `json:"siteName,omitempty"`
	Author      string `json:"author,omitempty"`
	Date        string `json:"date,omitempty"` // ISO 8601, when the page has one
}

// UnfurlService fetches link previews for the renderer, which can't fetch
// arbitrary sites itself (CORS). It only runs when the user loads a preview
// (click-to-load by default) and never for loopback or private hosts.
// A port of client/src/main/unfurl.ts and og-parse.ts.
type UnfurlService struct {
	web   *webFetcher
	cache *ttlCache[*OgCard]
}

const (
	unfurlMaxBytes   = 512 * 1024 // the <head> is enough for most pages
	unfurlYTMaxBytes = 1100 * 1024
)

// YouTube emits its OG tags and JSON-LD ~640–700 KB into the document.
var youTubeHosts = map[string]bool{"youtube.com": true, "www.youtube.com": true, "m.youtube.com": true, "music.youtube.com": true, "youtu.be": true}

func NewUnfurlService(allowHostMap bool) *UnfurlService {
	return &UnfurlService{web: newWebFetcher(5*time.Second, allowHostMap), cache: newTTLCache[*OgCard](200, 30*time.Minute, time.Minute)}
}

func (s *UnfurlService) Fetch(ctx context.Context, raw string) *OgCard {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil
	}
	if isBlockedHost(u.Hostname()) && s.web.hostMap[strings.ToLower(u.Hostname())] == "" {
		return nil
	}
	if card, ok := s.cache.get(raw); ok {
		return card
	}
	var card *OgCard
	limit := int64(unfurlMaxBytes)
	if youTubeHosts[strings.ToLower(u.Hostname())] {
		limit = unfurlYTMaxBytes
	}
	body, final, ct, err := s.web.get(ctx, raw, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", limit)
	if err == nil && strings.Contains(ct, "text/html") {
		c := parseOg(string(body), final)
		card = &c
	}
	s.cache.put(raw, card)
	return card
}

func metaRe(attr, key string) *regexp.Regexp {
	return regexp.MustCompile(`(?i)<meta\b[^>]*\b` + attr + `\s*=\s*["']` + regexp.QuoteMeta(key) + `["'][^>]*>`)
}

var (
	contentRe   = regexp.MustCompile(`(?i)\bcontent\s*=\s*["']([^"']*)["']`)
	titleTagRe  = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	authorStrRe = regexp.MustCompile(`(?i)"author"\s*:\s*"([^"\\]{1,160})"`)
	authorObjRe = regexp.MustCompile(`(?i)"author"\s*:\s*\{[^}]{0,400}?"name"\s*:\s*"([^"\\]{1,160})"`)
	authorLnkRe = regexp.MustCompile(`(?i)<link\b[^>]*\bitemprop\s*=\s*["']name["'][^>]*\bcontent\s*=\s*["']([^"']{1,160})["'][^>]*>`)
)

func tagContent(doc string, re *regexp.Regexp) string {
	tag := re.FindString(doc)
	if tag == "" {
		return ""
	}
	m := contentRe.FindStringSubmatch(tag)
	if m == nil {
		return ""
	}
	return html.UnescapeString(strings.TrimSpace(m[1]))
}

func metaContent(doc, key string) string {
	return tagContent(doc, metaRe(`(?:property|name)`, key))
}

func jsonStr(doc, key string) string {
	m := regexp.MustCompile(`(?i)"` + regexp.QuoteMeta(key) + `"\s*:\s*"([^"\\]{1,300})"`).FindStringSubmatch(doc)
	if m == nil {
		return ""
	}
	return html.UnescapeString(m[1])
}

func first(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func parseOg(doc, pageURL string) OgCard {
	// Some sites (YouTube) put metadata far down the document.
	if len(doc) > 1_200_000 {
		doc = doc[:1_200_000]
	}
	card := OgCard{URL: pageURL}
	title := ""
	if m := titleTagRe.FindStringSubmatch(doc); m != nil {
		title = html.UnescapeString(strings.TrimSpace(m[1]))
	}
	card.Title = first(metaContent(doc, "og:title"), title)
	card.Description = first(metaContent(doc, "og:description"), metaContent(doc, "description"))
	card.Image = absolutize(first(metaContent(doc, "og:image"), metaContent(doc, "twitter:image")), pageURL)
	card.SiteName = metaContent(doc, "og:site_name")
	author := ""
	if m := authorStrRe.FindStringSubmatch(doc); m != nil {
		author = m[1]
	} else if m := authorObjRe.FindStringSubmatch(doc); m != nil {
		author = m[1]
	} else if m := authorLnkRe.FindStringSubmatch(doc); m != nil {
		author = m[1]
	}
	card.Author = first(metaContent(doc, "author"), metaContent(doc, "article:author"), metaContent(doc, "og:article:author"), html.UnescapeString(author))
	card.Date = first(metaContent(doc, "article:published_time"), metaContent(doc, "og:article:published_time"),
		tagContent(doc, metaRe("itemprop", "datePublished")), jsonStr(doc, "uploadDate"), jsonStr(doc, "datePublished"))
	return card
}

// absolutize resolves a possibly relative image URL against the page; only
// http(s) results are kept.
func absolutize(img, base string) string {
	if img == "" {
		return ""
	}
	b, err := url.Parse(base)
	if err != nil {
		return ""
	}
	u, err := b.Parse(img)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return ""
	}
	return u.String()
}

// ttlCache is a small bounded cache; misses (nil) expire sooner so a
// transient failure recovers.
type ttlCache[T comparable] struct {
	mu         sync.Mutex
	max        int
	ttl, negTL time.Duration
	order      []string
	items      map[string]ttlEntry[T]
}

type ttlEntry[T any] struct {
	at  time.Time
	val T
}

func newTTLCache[T comparable](max int, ttl, negTTL time.Duration) *ttlCache[T] {
	return &ttlCache[T]{max: max, ttl: ttl, negTL: negTTL, items: map[string]ttlEntry[T]{}}
}

func (c *ttlCache[T]) get(k string) (T, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var zero T
	e, ok := c.items[k]
	if !ok {
		return zero, false
	}
	ttl := c.ttl
	if e.val == zero {
		ttl = c.negTL
	}
	if time.Since(e.at) >= ttl {
		return zero, false
	}
	return e.val, true
}

func (c *ttlCache[T]) put(k string, v T) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.items[k]; !ok {
		if len(c.order) >= c.max {
			delete(c.items, c.order[0])
			c.order = c.order[1:]
		}
		c.order = append(c.order, k)
	}
	c.items[k] = ttlEntry[T]{at: time.Now(), val: v}
}
