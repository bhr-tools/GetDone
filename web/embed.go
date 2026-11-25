// Package web embeds the browser application. The kit serves /sw.js and its
// own files under /kit/.
package web

import "embed"

// Files holds the static assets served at the site root.
//
//go:embed index.html manifest.json css js icons
var Files embed.FS
