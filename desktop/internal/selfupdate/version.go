package selfupdate

import (
	"strconv"
	"strings"
)

// ParseVersion reads x.y.z (an optional leading "v"; any -pre/+build suffix
// is ignored).
func ParseVersion(v string) ([3]int, bool) {
	var out [3]int
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

// Compare: -1, 0 or 1 as a is older than, the same as or newer than b. ok is
// false when either doesn't parse.
func Compare(a, b string) (cmp int, ok bool) {
	pa, oka := ParseVersion(a)
	pb, okb := ParseVersion(b)
	if !oka || !okb {
		return 0, false
	}
	for i := range pa {
		switch {
		case pa[i] > pb[i]:
			return 1, true
		case pa[i] < pb[i]:
			return -1, true
		}
	}
	return 0, true
}

// Newer: whether a is newer than b. Unparseable → false.
func Newer(a, b string) bool {
	c, ok := Compare(a, b)
	return ok && c > 0
}
