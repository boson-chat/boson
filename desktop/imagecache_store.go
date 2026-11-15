package main

import (
	"container/list"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// imageStore is the on-disk half of the image cache: a content-addressed,
// size-capped LRU. Bodies are files named by their SHA-256 under blobs/
// (two URLs serving the same bytes share one file, counted once); entries
// (one per URL, or per URL + thumbnail size) say which body is theirs and
// how fresh it is. The entry index lives in memory and is saved to
// index.json (atomically, debounced) so the cache survives a relaunch.
//
// The cap counts body bytes; when it's exceeded the least recently used
// entries go, and a body goes with the last entry that names it.
type imageStore struct {
	dir string
	now func() time.Time

	mu      sync.Mutex
	limit   int64
	size    int64 // bytes of the bodies on disk
	entries map[string]*imageEntry
	lru     *list.List // front: most recently used; values are *imageEntry
	blobs   map[string]*blobRef
	save    *time.Timer
	saveDue bool
	closed  bool
}

type blobRef struct {
	size int64
	refs int
}

// imageEntry is one cached answer. Expires is when it goes stale (it is
// revalidated then); HardExpiry, when set, is when it must not be served at
// all any more (an uploaded file's X-File-Expires-At).
type imageEntry struct {
	Key          string            `json:"key"`
	URL          string            `json:"url"`
	Blob         string            `json:"blob"`
	Size         int64             `json:"size"`
	Type         string            `json:"type"`
	ETag         string            `json:"etag,omitempty"`
	LastModified string            `json:"lastModified,omitempty"`
	Expires      time.Time         `json:"expires"`
	HardExpiry   time.Time         `json:"hardExpiry,omitzero"`
	NoCache      bool              `json:"noCache,omitempty"`
	MustReval    bool              `json:"mustRevalidate,omitempty"`
	Width        int               `json:"w,omitempty"`
	Height       int               `json:"h,omitempty"`
	OrigWidth    int               `json:"ow,omitempty"`
	OrigHeight   int               `json:"oh,omitempty"`
	Source       string            `json:"src,omitempty"` // a thumbnail: its original's blob
	Meta         map[string]string `json:"meta,omitempty"`
	Access       time.Time         `json:"access"`

	el *list.Element
}

const (
	imageIndexFile  = "index.json"
	imageIndexDelay = time.Second
)

var errTooLarge = errors.New("too large for the cache")

func openImageStore(dir string, limit int64, now func() time.Time) (*imageStore, error) {
	if now == nil {
		now = time.Now
	}
	s := &imageStore{
		dir: dir, now: now, limit: limit,
		entries: map[string]*imageEntry{}, lru: list.New(), blobs: map[string]*blobRef{},
	}
	if err := os.MkdirAll(filepath.Join(dir, "blobs"), 0o700); err != nil {
		return nil, err
	}
	s.load()
	return s, nil
}

// load reads the index, keeps the entries whose body is still on disk and
// deletes bodies no entry names (left over from a crash, say).
func (s *imageStore) load() {
	var saved []*imageEntry
	if b, err := os.ReadFile(filepath.Join(s.dir, imageIndexFile)); err == nil {
		_ = json.Unmarshal(b, &saved)
	}
	// Oldest access first, so pushing each to the front leaves the newest
	// at the front.
	sortByAccess(saved)
	for _, e := range saved {
		if e == nil || e.Key == "" || !validBlobName(e.Blob) || s.entries[e.Key] != nil {
			continue
		}
		ref := s.blobs[e.Blob]
		if ref == nil {
			st, err := os.Stat(s.blobPath(e.Blob))
			if err != nil || !st.Mode().IsRegular() {
				continue
			}
			ref = &blobRef{size: st.Size()}
			s.blobs[e.Blob] = ref
			s.size += ref.size
		}
		ref.refs++
		e.Size = ref.size
		e.el = s.lru.PushFront(e)
		s.entries[e.Key] = e
	}
	_ = filepath.WalkDir(filepath.Join(s.dir, "blobs"), func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if s.blobs[d.Name()] == nil {
			_ = os.Remove(path)
		}
		return nil
	})
	s.evictLocked()
}

func sortByAccess(es []*imageEntry) {
	sort.SliceStable(es, func(i, j int) bool {
		if es[i] == nil || es[j] == nil {
			return es[j] != nil
		}
		return es[i].Access.Before(es[j].Access)
	})
}

func validBlobName(name string) bool {
	if len(name) != 64 {
		return false
	}
	_, err := hex.DecodeString(name)
	return err == nil
}

func (s *imageStore) blobPath(blob string) string {
	return filepath.Join(s.dir, "blobs", blob[:2], blob)
}

// get returns key's entry (a copy) and marks it used.
func (s *imageStore) get(key string) (imageEntry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.entries[key]
	if e == nil {
		return imageEntry{}, false
	}
	e.Access = s.now()
	s.lru.MoveToFront(e.el)
	s.dirtyLocked()
	return *e, true
}

