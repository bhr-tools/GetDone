// Package offline is the server side of offline mode (web/js/sync/engine.js):
// GET /api/sync returns all the data with an ETag; POST /api/sync applies
// the changes made offline, in order, then returns the new data. Each change
// has a client-chosen UUID, recorded once applied, so a batch sent twice
// (lost answer, retry) is applied once.
//
// The app gives what is its own: the snapshot of its data and how to apply
// one change (a switch on op.Type).
package offline

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/bhr-tools/kit/httpx"
	"github.com/google/uuid"
)

// MaxOps is the largest batch accepted.
const MaxOps = 500

// opsKept is how long applied changes are remembered.
const opsKept = 30 * 24 * time.Hour

const schema = `
CREATE TABLE IF NOT EXISTS sync_ops (
	id TEXT PRIMARY KEY,
	status TEXT NOT NULL,
	error TEXT NOT NULL DEFAULT '',
	applied_at DATETIME NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_ops_applied ON sync_ops(applied_at);`

// Op is one change made by a client.
type Op struct {
	ID   string          `json:"id"`
	Type string          `json:"type"`
	Args json.RawMessage `json:"args"`
}

// Decode reads the arguments of a change; malformed ones make it invalid.
func (op Op) Decode(dst any) error {
	if err := json.Unmarshal(op.Args, dst); err != nil {
		return &httpx.ValidationError{Msg: "Invalid arguments: " + err.Error()}
	}
	return nil
}

type result struct {
	ID     string `json:"id"`
	Status string `json:"status"` // ok | not_found | invalid
	Error  string `json:"error,omitempty"`
}

type response struct {
	Results  []result        `json:"results,omitempty"`
	ETag     string          `json:"etag"`
	Snapshot json.RawMessage `json:"snapshot"`
}

// Sync serves /api/sync.
type Sync struct {
	db       *sql.DB
	snapshot func() (any, error)
	apply    func(Op) error
}

// New creates the sync_ops table if needed (the schema GetDone and Meals
// already have). snapshot returns all the data, read consistently; apply
// runs one change and returns httpx.ErrNotFound, a ValidationError, or an
// internal error (which fails the batch: the client sends it again).
func New(db *sql.DB, snapshot func() (any, error), apply func(Op) error) (*Sync, error) {
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("sync table: %w", err)
	}
	return &Sync{db: db, snapshot: snapshot, apply: apply}, nil
}

// Routes registers GET and POST /api/sync on mux, wrapped by guard
// (auth.Require).
func (s *Sync) Routes(mux *http.ServeMux, guard func(http.Handler) http.Handler) {
	mux.Handle("GET /api/sync", guard(http.HandlerFunc(s.get)))
	mux.Handle("POST /api/sync", guard(http.HandlerFunc(s.post)))
}

// encoded returns the snapshot as JSON and its ETag.
func (s *Sync) encoded() (json.RawMessage, string, error) {
	snap, err := s.snapshot()
	if err != nil {
		return nil, "", err
	}
	body, err := json.Marshal(snap)
	if err != nil {
		return nil, "", err
	}
	sum := sha256.Sum256(body)
	return body, `"` + hex.EncodeToString(sum[:16]) + `"`, nil
}

func (s *Sync) get(w http.ResponseWriter, r *http.Request) {
	body, etag, err := s.encoded()
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	w.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusNotModified)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, response{ETag: etag, Snapshot: body})
}

func (s *Sync) post(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Ops []Op `json:"ops"`
	}
	if !httpx.Decode(w, r, &req) {
		return
	}
	if len(req.Ops) > MaxOps {
		httpx.WriteError(w, http.StatusBadRequest, fmt.Sprintf("Too many changes at once (max %d)", MaxOps))
		return
	}
	results := make([]result, 0, len(req.Ops))
	for _, op := range req.Ops {
		res, err := s.applyOnce(op)
		if err != nil {
			httpx.Fail(w, r, err) // the client sends the batch again; applied changes are skipped
			return
		}
		results = append(results, res)
	}
	if _, err := s.db.Exec(`DELETE FROM sync_ops WHERE applied_at < ?`, time.Now().UTC().Add(-opsKept)); err != nil {
		log.Printf("prune sync ops: %v", err)
	}
	body, etag, err := s.encoded()
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	w.Header().Set("ETag", etag)
	httpx.WriteJSON(w, http.StatusOK, response{Results: results, ETag: etag, Snapshot: body})
}

// applyOnce applies one change once. Only internal errors are returned.
func (s *Sync) applyOnce(op Op) (result, error) {
	res := result{ID: op.ID, Status: "ok"}
	if _, err := uuid.Parse(op.ID); err != nil {
		res.Status, res.Error = "invalid", "Invalid operation id"
		return res, nil
	}
	err := s.db.QueryRow(`SELECT status, error FROM sync_ops WHERE id = ?`, op.ID).Scan(&res.Status, &res.Error)
	if err == nil {
		return res, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return res, err
	}
	res.Status, res.Error = "ok", ""
	var invalid *httpx.ValidationError
	switch err := s.apply(op); {
	case err == nil:
	case errors.Is(err, httpx.ErrNotFound):
		res.Status = "not_found"
	case errors.As(err, &invalid):
		res.Status, res.Error = "invalid", invalid.Msg
	default:
		return res, err
	}
	_, err = s.db.Exec(`INSERT OR IGNORE INTO sync_ops (id, status, error, applied_at) VALUES (?, ?, ?, ?)`,
		op.ID, res.Status, res.Error, time.Now().UTC())
	return res, err
}
