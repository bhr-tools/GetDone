// Package files stores the files attached to an app's rows (tasks, items)
// and serves them: streamed uploads written atomically, content types
// sniffed rather than trusted, sandboxed downloads, and signed links that
// work without the session cookie (an iOS home screen app does not share it
// with the viewer it opens files in).
//
// The rows describing the files (owner, name, label, deletion for undo) stay
// in the app's own table; this package only knows file ids.
package files

import (
	"bufio"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/bhr-tools/kit/httpx"
)

const (
	// TransferTimeout bounds an upload or a download (a photo over a slow
	// phone link).
	TransferTimeout = 10 * time.Minute
	// LinkLifetime is the shortest validity of a signed link.
	LinkLifetime = 7 * 24 * time.Hour
)

// Store keeps files under dir, each named by its id.
type Store struct {
	dir     string
	maxSize int64
	secret  func() ([]byte, error)
}

// New returns a store of files of at most maxSize bytes in dir, signing
// links with the key secret returns (auth.LinkSecret).
func New(dir string, maxSize int64, secret func() ([]byte, error)) *Store {
	return &Store{dir: dir, maxSize: maxSize, secret: secret}
}

// MaxSize is the largest file accepted.
func (s *Store) MaxSize() int64 { return s.maxSize }

// Path of the file id.
func (s *Store) Path(id string) string { return filepath.Join(s.dir, filepath.Base(id)) }

// Save streams content to a temporary file, syncs it, then renames it to
// id, so a failed upload leaves nothing behind. Empty files and files above
// MaxSize are refused with a ValidationError. Returns the size.
func (s *Store) Save(id string, content io.Reader) (int64, error) {
	if err := os.MkdirAll(s.dir, 0o750); err != nil {
		return 0, fmt.Errorf("create files directory: %w", err)
	}
	tmp, err := os.CreateTemp(s.dir, ".upload-*")
	if err != nil {
		return 0, err
	}
	defer os.Remove(tmp.Name()) // a no-op once renamed
	size, err := io.Copy(tmp, io.LimitReader(content, s.maxSize+1))
	if err == nil && size > s.maxSize {
		err = httpx.Invalid("Files are at most %d MB", s.maxSize>>20)
	}
	if err == nil && size == 0 {
		err = httpx.Invalid("The file is empty")
	}
	if err == nil {
		err = tmp.Sync()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return 0, err
	}
	return size, os.Rename(tmp.Name(), s.Path(id))
}

// Open opens the file id; a missing file is httpx.ErrNotFound.
func (s *Store) Open(id string) (*os.File, error) {
	f, err := os.Open(s.Path(id))
	if errors.Is(err, os.ErrNotExist) {
		return nil, httpx.ErrNotFound
	}
	return f, err
}