// peek is get without marking it used.
func (s *imageStore) peek(key string) (imageEntry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.entries[key]
	if e == nil {
		return imageEntry{}, false
	}
	return *e, true
}

// put stores body under e.Key (replacing what was there) and returns the
// stored entry. A body bigger than a quarter of the cap isn't kept.
func (s *imageStore) put(e imageEntry, body []byte) (imageEntry, error) {
	if int64(len(body)) > s.maxEntry() {
		return imageEntry{}, errTooLarge
	}
	sum := sha256.Sum256(body)
	blob := hex.EncodeToString(sum[:])
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return imageEntry{}, errors.New("cache closed")
	}
	// A body already on disk is pinned (a reference taken) before the lock
	// goes, so it can't be evicted under us.
	ref := s.blobs[blob]
	if ref != nil {
		ref.refs++
	}
	s.mu.Unlock()
	if ref == nil {
		if err := s.writeBlob(blob, body); err != nil {
			return imageEntry{}, err
		}
		s.mu.Lock()
		ref = s.blobs[blob]
		if ref == nil {
			ref = &blobRef{size: int64(len(body))}
			s.blobs[blob] = ref
			s.size += ref.size
		}
		ref.refs++
	} else {
		s.mu.Lock()
	}
	defer s.mu.Unlock()
	if old := s.entries[e.Key]; old != nil {
		s.dropLocked(old)
	}
	ne := e
	ne.Blob, ne.Size, ne.Access = blob, int64(len(body)), s.now()
	ne.el = s.lru.PushFront(&ne)
	s.entries[ne.Key] = &ne
	// May drop the new entry itself when the cap is tiny; the caller
	// answers from the bytes it has either way.
	s.evictLocked()
	s.dirtyLocked()
	out := ne
	out.el = nil
	return out, nil
}

// update changes an entry's freshness (a 304) without touching its body.
func (s *imageStore) update(key string, fn func(e *imageEntry)) (imageEntry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.entries[key]
	if e == nil {
		return imageEntry{}, false
	}
	fn(e)
	e.Access = s.now()
	s.lru.MoveToFront(e.el)
	s.dirtyLocked()
	return *e, true
}

func (s *imageStore) remove(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e := s.entries[key]; e != nil {
		s.dropLocked(e)
		s.dirtyLocked()
	}
}

// open opens an entry's body.
func (s *imageStore) open(e imageEntry) (*os.File, error) {
	return os.Open(s.blobPath(e.Blob))
}

func (s *imageStore) read(e imageEntry) ([]byte, error) {
	return os.ReadFile(s.blobPath(e.Blob))
}

func (s *imageStore) writeBlob(blob string, body []byte) error {
	dir := filepath.Dir(s.blobPath(blob))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	if _, err := f.Write(body); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, s.blobPath(blob))
}

// dropLocked forgets e, and its body when nothing else names it.
func (s *imageStore) dropLocked(e *imageEntry) {
	delete(s.entries, e.Key)
	if e.el != nil {
		s.lru.Remove(e.el)
		e.el = nil
	}
	ref := s.blobs[e.Blob]
	if ref == nil {
		return
	}
	ref.refs--
	if ref.refs <= 0 {
		delete(s.blobs, e.Blob)
		s.size -= ref.size
		_ = os.Remove(s.blobPath(e.Blob))
	}
}

// evictLocked drops least recently used entries until the bodies fit.
func (s *imageStore) evictLocked() {
	for s.size > s.limit && s.lru.Len() > 0 {
		s.dropLocked(s.lru.Back().Value.(*imageEntry))
	}
}

func (s *imageStore) maxEntry() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.limit / 4
}

func (s *imageStore) setLimit(limit int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.limit = limit
	s.evictLocked()
	s.dirtyLocked()
}

// stats: bytes on disk, the cap, entries.
func (s *imageStore) stats() (int64, int64, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.size, s.limit, len(s.entries)
}

// clear drops everything.
func (s *imageStore) clear() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.entries {
		s.dropLocked(e)
	}
	s.dirtyLocked()
}

// dirtyLocked schedules an index save.
func (s *imageStore) dirtyLocked() {
	if s.closed {
		return
	}
	s.saveDue = true
	if s.save == nil {
		s.save = time.AfterFunc(imageIndexDelay, func() { _ = s.flush() })
	}
}

// flush writes the index now (when it changed).
func (s *imageStore) flush() error {
	s.mu.Lock()
	if s.save != nil {
		s.save.Stop()
		s.save = nil
	}
	if !s.saveDue {
		s.mu.Unlock()
		return nil
	}
	s.saveDue = false
	out := make([]*imageEntry, 0, len(s.entries))
	for el := s.lru.Back(); el != nil; el = el.Prev() {
		e := *el.Value.(*imageEntry)
		e.el = nil
		out = append(out, &e)
	}
	s.mu.Unlock()
	b, err := json.Marshal(out)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(s.dir, ".index-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	if _, err := f.Write(b); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, filepath.Join(s.dir, imageIndexFile))
}

func (s *imageStore) close() error {
	err := s.flush()
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	return err
}
