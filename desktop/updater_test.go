package main

import "testing"

func TestNewerVersion(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"0.37.0", "0.36.4", true},
		{"v1.0.0", "0.99.99", true},
		{"0.36.4", "0.36.4", false},
		{"0.36.3", "0.36.4", false},
		{"0.36.10", "0.36.9", true},
		{"0.37.0-beta.1", "0.36.4", true},
		{"garbage", "0.36.4", false},
		{"0.37.0", "dev", false},
	}
	for _, c := range cases {
		if got := newerVersion(c.a, c.b); got != c.want {
			t.Errorf("newerVersion(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}