// Remove deletes the file id (a missing file is not an error).
func (s *Store) Remove(id string) error {
	if err := os.Remove(s.Path(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// CleanLeftovers removes uploads interrupted more than an hour ago.
func (s *Store) CleanLeftovers() {
	leftovers, _ := filepath.Glob(filepath.Join(s.dir, ".upload-*"))
	for _, f := range leftovers {
		if info, err := os.Stat(f); err == nil && info.ModTime().Before(time.Now().Add(-time.Hour)) {
			os.Remove(f)
		}
	}
}

// ---------------------------------------------------------------------------
// Types and names
// ---------------------------------------------------------------------------

// Types shown in the browser. Anything else is stored as
// application/octet-stream and always downloaded.
var inlineTypes = map[string]bool{
	"application/pdf": true,
	"image/png":       true,
	"image/jpeg":      true,
	"image/gif":       true,
	"image/webp":      true,
	"image/heic":      true,
	"image/heif":      true,
	"text/plain":      true,
}

// Inline reports whether a type is shown in the browser rather than
// downloaded.
func Inline(contentType string) bool { return inlineTypes[contentType] }

// ContentType decides the stored type from the content itself (and the
// extension for HEIC, which the standard sniffer does not know); the type
// the browser declared is not trusted.
func ContentType(head []byte, filename string) string {
	sniffed, _, _ := strings.Cut(http.DetectContentType(head), ";")
	switch ext := strings.ToLower(filepath.Ext(filename)); {
	case inlineTypes[sniffed] && sniffed != "text/plain":
		return sniffed
	case sniffed == "text/plain" && (ext == ".txt" || ext == ".md" || ext == ".csv" || ext == ""):
		return "text/plain"
	case ext == ".heic" || ext == ".heif":
		return "image/" + ext[1:]
	}
	return "application/octet-stream"
}

// CleanFilename keeps the base name of an uploaded file, without control
// characters, at most 200 characters.
func CleanFilename(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, `\`, "/"))
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, strings.TrimSpace(name))
	if name == "" || name == "." || name == "/" {
		name = "file"
	}
	if r := []rune(name); len(r) > 200 {
		name = string(r[:200])
	}
	return name
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

// Upload is one file of a multipart upload: a clean name, the sniffed type
// and the content to stream.
type Upload struct {
	Filename    string
	ContentType string
	Body        io.Reader
}

// ReadUploads walks the "file" parts of a multipart/form-data request, one
// at a time, calling each. It answers the request itself when the upload is
// malformed or too large (maxFiles files of MaxSize at most) and then
// returns false; an error from each is answered with httpx.Fail.
func (s *Store) ReadUploads(w http.ResponseWriter, r *http.Request, maxFiles int, each func(Upload) error) bool {
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Now().Add(TransferTimeout))
	_ = rc.SetWriteDeadline(time.Now().Add(TransferTimeout))
	r.Body = http.MaxBytesReader(w, r.Body, int64(maxFiles)*s.maxSize)
	reader, err := r.MultipartReader()
	if err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "Expected a multipart upload")
		return false
	}
	count := 0
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				httpx.WriteError(w, http.StatusRequestEntityTooLarge, "Upload too large")
			} else {
				httpx.WriteError(w, http.StatusBadRequest, "Invalid upload")
			}
			return false
		}
		if part.FormName() == "file" {
			name := part.FileName()
			buf := bufio.NewReaderSize(part, 512)
			head, _ := buf.Peek(512)
			if err := each(Upload{Filename: CleanFilename(name), ContentType: ContentType(head, name), Body: buf}); err != nil {
				part.Close()
				httpx.Fail(w, r, err)
				return false
			}
			count++
		}
		part.Close()
	}
	if count == 0 {
		httpx.WriteError(w, http.StatusBadRequest, "No file uploaded")
		return false
	}
	return true
}

// Serve sends the file id. Files run in a sandbox: an uploaded HTML or SVG
// page cannot script the app.
func (s *Store) Serve(w http.ResponseWriter, r *http.Request, id, filename, contentType string, modified time.Time) {
	f, err := s.Open(id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer f.Close()
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(TransferTimeout))
	disposition := "attachment"
	if Inline(contentType) {
		disposition = "inline"
	}
	h := w.Header()
	h.Set("Content-Type", contentType)
	h.Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": filename}))
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "private, max-age=86400")
	http.ServeContent(w, r, "", modified, f)
}

// Link returns path (the route serving id) signed for at least
// LinkLifetime. The expiry is rounded to the day, so a link stays the same,
// and cacheable, all day.
func (s *Store) Link(path, id string) string {
	secret, err := s.secret()
	if err != nil {
		return path // still works for a signed-in browser
	}
	exp := time.Now().Add(LinkLifetime).Truncate(24 * time.Hour).Add(24 * time.Hour).Unix()
	e := strconv.FormatInt(exp, 10)
	return fmt.Sprintf("%s?exp=%s&sig=%s", path, e, sign(secret, id, e))
}

// LinkPath is the usual route of a file: prefix + escaped id.
func LinkPath(prefix, id string) string { return prefix + url.PathEscape(id) }

// ValidLink reports whether r carries a valid, unexpired signature for id.
func (s *Store) ValidLink(r *http.Request, id string) bool {
	exp, sig := r.URL.Query().Get("exp"), r.URL.Query().Get("sig")
	e, err := strconv.ParseInt(exp, 10, 64)
	if err != nil || time.Now().Unix() > e {
		return false
	}
	secret, err := s.secret()
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(sign(secret, id, exp)), []byte(sig)) == 1
}

func sign(secret []byte, id, exp string) string {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte(id + "|" + exp))
	return hex.EncodeToString(m.Sum(nil))
}
