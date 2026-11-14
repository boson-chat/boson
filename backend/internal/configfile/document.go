// Package configfile reads the shared boson stack config file
// (config/boson.yaml, path in BOSON_CONFIG) and watches it for changes.
//
// The file is YAML with a top-level `version: 1` and one section per
// service. A service reads only its own section and ignores the rest.
// Within a section an absent (or null) key means "use the env value / the
// built-in default", so removing a key resets it.
//
// Document and Section decode values one key at a time so every error
// carries the line and column of the offending value. Watcher (watch.go)
// reloads the file when it changes and keeps the last good config when a
// new version is invalid.
//
// This package is copied, not shared, between the boson services (auth,
// directory, boson api); keep the copies in step.
package configfile

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Version is the only file format version this code understands.
const Version = 1

// Error is a problem in the file. Line and Column are 1-based; 0 means
// unknown (the YAML parser reports a line only for syntax errors).
type Error struct {
	Line   int
	Column int
	Msg    string
}

func (e *Error) Error() string {
	switch {
	case e.Line > 0 && e.Column > 0:
		return fmt.Sprintf("line %d, column %d: %s", e.Line, e.Column, e.Msg)
	case e.Line > 0:
		return fmt.Sprintf("line %d: %s", e.Line, e.Msg)
	}
	return e.Msg
}

// At returns an Error positioned at n (n may be nil).
func At(n *yaml.Node, format string, args ...any) *Error {
	e := &Error{Msg: fmt.Sprintf(format, args...)}
	if n != nil {
		e.Line, e.Column = n.Line, n.Column
	}
	return e
}

var yamlLine = regexp.MustCompile(`^yaml: line (\d+): (.*)$`)

// syntaxError turns a yaml.v3 parse error into an *Error.
func syntaxError(err error) *Error {
	msg := strings.TrimSpace(err.Error())
	if m := yamlLine.FindStringSubmatch(msg); m != nil {
		line, _ := strconv.Atoi(m[1])
		return &Error{Line: line, Msg: m[2]}
	}
	return &Error{Msg: strings.TrimPrefix(msg, "yaml: ")}
}

// Document is a parsed config file.
type Document struct {
	root *yaml.Node // mapping node (nil for an empty file)
}

// Parse parses data and checks the version. An empty file is a valid
// document with no sections.
func Parse(data []byte) (*Document, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return nil, syntaxError(err)
	}
	d := &Document{}
	if doc.Kind == 0 || len(doc.Content) == 0 {
		return d, nil
	}
	root := doc.Content[0]
	if root.Kind == yaml.ScalarNode && root.Tag == "!!null" {
		return d, nil
	}
	if root.Kind != yaml.MappingNode {
		return nil, At(root, "the file must be a mapping (version: 1, then one section per service)")
	}
	d.root = root
	if v := lookup(root, "version"); v != nil && !isNull(v) {
		var n int
		if err := v.Decode(&n); err != nil || n != Version {
			return nil, At(v, "version must be %d", Version)
		}
	}
	return d, nil
}

// Section returns the named top-level section, or nil when it is absent
// (a nil *Section reports every key as absent).
func (d *Document) Section(name string) (*Section, error) {
	if d == nil || d.root == nil {
		return nil, nil
	}
	return section(d.root, name, name)
}

func section(parent *yaml.Node, key, path string) (*Section, error) {
	n := lookup(parent, key)
	if n == nil || isNull(n) {
		return nil, nil
	}
	if n.Kind != yaml.MappingNode {
		return nil, At(n, "%s must be a mapping", path)
	}
	return &Section{path: path, node: n}, nil
}

// lookup returns the value node of key in mapping m.
func lookup(m *yaml.Node, key string) *yaml.Node {
	if m == nil || m.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return resolve(m.Content[i+1])
		}
	}
	return nil
}

func resolve(n *yaml.Node) *yaml.Node {
	for n != nil && n.Kind == yaml.AliasNode {
		n = n.Alias
	}
	return n
}

func isNull(n *yaml.Node) bool { return n.Kind == yaml.ScalarNode && n.Tag == "!!null" }

// Section is one mapping of the file (e.g. auth, or auth.smtp).
type Section struct {
	path string
	node *yaml.Node
}

// Path is the section's dotted path ("auth.smtp").
func (s *Section) Path() string {
	if s == nil {
		return ""
	}
	return s.path
}

// Node returns key's value node (nil when absent or null).
func (s *Section) Node(key string) *yaml.Node {
	if s == nil {
		return nil
	}
	n := lookup(s.node, key)
	if n == nil || isNull(n) {
		return nil
	}
	return n
}

// Has reports whether key is set (present and not null).
func (s *Section) Has(key string) bool { return s.Node(key) != nil }

// Errorf returns an Error positioned at key's value (or the section).
func (s *Section) Errorf(key, format string, args ...any) error {
	n := s.Node(key)
	if n == nil && s != nil {
		n = s.node
	}
	return At(n, "%s.%s: %s", s.Path(), key, fmt.Sprintf(format, args...))
}

