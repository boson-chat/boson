package selfupdate

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// maxBinary caps an extracted executable (the real ones are ~40 MB).
const maxBinary = 512 << 20

var errNoEntry = errors.New("selfupdate: the archive doesn't hold the app")

// ExtractFile copies one file, entry ("Boson/Boson.exe"), out of a verified
// release archive (a .zip, or a .tar.gz otherwise) to dst, mode 0755. Only
// that entry is read, so a stray path in the archive can't write elsewhere.
func ExtractFile(archive, entry, dst string) error {
	if strings.HasSuffix(archive, ".zip") {
		return extractZip(archive, entry, dst)
	}
	return extractTarGz(archive, entry, dst)
}

func extractZip(archive, entry, dst string) error {
	zr, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer zr.Close()
	for _, f := range zr.File {
		// Compress-Archive (Windows) writes backslashes.
		if strings.ReplaceAll(f.Name, `\`, "/") != entry || f.FileInfo().IsDir() {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		defer rc.Close()
		return writeExecutable(rc, dst)
	}
	return errNoEntry
}

func extractTarGz(archive, entry, dst string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return errNoEntry
		}
		if err != nil {
			return err
		}
		if strings.TrimPrefix(h.Name, "./") == entry && h.Typeflag == tar.TypeReg {
			return writeExecutable(tr, dst)
		}
	}
}

func writeExecutable(r io.Reader, dst string) error {
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	n, err := io.Copy(out, io.LimitReader(r, maxBinary+1))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil && (n == 0 || n > maxBinary) {
		err = fmt.Errorf("selfupdate: extracted app is %d bytes", n)
	}
	if err != nil {
		os.Remove(dst)
		return err
	}
	// The umask may have taken the execute bits.
	return os.Chmod(dst, 0o755)
}
