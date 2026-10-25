package db

import (
	"database/sql"
	"slices"
)

// Items in a group of siblings (projects under one parent, sections of a
// project, tasks under one parent) are ordered by position. Every insertion or
// move renumbers the destination group 1..n, so positions never collide.

// place inserts id among siblings (which must not contain id) according to p.
func place(siblings []string, id string, p Placement) ([]string, error) {
	anchor, after := p.BeforeID, false
	if anchor == "" {
		anchor, after = p.AfterID, true
	}
	if anchor == "" {
		return append(slices.Clone(siblings), id), nil
	}
	idx := slices.Index(siblings, anchor)
	if idx < 0 {
		return nil, invalid("the reference item is not in the destination list")
	}
	if after {
		idx++
	}
	return slices.Insert(slices.Clone(siblings), idx, id), nil
}

// renumber writes positions 1..n following the order of ids.
func renumber(q querier, table string, ids []string) error {
	stmt := `UPDATE ` + table + ` SET position = ? WHERE id = ?`
	for i, id := range ids {
		if _, err := q.Exec(stmt, i+1, id); err != nil {
			return err
		}
	}
	return nil
}

// queryIDs runs a query returning a single id column.
func queryIDs(q querier, query string, args ...any) ([]string, error) {
	rows, err := q.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// exists reports whether query returns at least one row.
func exists(q querier, query string, args ...any) (bool, error) {
	var one int
	err := q.QueryRow(query, args...).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}