func scalar(s *Section, key, kind string) (*yaml.Node, error) {
	n := s.Node(key)
	if n == nil {
		return nil, nil
	}
	if n.Kind != yaml.ScalarNode {
		return nil, s.Errorf(key, "must be %s", kind)
	}
	return n, nil
}

// String returns key's value; nil when absent.
func (s *Section) String(key string) (*string, error) {
	n, err := scalar(s, key, "a string")
	if n == nil || err != nil {
		return nil, err
	}
	v := n.Value
	return &v, nil
}

// Bool returns key's value; nil when absent.
func (s *Section) Bool(key string) (*bool, error) {
	n, err := scalar(s, key, "true or false")
	if n == nil || err != nil {
		return nil, err
	}
	var v bool
	if n.Tag != "!!bool" || n.Decode(&v) != nil {
		return nil, s.Errorf(key, "must be true or false, got %q", n.Value)
	}
	return &v, nil
}

// Int returns key's value; nil when absent.
func (s *Section) Int(key string) (*int, error) {
	n, err := scalar(s, key, "an integer")
	if n == nil || err != nil {
		return nil, err
	}
	var v int
	if n.Tag != "!!int" || n.Decode(&v) != nil {
		return nil, s.Errorf(key, "must be an integer, got %q", n.Value)
	}
	return &v, nil
}

// Duration returns key's value, a Go duration ("10m", "1h30m"); nil when absent.
func (s *Section) Duration(key string) (*time.Duration, error) {
	n, err := scalar(s, key, "a duration such as 10m or 1h")
	if n == nil || err != nil {
		return nil, err
	}
	d, perr := time.ParseDuration(strings.TrimSpace(n.Value))
	if perr != nil {
		return nil, s.Errorf(key, "must be a duration such as 10m or 1h, got %q", n.Value)
	}
	return &d, nil
}

// Strings returns key's list of strings; set is false when absent. A
// single string is accepted as a one-element list.
func (s *Section) Strings(key string) (list []string, set bool, err error) {
	n := s.Node(key)
	if n == nil {
		return nil, false, nil
	}
	if n.Kind == yaml.ScalarNode {
		return []string{n.Value}, true, nil
	}
	if n.Kind != yaml.SequenceNode {
		return nil, false, s.Errorf(key, "must be a list of strings")
	}
	list = []string{}
	for _, item := range n.Content {
		item = resolve(item)
		if item.Kind != yaml.ScalarNode || isNull(item) {
			return nil, false, At(item, "%s.%s: every item must be a string", s.path, key)
		}
		list = append(list, item.Value)
	}
	return list, true, nil
}

// ItemNode returns the node of item i of list key (for positioned errors).
func (s *Section) ItemNode(key string, i int) *yaml.Node {
	n := s.Node(key)
	if n == nil || n.Kind != yaml.SequenceNode || i < 0 || i >= len(n.Content) {
		return n
	}
	return n.Content[i]
}

// Sub returns a nested mapping (nil when absent).
func (s *Section) Sub(key string) (*Section, error) {
	if s == nil {
		return nil, nil
	}
	return section(s.node, key, s.path+"."+key)
}

// Unknown lists the section's keys that are not in known (typos; callers
// usually log them and carry on).
func (s *Section) Unknown(known ...string) []string {
	if s == nil {
		return nil
	}
	var out []string
	for i := 0; i+1 < len(s.node.Content); i += 2 {
		if k := s.node.Content[i].Value; !slices.Contains(known, k) {
			out = append(out, s.path+"."+k)
		}
	}
	return out
}

// AsError returns err as *Error when it is one.
func AsError(err error) (*Error, bool) {
	var e *Error
	ok := errors.As(err, &e)
	return e, ok
}

// Float returns key's value (an integer or a decimal number); nil when absent.
func (s *Section) Float(key string) (*float64, error) {
	n, err := scalar(s, key, "a number")
	if n == nil || err != nil {
		return nil, err
	}
	var v float64
	if (n.Tag != "!!int" && n.Tag != "!!float") || n.Decode(&v) != nil {
		return nil, s.Errorf(key, "must be a number, got %q", n.Value)
	}
	return &v, nil
}

// Keys lists the section's keys in file order.
func (s *Section) Keys() []string {
	if s == nil {
		return nil
	}
	out := make([]string, 0, len(s.node.Content)/2)
	for i := 0; i+1 < len(s.node.Content); i += 2 {
		out = append(out, s.node.Content[i].Value)
	}
	return out
}

// KeyNode returns the node of key itself (not its value), for errors about
// the key (nil when absent).
func (s *Section) KeyNode(key string) *yaml.Node {
	if s == nil {
		return nil
	}
	for i := 0; i+1 < len(s.node.Content); i += 2 {
		if s.node.Content[i].Value == key {
			return s.node.Content[i]
		}
	}
	return nil
}
