package service

import (
	"io"
	"time"
)

type progressReader struct {
	src      io.Reader
	total    int64
	read     int64
	last     time.Time
	interval time.Duration
	report   func(int64, int64)
}

type progressWriter struct {
	dst      io.Writer
	total    int64
	written  int64
	last     time.Time
	interval time.Duration
	report   func(int64, int64)
}

func (r *progressReader) Read(p []byte) (int, error) {
	n, err := r.src.Read(p)
	if n > 0 {
		r.read += int64(n)

		now := time.Now()
		if r.last.IsZero() || now.Sub(r.last) >= r.interval || err != nil {
			r.last = now
			r.report(r.read, r.total)
		}
	}
	return n, err
}

func (w *progressWriter) Write(p []byte) (int, error) {
	n, err := w.dst.Write(p)
	if n > 0 {
		w.written += int64(n)

		now := time.Now()
		if w.last.IsZero() || now.Sub(w.last) >= w.interval {
			w.last = now
			w.report(w.written, w.total)
		}
	}
	return n, err
}
